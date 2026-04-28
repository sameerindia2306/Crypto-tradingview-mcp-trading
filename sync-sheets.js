import { readFileSync } from "fs";
import { google } from "googleapis";
import "dotenv/config";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || "./google-credentials.json";
const CSV_FILE   = process.env.TRADE_LOG_PATH || "trades.csv";

const TABS = ["All Trades", "CRYPTO", "FOREX", "GOLD", "TECH"];

function groupByDayWithSummaries(dataRows) {
  if (!dataRows.length) return [];
  const EMPTY_ROW = new Array(18).fill("");
  const result    = [];

  const byDate = new Map();
  for (const row of dataRows) {
    const date = row[0] || "unknown";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }

  for (const [date, rows] of byDate) {
    result.push(...rows);

    const wins     = rows.filter(r => (r[12] || "").toUpperCase() === "WIN").length;
    const losses   = rows.filter(r => (r[12] || "").toUpperCase() === "LOSS").length;
    const blocked  = rows.filter(r => (r[12] || "").toUpperCase() === "BLOCKED").length;
    const executed = rows.filter(r => ["PAPER", "LIVE"].includes((r[11] || "").toUpperCase())).length;
    const closed   = rows.filter(r => ["WIN", "LOSS"].includes((r[12] || "").toUpperCase()));
    const totalPnL = closed.reduce((sum, r) => sum + (parseFloat(r[15]) || 0), 0);
    const totalFees= rows.reduce((sum, r) => sum + (parseFloat(r[8]) || 0), 0);
    const pnlStr   = closed.length ? (totalPnL >= 0 ? "+" : "") + totalPnL.toFixed(2) : "";

    result.push([
      date, "DAY SUMMARY", "", "── DAILY P&L ──", "", "", "", "",
      totalFees > 0 ? totalFees.toFixed(4) : "",
      "", "", "SUMMARY", "SUMMARY", "", "", pnlStr, "",
      `${wins}W ${losses}L | ${executed} executed | ${blocked} blocked`,
    ]);
    result.push(EMPTY_ROW);
  }
  return result;
}

function getCategory(symbol) {
  const s = (symbol || "").toUpperCase().trim();
  if (s === "XAUUSD" || s === "XAUUSDT") return "GOLD";
  if (/USDT$|USDC$|BUSD$/.test(s))       return "CRYPTO";
  if (/^[A-Z]{6}$/.test(s))              return "FOREX";
  return "TECH";
}

async function getAuth() {
  let creds;
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY_B64) {
    creds = {
      type: "service_account",
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64.replace(/\s+/g, ""), "base64").toString("utf8"),
    };
  } else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    creds = {
      type: "service_account",
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\r/g, "").replace(/\\n/g, "\n"),
    };
  } else if (process.env.GOOGLE_CREDENTIALS_B64) {
    const b64 = process.env.GOOGLE_CREDENTIALS_B64.replace(/\s+/g, "");
    creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } else {
    creds = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

function parseCSV(raw) {
  return raw.trim().split("\n").filter(l => l.trim()).map(line => {
    const cols = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    return cols.map(c => c.replace(/"/g, "").trim());
  });
}

function buildFormatRequests(sheetId, rows) {
  const requests = [];

  // Blue header
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.082, green: 0.396, blue: 0.753 }, // #1565C0
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: "CENTER",
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
    },
  });

  // Freeze header
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  const colorMap = {
    OPEN:    { red: 0.204, green: 0.659, blue: 0.325 }, // green
    BLOCKED: { red: 0.831, green: 0.000, blue: 0.000 }, // red
    WIN:     { red: 1.000, green: 0.839, blue: 0.000 }, // gold
    LOSS:    { red: 1.000, green: 0.427, blue: 0.000 }, // orange
  };

  for (let i = 1; i < rows.length; i++) {
    const mode    = (rows[i][11] || "").toUpperCase();
    const status  = (rows[i][12] || "").toUpperCase();
    const isBlank = rows[i].every(c => !c);

    if (isBlank) continue;

    // EOD summary row — deep purple background, gold bold text
    if (mode === "EOD") {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: i, endRowIndex: i + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.290, green: 0.000, blue: 0.510 }, // deep purple
              textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 1.000, green: 0.843, blue: 0.000 } }, // gold text
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
      continue;
    }

    if (mode === "SUMMARY") {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: i, endRowIndex: i + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.216, green: 0.278, blue: 0.310 }, // #37474F slate
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
      continue;
    }

    const color = colorMap[status];
    if (!color) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: i, endRowIndex: i + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: color,
            textFormat: {
              foregroundColor: (status === "BLOCKED" || status === "LOSS")
                ? { red: 1, green: 1, blue: 1 }
                : { red: 0, green: 0, blue: 0 },
            },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
  }

  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: (rows[0] || []).length },
    },
  });

  return requests;
}

const DEFAULT_HEADERS = [
  "Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
  "Entry Price","Total USD","Fee (est.)","Net Amount","Order ID",
  "Mode","Status","Exit Price","Exit Time","P&L USD","P&L %","Notes",
];

export async function syncToSheets() {
  let headers = DEFAULT_HEADERS;
  let dataRows = [];

  try {
    const raw = readFileSync(CSV_FILE, "utf8");
    const allRows = parseCSV(raw);
    if (allRows.length >= 1) headers  = allRows[0];
    if (allRows.length >= 2) dataRows = allRows.slice(1);
  } catch {
    console.log("[Sheets] CSV not found — writing headers only.");
  }

  const allRows = [headers, ...dataRows];

  // Group by category
  const byCategory = { CRYPTO: [], FOREX: [], GOLD: [], TECH: [] };
  for (const row of dataRows) {
    const cat = getCategory(row[3]);
    byCategory[cat].push(row);
  }

  const authClient = await getAuth();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Ensure all tabs exist — re-fetch after each creation to avoid stale state
  let meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  let existingTitles = meta.data.sheets.map(s => s.properties.title);

  for (const tab of TABS) {
    if (!existingTitles.includes(tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      }).catch(e => { if (!e.message?.includes("already exists")) throw e; });
      existingTitles.push(tab);
    }
  }

  // Write data to each tab
  const tabData = {
    "All Trades": [headers, ...groupByDayWithSummaries(dataRows)],
    CRYPTO: [headers, ...groupByDayWithSummaries(byCategory.CRYPTO)],
    FOREX:  [headers, ...groupByDayWithSummaries(byCategory.FOREX)],
    GOLD:   [headers, ...groupByDayWithSummaries(byCategory.GOLD)],
    TECH:   [headers, ...groupByDayWithSummaries(byCategory.TECH)],
  };

  for (const [tab, rows] of Object.entries(tabData)) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${tab}'!A:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  }

  // Refresh metadata for sheetIds then format all tabs at once
  meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMap = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  const allRequests = [];
  for (const [tab, rows] of Object.entries(tabData)) {
    if (sheetMap[tab] !== undefined) {
      allRequests.push(...buildFormatRequests(sheetMap[tab], rows));
    }
  }

  if (allRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: allRequests },
    });
  }

  const counts = Object.entries(byCategory).map(([k, v]) => `${k}:${v.length}`).join(" ");
  console.log(`[Sheets] Synced ${dataRows.length} trade(s) → ${counts} → https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

if (process.argv[1]?.includes("sync-sheets")) {
  syncToSheets().catch(console.error);
}
