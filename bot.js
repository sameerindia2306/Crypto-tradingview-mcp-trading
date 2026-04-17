/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import http from "http";
import { google } from "googleapis";

// Health check endpoint so Railway can monitor and auto-restart if unresponsive
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env") && !process.env.BINANCE_API_KEY) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Binance credentials",
        "BINANCE_API_KEY=",
        "BINANCE_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOLS=XRPUSDT,HYPEUSDT,ETHUSDT,ADAUSDT",
        "TIMEFRAME=5m",
      ].join("\n") + "\n",
    );
    try {
      execSync(process.platform === "win32" ? "notepad .env" : "open .env");
    } catch {}
    console.log(
      "Fill in your Binance credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT").split(",").map(s => s.trim()),
  timeframe: process.env.TIMEFRAME || "15m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl: "https://api.binance.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "open-positions.json";

// ─── Open Positions Tracking ─────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function addPosition(symbol, side, entryPrice, quantity, orderId, paperTrading) {
  const slPct = 0.005; // 0.5% hard stop
  const tpPct = 0.015; // 1.5% = 3:1 RR
  const sl = side === "buy" ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const tp = side === "buy" ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);
  const positions = loadPositions();
  positions.push({ symbol, side, entryPrice, quantity, orderId, sl, tp, paperTrading, openedAt: new Date().toISOString() });
  savePositions(positions);
}

