import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import http from "http";
import { exportToExcel } from "./export-excel.js";
import { syncToSheets } from "./sync-sheets.js";

// Health check endpoint so Railway can monitor and auto-restart if unresponsive
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

function checkOnboarding() {
  if (CONFIG.paperTrading) return; // Binance keys not needed in paper mode
  const missing = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"].filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.log(`⚠️  Missing env vars: ${missing.join(", ")} — set them in Railway Variables.`);
    process.exit(1);
  }
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols:              (process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT").split(",").map(s => s.trim()),
  strategyMode:         process.env.STRATEGY_MODE || "auto",
  portfolioValue:       parseFloat(process.env.PORTFOLIO_VALUE_USD || "10000"),
  maxTradeSizeUSD:      parseFloat(process.env.MAX_TRADE_SIZE_USD || "12"),
  maxTradesPerDay:      parseInt(process.env.MAX_TRADES_PER_DAY || "200"),
  maxTradesPerSymbol:   parseInt(process.env.MAX_TRADES_PER_SYMBOL || "999"),
  dailyLossLimitPct:    parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "3"),
  paperTrading:         process.env.PAPER_TRADING !== "false",
  binance: {
    apiKey:    process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl:   "https://api.binance.com",
  },
};

// Strategy parameter presets
const STRATEGY_PARAMS = {
  scalp: {
    timeframe:   "5m",
    emaFast:     8,
    emaSlow:     13,
    rsiPeriod:   7,
    rsiBullMin:  40, rsiBullMax: 80,
    rsiBearMin:  20, rsiBearMax: 60,
    slAtrMult:   1.0,
    tpAtrMult:   2.0,
    label:       "Scalp 5m — EMA(8/13) RSI(7)",
  },
  intraday: {
    timeframe:   "15m",
    emaFast:     9,
    emaSlow:     21,
    rsiPeriod:   14,
    rsiBullMin:  38, rsiBullMax: 78,
    rsiBearMin:  22, rsiBearMax: 62,
    slAtrMult:   1.5,
    tpAtrMult:   4.5,
    label:       "Intraday 15m — EMA(9/21) RSI(14)",
  },
};

const LOG_FILE       = process.env.SAFETY_LOG_PATH    || "safety-check-log.json";
const POSITIONS_FILE = process.env.POSITIONS_FILE_PATH || "open-positions.json";
const WATCHLIST_FILE = process.env.WATCHLIST_FILE_PATH || "watchlist.json";

// ─── Weekly Pair Scanner ──────────────────────────────────────────────────────

const EXCLUDE_BASES = new Set([
  // Stablecoins
  "USDC","BUSD","FDUSD","TUSD","DAI","USDP","GUSD","FRAX",
  // Commodities (not crypto)
  "XAU","XAUT","XAG","PAXG",
]);

async function fetchTopPairs(maxPairs = 15) {
  const url = "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
  const res  = await fetch(url);
  const json = await res.json();
  if (!json.data?.length) throw new Error("BitGet tickers returned no data");

  return json.data
    .filter(t => {
      const base   = t.symbol.replace(/USDT$/, "");
      const vol24h = parseFloat(t.usdtVolume || 0);
      const price  = parseFloat(t.lastPr || 0);
      return (
        !EXCLUDE_BASES.has(base) &&
        vol24h  > 50_000_000 &&  // $50M+ 24h volume — filters low-cap noise
        price   > 0.0001          // exclude near-zero price tokens
      );
    })
    .sort((a, b) => parseFloat(b.usdtVolume) - parseFloat(a.usdtVolume))
    .slice(0, maxPairs)
    .map(t => t.symbol);
}

function isWatchlistStale() {
  if (!existsSync(WATCHLIST_FILE)) return true;
  const wl  = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
  const age = Date.now() - new Date(wl.updatedAt).getTime();
  return age > 7 * 24 * 60 * 60 * 1000; // older than 7 days
}

