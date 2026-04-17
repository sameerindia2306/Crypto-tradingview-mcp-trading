import { readFileSync } from "fs";
import ExcelJS from "exceljs";
import "dotenv/config";

const CSV_FILE = process.env.TRADE_LOG_PATH || "trades.csv";
const OUT_FILE = CSV_FILE.replace(".csv", ".xlsx");

const BLUE   = "FF1565C0";
const GREEN  = "FF34A853"; // OPEN
const RED    = "FFD50000"; // BLOCKED
const GOLD   = "FFFFD600"; // WIN
const ORANGE = "FFFF6D00"; // LOSS
const WHITE  = "FFFFFFFF";

const THIN_BORDER = {
  top:    { style: "thin", color: { argb: "FFCCCCCC" } },
  left:   { style: "thin", color: { argb: "FFCCCCCC" } },
  bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
  right:  { style: "thin", color: { argb: "FFCCCCCC" } },
};

function getCategory(symbol) {
  const s = (symbol || "").toUpperCase().trim();
  if (s === "XAUUSD" || s === "XAUUSDT") return "GOLD";
  if (/USDT$|USDC$|BUSD$/.test(s))       return "CRYPTO";
  if (/^[A-Z]{6}$/.test(s))              return "FOREX";
  return "TECH";
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

function styleSheet(workbook, tabName, headers, dataRows) {
  const sheet = workbook.addWorksheet(tabName, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = headers.map(h => ({ header: h, key: h, width: Math.max(h.length + 4, 14) }));

  // Blue header row
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    cell.font   = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { top: { style: "medium", color: { argb: WHITE } }, left: { style: "medium", color: { argb: WHITE } }, bottom: { style: "medium", color: { argb: WHITE } }, right: { style: "medium", color: { argb: WHITE } } };
  });
  headerRow.height = 22;

  for (let i = 0; i < dataRows.length; i++) {
    const row = sheet.addRow(dataRows[i]);
    row.height = 18;
    const status = (dataRows[i][12] || "").toUpperCase();

    let bgColor = null;
    let fontColor = "FF000000";
    if      (status === "OPEN")    { bgColor = GREEN;  fontColor = "FF000000"; }
    else if (status === "BLOCKED") { bgColor = RED;    fontColor = WHITE; }
    else if (status === "WIN")     { bgColor = GOLD;   fontColor = "FF000000"; }
    else if (status === "LOSS")    { bgColor = ORANGE; fontColor = WHITE; }

    row.eachCell({ includeEmpty: true }, cell => {
      if (bgColor) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        cell.font = { color: { argb: fontColor } };
      } else {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? "FFF5F5F5" : WHITE } };
      }
      cell.alignment = { vertical: "middle" };
      cell.border = THIN_BORDER;
    });
  }

  return sheet;
}

export async function exportToExcel() {
  return main();
}

async function main() {
  const raw = readFileSync(CSV_FILE, "utf8");
  const allRows = parseCSV(raw);
  if (allRows.length < 2) { console.log("No trades to export."); return; }

  const headers  = allRows[0];
  const dataRows = allRows.slice(1);

  const byCategory = { CRYPTO: [], FOREX: [], GOLD: [], TECH: [] };
  for (const row of dataRows) {
    byCategory[getCategory(row[3])].push(row);
  }

  const workbook = new ExcelJS.Workbook();

  styleSheet(workbook, "All Trades", headers, dataRows);
  styleSheet(workbook, "CRYPTO", headers, byCategory.CRYPTO);
  styleSheet(workbook, "FOREX",  headers, byCategory.FOREX);
  styleSheet(workbook, "GOLD",   headers, byCategory.GOLD);
  styleSheet(workbook, "TECH",   headers, byCategory.TECH);

  await workbook.xlsx.writeFile(OUT_FILE);

  const counts = Object.entries(byCategory).map(([k, v]) => `${k}:${v.length}`).join(" ");
  console.log(`✅ Excel → ${OUT_FILE} | ${counts}`);
}

if (process.argv[1]?.includes("export-excel")) {
  main().catch(console.error);
}
