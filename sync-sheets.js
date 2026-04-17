import { readFileSync } from "fs";
import { google } from "googleapis";
import "dotenv/config";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || "./google-credentials.json";
const CSV_FILE   = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/trades.csv";
const SHEET_NAME = "Trades";

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
  const rows = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    rows.push(cols.map(c => c.replace(/"/g, "").trim()));
  }
  return rows;
}

export async function syncToSheets() {
  const raw = readFileSync(CSV_FILE, "utf8");
  const rows = parseCSV(raw);
  if (!rows.length) return;

  const authClient = await getAuth();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Ensure sheet tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);

  if (!existing.includes(SHEET_NAME)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
  }

  // Clear and rewrite
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  // Apply header formatting + colour coding
  const sheetId = meta.data.sheets.find(s => s.properties.title === SHEET_NAME)?.properties.sheetId
    ?? (await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID }))
         .data.sheets.find(s => s.properties.title === SHEET_NAME).properties.sheetId;

  const colorMap = {
    BLOCKED: { red: 0.835, green: 0.000, blue: 0.000 },
    OPEN:    { red: 0.000, green: 0.784, blue: 0.325 },
    WIN:     { red: 1.000, green: 0.839, blue: 0.000 },
    LOSS:    { red: 1.000, green: 0.427, blue: 0.000 },
  };

  const requests = [];

  // Bold blue header row
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

  // Freeze header row
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  // Colour-code data rows by Status column (index 12)
  for (let i = 1; i < rows.length; i++) {
    const status = (rows[i][12] || "").toUpperCase();
    const color = colorMap[status];
    if (!color) continue;
    const textWhite = status === "BLOCKED";
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: i, endRowIndex: i + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: color,
            textFormat: {
              foregroundColor: textWhite
                ? { red: 1, green: 1, blue: 1 }
                : { red: 0, green: 0, blue: 0 },
            },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
  }

  // Auto-resize all columns
  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: rows[0].length },
    },
  });

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`[Sheets] Synced ${rows.length - 1} trade(s) → https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

// Run directly
if (process.argv[1]?.includes("sync-sheets")) {
  syncToSheets().catch(console.error);
}