async function refreshWatchlist() {
  const isSunday = new Date().getUTCDay() === 0;
  if (!isSunday && !isWatchlistStale()) return;

  console.log(`\n🔍 ${isSunday ? "Sunday scan" : "Watchlist stale"} — discovering top pairs from BitGet...`);
  try {
    const pairs = await fetchTopPairs(15);
    writeFileSync(WATCHLIST_FILE, JSON.stringify({ pairs, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`✅ Watchlist updated: ${pairs.join(", ")}\n`);
  } catch (err) {
    console.log(`⚠️  Pair scan failed: ${err.message} — keeping existing symbols.\n`);
  }
}

function getActiveSymbols() {
  if (existsSync(WATCHLIST_FILE)) {
    try {
      const wl = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
      if (wl.pairs?.length) return wl.pairs;
    } catch {}
  }
  return CONFIG.symbols; // fallback to env var
}

// ─── Open Positions Tracking ─────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function addPosition(symbol, side, entryPrice, quantity, orderId, paperTrading, atr, params) {
  // ATR-based TP/SL — adapts to current volatility, not fixed %
  const slDist = atr * params.slAtrMult;
  const tpDist = atr * params.tpAtrMult;
  const sl = side === "buy" ? entryPrice - slDist : entryPrice + slDist;
  const tp = side === "buy" ? entryPrice + tpDist : entryPrice - tpDist;
  const positions = loadPositions();
  positions.push({
    symbol, side, entryPrice, quantity, orderId, sl, tp,
    paperTrading, openedAt: new Date().toISOString(),
    slMoved: false,       // trailing stop: tracks if SL moved to breakeven
    bestPrice: entryPrice // trailing stop: tracks best price seen since entry
  });
  savePositions(positions);
  const rrRatio = (tpDist / slDist).toFixed(1);
  console.log(`  📍 TP: $${tp.toFixed(4)} (+${tpDist.toFixed(4)}) | SL: $${sl.toFixed(4)} (-${slDist.toFixed(4)}) | RR: ${rrRatio}:1 | ATR: ${atr.toFixed(4)}`);
}

function checkAndClosePositions(symbol, currentPrice) {
  const positions = loadPositions();
  const remaining = [];
  const closed = [];

  for (const pos of positions) {
    if (pos.symbol !== symbol) { remaining.push(pos); continue; }
    const isLong = pos.side === "buy";

    // Trailing stop: track best price and move SL to breakeven at 50% of TP distance
    const tpDist = Math.abs(pos.tp - pos.entryPrice);
    const progress = isLong
      ? currentPrice - pos.entryPrice
      : pos.entryPrice - currentPrice;

    if (!pos.slMoved && progress >= tpDist * 0.5) {
      pos.sl = pos.entryPrice; // move SL to breakeven
      pos.slMoved = true;
      console.log(`  🔒 Trailing stop moved to breakeven for ${pos.symbol} @ $${pos.entryPrice.toFixed(4)}`);
    }

    // Update best price seen
    if (isLong && currentPrice > (pos.bestPrice || pos.entryPrice)) pos.bestPrice = currentPrice;
    if (!isLong && currentPrice < (pos.bestPrice || pos.entryPrice)) pos.bestPrice = currentPrice;

    const hitSL = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    const hitTP = isLong ? currentPrice >= pos.tp : currentPrice <= pos.tp;

    if (hitTP || hitSL) {
      const exitPrice = hitTP ? pos.tp : pos.sl;
      const pnlUSD = isLong
        ? (exitPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - exitPrice) * pos.quantity;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * (isLong ? 100 : -100);
      const result = hitTP ? "WIN" : (pos.slMoved ? "BREAKEVEN" : "LOSS");
      closed.push({ ...pos, exitPrice, exitTime: new Date().toISOString(), pnlUSD, pnlPct, result });
    } else {
      remaining.push(pos);
    }
  }

  savePositions(remaining);
  return closed;
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function countTodaysSymbolTrades(log, symbol) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced && t.symbol === symbol).length;
}

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Binance.com geo-blocked on Railway US servers — BitGet used for all candle data
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  const granularity = intervalMap[interval] || "5m";
  const cleanSymbol = symbol.replace("USDT", "") + "USDT";
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${cleanSymbol}&granularity=${granularity}&limit=${limit}&productType=USDT-FUTURES`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet API error: ${res.status}`);
  const json = await res.json();
  if (!json.data || !json.data.length) throw new Error(`BitGet returned no candle data for ${symbol}`);
  return json.data.map((k) => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── 15m Trend Bias — cached per symbol, refreshed every 15 min ──────────────

const biasCache = {};

async function getTrendBias(symbol) {
  const now = Date.now();
  if (biasCache[symbol]?.expiresAt > now) return biasCache[symbol].bias;
  try {
    const candles = await fetchCandles(symbol, "15m", 60);
    const closes  = candles.map(c => c.close);
    const ema50   = calcEMA(closes, 50);
    const price   = closes[closes.length - 1];
    const bias    = price > ema50 ? "bullish" : "bearish";
    biasCache[symbol] = { bias, expiresAt: now + 15 * 60 * 1000 };
    console.log(`  15m EMA(50): ${ema50.toFixed(4)} → bias: ${bias.toUpperCase()} (cached 15m)`);
    return bias;
  } catch {
    return biasCache[symbol]?.bias ?? null;
  }
}

// ─── Confidence → trade size ──────────────────────────────────────────────────

function calcTradeSize(score, maxSize) {
  if (score >= 2) return maxSize * 1.5;  // STRONG
  if (score === 1) return maxSize;         // FULL
  return maxSize * 0.5;                    // HALF
}

function confidenceLabel(score) {
  if (score >= 2) return "STRONG";
  if (score === 1) return "FULL";
  return "HALF";
}

// ─── Safety Check ───────────────────────────────────────────────────────────

// Tiered system: critical conditions ALL must pass, bonus conditions score confidence
//   STRONG (2+ bonus) → 1.5× size  |  FULL (1 bonus) → 1×  |  HALF (0 bonus) → 0.5×
function runSafetyCheck(price, emaFast, emaSlow, vwap, rsi14, params, trendBias) {
  const critical = [], scored = [];
  const crit  = (label, pass) => { critical.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} [C] ${label}`); };
  const bonus = (label, pass) => { scored.push({ label, pass });   console.log(`  ${pass ? "✅" : "⚪"} [B] ${label}`); };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishEMA = emaFast > emaSlow;

  // Critical — EMA must have a direction (not perfectly flat)
  crit("EMA direction established", emaFast !== emaSlow);

  const criticalPass = critical.every(r => r.pass);
  if (!criticalPass) {
    console.log(`  Bias: FLAT — EMAs equal. No trade.\n`);
    return { results: [...critical, ...scored], criticalPass: false, score: 0, bias: "neutral" };
  }

  const bias   = bullishEMA ? "bullish" : "bearish";
  const goLong = bias === "bullish";
  console.log(`  Bias: ${bias.toUpperCase()}\n`);

  // Bonus — each passing adds +1 to confidence score
  if (goLong) {
    bonus(`RSI(14) bullish zone (${params.rsiBullMin}–${params.rsiBullMax})`,
      rsi14 !== null && rsi14 >= params.rsiBullMin && rsi14 <= params.rsiBullMax);
  } else {
    bonus(`RSI(14) bearish zone (${params.rsiBearMin}–${params.rsiBearMax})`,
      rsi14 !== null && rsi14 >= params.rsiBearMin && rsi14 <= params.rsiBearMax);
  }

  if (trendBias) {
    bonus(`15m bias ${trendBias.toUpperCase()} aligns with trade direction`,
      (trendBias === "bullish" && goLong) || (trendBias === "bearish" && !goLong));
  }

  if (vwap) {
    const vwapAligned = goLong ? price > vwap : price < vwap;
    bonus(`VWAP direction aligned (${goLong ? "price > VWAP" : "price < VWAP"})`, vwapAligned);
  }

  const score = scored.filter(r => r.pass).length;
  return { results: [...critical, ...scored], criticalPass: true, score, bias };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function getDailyPnL() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1);
  return lines
    .filter(l => l.startsWith(today))
    .reduce((sum, l) => {
      const cols = l.split(",");
      const pnl = parseFloat(cols[15] || "0");
      return sum + (isNaN(pnl) ? 0 : pnl);
    }, 0);
}

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  // Daily loss circuit breaker
  const dailyPnL    = getDailyPnL();
  const lossLimit   = -(CONFIG.portfolioValue * CONFIG.dailyLossLimitPct / 100);
  if (dailyPnL <= lossLimit) {
    console.log(`🛑 DAILY LOSS LIMIT HIT — P&L today: $${dailyPnL.toFixed(2)} | Limit: $${lossLimit.toFixed(2)}. No more trades today.`);
    return false;
  }
  console.log(`✅ Daily P&L: $${dailyPnL.toFixed(2)} | Loss limit: $${lossLimit.toFixed(2)}`);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.02, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);

  return true;
}

// ─── Binance Execution ───────────────────────────────────────────────────────

function signBinance(queryString) {
  return crypto
    .createHmac("sha256", CONFIG.binance.secretKey)
    .update(queryString)
    .digest("hex");
}

async function placeBinanceOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now();
  const params = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
  const signature = signBinance(params);
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${params}&signature=${signature}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": CONFIG.binance.apiKey,
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance order failed: ${data.msg}`);
  }

  return { orderId: data.orderId };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = process.env.TRADE_LOG_PATH || "trades.csv";

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Entry Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Status",
  "Exit Price",
  "Exit Time",
  "P&L USD",
  "P&L %",
  "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.criticalPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = logEntry.confidence ? `${logEntry.confidence} signal` : "All conditions met";
  } else {
    side = logEntry.side?.toUpperCase() || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : (logEntry.confidence ? `${logEntry.confidence} signal` : "All conditions met");
  }

  const row = [
    date,
    time,
    "Binance",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price ? logEntry.price.toFixed(4) : "",
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    logEntry.allPass ? "OPEN" : "BLOCKED",
    "", // Exit Price — filled when position closes
    "", // Exit Time
    "", // P&L USD
    "", // P&L %
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
}

