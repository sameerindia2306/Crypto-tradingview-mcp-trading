import { readFileSync } from "fs";
import { google } from "googleapis";
import "dotenv/config";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || "./google-credentials.json";
const CSV_FILE   = process.env.TRADE_LOG_PATH || "trades.csv";

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
  const colorMap = {
    BLOCKED: { red: 0.835, green: 0.000, blue: 0.000 },
    OPEN:    { red: 0.000, green: 0.784, blue: 0.325 },
    WIN:     { red: 1.000, green: 0.839, blue: 0.000 },
    LOSS:    { red: 1.000, green: 0.427, blue: 0.000 },
  };

  const requests = [];

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.082, green: 0.396, blue: 0.753 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: "CENTER",
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
    },
  });

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

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
              foregroundColor: status === "BLOCKED"
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
      dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: rows[0].length },
    },
  });

  return requests;
}

async function ensureTab(sheets, spreadsheetId, tabName, existingTitles) {
  if (!existingTitles.includes(tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function writeTab(sheets, spreadsheetId, tabName, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

export async function syncToSheets() {
  const raw = readFileSync(CSV_FILE, "utf8");
  const allRows = parseCSV(raw);
  if (allRows.length < 2) { console.log("[Sheets] No trades to sync."); return; }

  const headers = allRows[0];
  const dataRows = allRows.slice(1);

  // Group by symbol (column index 3)
  const bySymbol = {};
  for (const row of dataRows) {
    const sym = row[3] || "Unknown";
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(row);
  }

  const tabNames = ["All Trades", ...Object.keys(bySymbol).sort()];

  const authClient = await getAuth();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Get current tabs
  let meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  let existingTitles = meta.data.sheets.map(s => s.properties.title);

  // Create any missing tabs
  for (const tab of tabNames) {
    await ensureTab(sheets, SHEET_ID, tab, existingTitles);
    existingTitles = [...new Set([...existingTitles, tab])];
  }

  // Write data to each tab
  await writeTab(sheets, SHEET_ID, "All Trades", allRows);
  for (const [sym, rows] of Object.entries(bySymbol).sort()) {
    await writeTab(sheets, SHEET_ID, sym, [headers, ...rows]);
  }

  // Refresh metadata for sheetIds, then format all tabs
  meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMap = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  const allRequests = [];
  allRequests.push(...buildFormatRequests(sheetMap["All Trades"], allRows));
  for (const [sym, rows] of Object.entries(bySymbol).sort()) {
    if (sheetMap[sym] !== undefined) {
      allRequests.push(...buildFormatRequests(sheetMap[sym], [headers, ...rows]));
    }
  }

  if (allRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: allRequests },
    });
  }

  console.log(`[Sheets] Synced ${dataRows.length} trade(s) across ${Object.keys(bySymbol).length} symbol tabs + All Trades → https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

if (process.argv[1]?.includes("sync-sheets")) {
  syncToSheets().catch(console.error);
}
