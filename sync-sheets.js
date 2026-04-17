import { readFileSync } from "fs";
import { google } from "googleapis";
import "dotenv/config";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || "./google-credentials.json";
const CSV_FILE   = process.env.TRADE_LOG_PATH || "trades.csv";

const TABS = ["All Trades", "CRYPTO", "FOREX", "GOLD", "TECH"];

function getCategory(symbol) {
  const s = (symbol || "").toUpperCase().trim();
  if (s === "XAUUSD" || s === "XAUUSDT") return "GOLD";
  if (/USDT$|USDC$|BUSD$/.test(s))       return "CRYPTO";
  if (/^[A-Z]{6}$/.test(s))              return "FOREX";
  return "TECH";
}

async function getAuth() {
  let creds;
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString("utf8"));
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
    const status = (rows[i][12] || "").toUpperCase();
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
    "All Trades": allRows,
    CRYPTO: byCategory.CRYPTO.length ? [headers, ...byCategory.CRYPTO] : [headers],
    FOREX:  byCategory.FOREX.length  ? [headers, ...byCategory.FOREX]  : [headers],
    GOLD:   byCategory.GOLD.length   ? [headers, ...byCategory.GOLD]   : [headers],
    TECH:   byCategory.TECH.length   ? [headers, ...byCategory.TECH]   : [headers],
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