function checkAndClosePositions(symbol, currentPrice) {
  const positions = loadPositions();
  const remaining = [];
  const closed = [];

  for (const pos of positions) {
    if (pos.symbol !== symbol) { remaining.push(pos); continue; }
    const isLong = pos.side === "buy";
    const hitSL = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    const hitTP = isLong ? currentPrice >= pos.tp : currentPrice <= pos.tp;

    if (hitTP || hitSL) {
      const exitPrice = hitTP ? pos.tp : pos.sl;
      const pnlUSD = isLong
        ? (exitPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - exitPrice) * pos.quantity;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * (isLong ? 100 : -100);
      closed.push({ ...pos, exitPrice, exitTime: new Date().toISOString(), pnlUSD, pnlPct, result: hitTP ? "WIN" : "LOSS" });
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
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data ─────────────────────────────────────────────────────────────
// Uses Binance for crypto pairs, BitGet for everything else (e.g. XAUUSDT)

async function fetchCandles(symbol, interval, limit = 100) {
  // BitGet used for all symbols — Binance.com is geo-blocked on Railway (US servers, 451 error)
  return fetchCandlesBitget(symbol, interval, limit);
}

async function fetchCandlesBinance(symbol, interval, limit) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${intervalMap[interval] || "1m"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function fetchCandlesBitget(symbol, interval, limit) {
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

function calcVolumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const avgVol = candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period;
  return avgVol === 0 ? null : candles[candles.length - 1].volume / avgVol;
}

function isInTradingSession() {
  return true; // Crypto trades 24/7
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

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema9, ema21, vwap, rsi14) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullish = price > vwap && ema9 > ema21;
  const bearish = price < vwap && ema9 < ema21;
  const distFromVWAP = vwap ? Math.abs((price - vwap) / vwap) * 100 : 999;

  if (bullish) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP (buyers in control)",      `> ${vwap.toFixed(4)}`,  price.toFixed(4),  price > vwap);
    check("EMA(9) above EMA(21) — uptrend confirmed",  `> ${ema21.toFixed(4)}`, ema9.toFixed(4),   ema9 > ema21);
    check("RSI(14) in momentum zone (45–65)",          "45–65",                 rsi14 ? rsi14.toFixed(1) : "N/A", rsi14 !== null && rsi14 >= 45 && rsi14 <= 65);
    check("Price within 2.0% of VWAP (not overextended)", "< 2.0%",            `${distFromVWAP.toFixed(2)}%`,    distFromVWAP < 2.0);
  } else if (bearish) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP (sellers in control)",     `< ${vwap.toFixed(4)}`,  price.toFixed(4),  price < vwap);
    check("EMA(9) below EMA(21) — downtrend confirmed",`< ${ema21.toFixed(4)}`, ema9.toFixed(4),   ema9 < ema21);
    check("RSI(14) in momentum zone (35–55)",          "35–55",                 rsi14 ? rsi14.toFixed(1) : "N/A", rsi14 !== null && rsi14 >= 35 && rsi14 <= 55);
    check("Price within 2.0% of VWAP (not overextended)", "< 2.0%",            `${distFromVWAP.toFixed(2)}%`,    distFromVWAP < 2.0);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.05,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

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

// ─── Google Sheets Live Append ───────────────────────────────────────────────

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Trades";

async function getSheetsClient() {
  let credentials;
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    credentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString("utf8"));
  } else if (process.env.GOOGLE_CREDENTIALS_PATH && existsSync(process.env.GOOGLE_CREDENTIALS_PATH)) {
    credentials = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_PATH, "utf8"));
  } else {
    return null;
  }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function ensureSheetHeaders(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:R1` });
    if (!res.data.values || !res.data.values.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [CSV_HEADERS.split(",")] },
      });
    }
  } catch {}
}

async function appendSheetRow(row) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await ensureSheetHeaders(sheets);
    const values = [row.map(v => String(v).replace(/^"|"$/g, ""))];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:R`,
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  } catch (err) {
    console.log(`  ⚠️  Sheets append failed: ${err.message}`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = process.env.TRADE_LOG_PATH || "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
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

  if (!logEntry.allPass) {
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
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
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
  console.log(`Tax record saved → ${CSV_FILE}`);
  appendSheetRow(row.split(",")).catch(() => {});
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
  appendSheetRow(row.split(",")).catch(() => {});
  console.log(`  ${closed.result === "WIN" ? "✅ WIN" : "❌ LOSS"} logged → ${closed.symbol} | P&L: $${closed.pnlUSD.toFixed(4)} (${closed.pnlPct.toFixed(2)}%)`);
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

async function runSymbol(symbol, rules, log) {
  console.log(`\n── ${symbol} ─────────────────────────────────────────────`);

  // Fetch candle data
  let candles;
  try {
    candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  Could not fetch data for ${symbol}: ${err.message}`);
    return;
  }

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Price: $${price.toFixed(4)}`);

  // Check if any open positions for this symbol have hit TP or SL
  const closed = checkAndClosePositions(symbol, price);
  if (closed.length > 0) {
    console.log(`  Checking open positions...`);
    for (const c of closed) writeCloseCsv(c);
  }

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const vwap  = calcVWAP(candles);
  const rsi14 = calcRSI(closes, 14);

  console.log(`  EMA(9): $${ema9.toFixed(4)} | EMA(21): $${ema21.toFixed(4)} | VWAP: ${vwap ? "$" + vwap.toFixed(4) : "N/A"} | RSI(14): ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  if (!vwap || rsi14 === null) {
    console.log(`  ⚠️  Not enough data to calculate indicators — skipping.`);
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema9, ema21, vwap, rsi14);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema9, ema21, vwap, rsi14 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`  🚫 BLOCKED — ${failed.join("; ")}`);
  } else {
    console.log(`  ✅ ALL CONDITIONS MET`);
    const side = logEntry.conditions.find(c => c.bias)?.bias === "bearish" ? "sell" : "buy";
    const quantity = tradeSize / price;

    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER TRADE — would ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      addPosition(symbol, side, price, quantity, logEntry.orderId, true);
    } else {
      console.log(`  🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
      try {
        const order = await placeBinanceOrder(symbol, side, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`  ✅ ORDER PLACED — ${order.orderId}`);
        addPosition(symbol, side, price, quantity, order.orderId, false);
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

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols: ${CONFIG.symbols.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — daily trade limit reached.");
    return;
  }

  for (const symbol of CONFIG.symbols) {
    // Re-check limit before each symbol in case it was hit mid-run
    if (!checkTradeLimits(log)) {
      console.log(`\n⚠️  Daily trade limit hit — stopping after ${symbol} skipped.`);
      break;
    }
    await runSymbol(symbol, rules, log);
  }

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log(`Tax record saved → ${CSV_FILE}`);
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