function writeCloseCsv(closed) {
  const now = new Date(closed.exitTime);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const openedAt = new Date(closed.openedAt);

  const row = [
    openedAt.toISOString().slice(0, 10),
    openedAt.toISOString().slice(11, 19),
    "Binance",
    closed.symbol,
    closed.side.toUpperCase(),
    closed.quantity.toFixed(6),
    closed.entryPrice.toFixed(4),
    (closed.entryPrice * closed.quantity).toFixed(2),
    (closed.entryPrice * closed.quantity * 0.001).toFixed(4),
    "",
    closed.orderId,
    closed.paperTrading ? "PAPER" : "LIVE",
    closed.result,
    closed.exitPrice.toFixed(4),
    `${date} ${time}`,
    closed.pnlUSD.toFixed(4),
    closed.pnlPct.toFixed(2) + "%",
    `"${closed.result === "WIN" ? "Take profit hit" : "Stop loss hit"}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`  ${closed.result === "WIN" ? "✅ WIN" : "❌ LOSS"} → ${closed.symbol} | P&L: $${closed.pnlUSD.toFixed(4)} (${closed.pnlPct.toFixed(2)}%)`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[12] === "BLOCKED");
  const wins = rows.filter((r) => r[12] === "WIN");
  const losses = rows.filter((r) => r[12] === "LOSS");
  const totalPnL = [...wins, ...losses].reduce((sum, r) => sum + parseFloat(r[15] || 0), 0);
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Winning trades         : ${wins.length}`);
  console.log(`  Losing trades          : ${losses.length}`);
  console.log(`  Win rate               : ${wins.length + losses.length > 0 ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1) + "%" : "N/A"}`);
  console.log(`  Total P&L              : $${totalPnL.toFixed(2)}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-symbol run ──────────────────────────────────────────────────────────

async function runSymbol(symbol, log) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────`);

  const symbolTradesCount = countTodaysSymbolTrades(log, symbol);
  if (symbolTradesCount >= CONFIG.maxTradesPerSymbol) {
    console.log(`  ⏭  Symbol limit reached (${symbolTradesCount}/${CONFIG.maxTradesPerSymbol}) — skipping`);
    return;
  }

  // Resolve strategy mode — auto picks based on ATR% volatility, locked for this symbol
  let params = STRATEGY_PARAMS[CONFIG.strategyMode] || STRATEGY_PARAMS.intraday;

  let candles;
  try {
    candles = await fetchCandles(symbol, params.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Could not fetch data for ${symbol}: ${err.message}`);
    return;
  }

  if (CONFIG.strategyMode === "auto") {
    const atrForMode = calcATR(candles, 14);
    const atrPct     = atrForMode ? (atrForMode / candles[candles.length - 1].close) * 100 : 0;
    if (atrPct >= 0.5) {
      params = STRATEGY_PARAMS.scalp;
      if (params.timeframe !== STRATEGY_PARAMS.intraday.timeframe) {
        try { candles = await fetchCandles(symbol, params.timeframe, 500); } catch {}
      }
      console.log(`  AUTO: high volatility (ATR ${atrPct.toFixed(2)}%) → SCALP`);
    } else {
      params = STRATEGY_PARAMS.intraday;
      console.log(`  AUTO: low volatility (ATR ${atrPct.toFixed(2)}%) → INTRADAY`);
    }
  }
  console.log(`  Strategy: ${params.label}`);

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const atr    = calcATR(candles, 14);
  console.log(`  Price: $${price.toFixed(4)} | ATR(14): ${atr ? "$" + atr.toFixed(4) : "N/A"}`);

  if (!atr) { console.log(`  ⚠️  Not enough data for ATR — skipping.`); return; }

  const closed = checkAndClosePositions(symbol, price);
  for (const c of closed) writeCloseCsv(c);

  const emaFast    = calcEMA(closes, params.emaFast);
  const emaSlow    = calcEMA(closes, params.emaSlow);
  const vwap       = calcVWAP(candles);
  const rsi14      = calcRSI(closes, params.rsiPeriod);
  const trendBias  = await getTrendBias(symbol);

  const emaSep = Math.abs(emaFast - emaSlow) / price * 100;
  console.log(`  EMA(${params.emaFast}): $${emaFast.toFixed(4)} | EMA(${params.emaSlow}): $${emaSlow.toFixed(4)} | Sep: ${emaSep.toFixed(3)}% | VWAP: ${vwap ? "$" + vwap.toFixed(4) : "N/A"} | RSI(${params.rsiPeriod}): ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  if (rsi14 === null) { console.log(`  ⚠️  Not enough candles for RSI — skipping.`); return; }

  const { results, criticalPass, score, bias } = runSafetyCheck(price, emaFast, emaSlow, vwap, rsi14, params, trendBias);
  const side       = bias === "bearish" ? "sell" : "buy";
  const size       = criticalPass ? calcTradeSize(score, CONFIG.maxTradeSizeUSD) : 0;
  const confidence = criticalPass ? confidenceLabel(score) : "BLOCKED";

  const logEntry = {
    timestamp:    new Date().toISOString(),
    symbol, side,
    timeframe:    params.timeframe,
    strategyMode: params.label,
    price,
    indicators:   { emaFast, emaSlow, vwap, rsi14, atr, trendBias },
    conditions:   results,
    criticalPass, score, confidence,
    tradeSize:    size,
    orderPlaced:  false,
    orderId:      null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!criticalPass) {
    console.log(`  🚫 BLOCKED — ${results.filter(r => !r.pass).map(r => r.label).join("; ")}`);
  } else {
    const quantity = size / price;
    console.log(`  ${confidence} — ${side.toUpperCase()} ${symbol} $${size.toFixed(2)} | score: ${score}/3`);

    if (CONFIG.paperTrading) {
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
      addPosition(symbol, side, price, quantity, logEntry.orderId, true, atr, params);
      console.log(`  📋 PAPER order recorded — ${logEntry.orderId}`);
    } else {
      console.log(`  🔴 PLACING LIVE ORDER — $${size.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
      try {
        const order = await placeBinanceOrder(symbol, side, size, price);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        addPosition(symbol, side, price, quantity, order.orderId, false, atr, params);
        console.log(`  ✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  writeTradeCsv(logEntry);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  await refreshWatchlist();
  const symbols = getActiveSymbols();

  const modeLabel = CONFIG.strategyMode === "auto"
    ? "AUTO (scalp on high vol, intraday on low vol)"
    : STRATEGY_PARAMS[CONFIG.strategyMode]?.label || CONFIG.strategyMode;
  console.log(`\nStrategy mode: ${modeLabel}`);
  console.log(`Symbols (${symbols.length}): ${symbols.join(", ")} | Daily loss limit: -${CONFIG.dailyLossLimitPct}%`);

  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot halted — limit reached.");
    return;
  }

  for (const symbol of symbols) {
    if (!checkTradeLimits(log)) {
      console.log(`\n⚠️  Limit hit — stopping.`);
      break;
    }
    await runSymbol(symbol, log);
  }

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log(`Tax record saved → ${CSV_FILE}`);
  await exportToExcel().catch(err => console.log(`  ⚠️  Excel export failed: ${err.message}`));
  await syncToSheets().catch(err => console.log(`  ⚠️  Sheets sync failed: ${err.message}`));
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  const RUN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  async function loop() {
    await run().catch(err => console.error("Bot cycle error:", err));
    setTimeout(loop, RUN_INTERVAL_MS);
  }
  loop();
}
