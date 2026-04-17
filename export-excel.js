import { readFileSync } from "fs";
import ExcelJS from "exceljs";
import "dotenv/config";

const CSV_FILE = process.env.TRADE_LOG_PATH || "trades.csv";
const OUT_FILE = CSV_FILE.replace(".csv", ".xlsx");

const GREEN  = "FF00C853";
const RED    = "FFD50000";
const GOLD   = "FFFFD600";
const ORANGE = "FFFF6D00";
const WHITE  = "FFFFFFFF";
const HEADER = "FF1565C0";

const THIN_BORDER = {
  top:    { style: "thin", color: { argb: "FF999999" } },
  left:   { style: "thin", color: { argb: "FF999999" } },
  bottom: { style: "thin", color: { argb: "FF999999" } },
  right:  { style: "thin", color: { argb: "FF999999" } },
};

const HEADER_BORDER = {
  top:    { style: "medium", color: { argb: WHITE } },
  left:   { style: "medium", color: { argb: WHITE } },
  bottom: { style: "medium", color: { argb: WHITE } },
  right:  { style: "medium", color: { argb: WHITE } },
};

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

function styleSheet(sheet, rows) {
  const headers = rows[0];
  sheet.columns = headers.map(h => ({ header: h, key: h, width: Math.max(h.length + 4, 14) }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } };
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = HEADER_BORDER;
  });
  headerRow.height = 22;

  for (let i = 1; i < rows.length; i++) {
    const row = sheet.addRow(rows[i]);
    row.height = 18;
    const status = (rows[i][12] || "").toUpperCase();
    let bgColor = null;
    if (status === "BLOCKED") bgColor = RED;
    else if (status === "OPEN")    bgColor = GREEN;
    else if (status === "WIN")     bgColor = GOLD;
    else if (status === "LOSS")    bgColor = ORANGE;

    row.eachCell({ includeEmpty: true }, cell => {
      if (bgColor) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        cell.font = { color: { argb: status === "BLOCKED" ? WHITE : "FF000000" } };
      } else {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? "FFF5F5F5" : WHITE } };
      }
      cell.alignment = { vertical: "middle" };
      cell.border = THIN_BORDER;
    });
  }
}

export async function exportToExcel() {
  return main();
}

async function main() {
  const raw = readFileSync(CSV_FILE, "utf8");
  const allRows = parseCSV(raw);
  if (allRows.length < 2) { console.log("No trades to export."); return; }

  const headers = allRows[0];
  const dataRows = allRows.slice(1);

  // Group by symbol (column index 3)
  const bySymbol = {};
  for (const row of dataRows) {
    const sym = row[3] || "Unknown";
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(row);
  }

  const workbook = new ExcelJS.Workbook();

  // All Trades tab
  const allSheet = workbook.addWorksheet("All Trades", { views: [{ state: "frozen", ySplit: 1 }] });
  styleSheet(allSheet, allRows);

  // Per-symbol tabs
  for (const [sym, rows] of Object.entries(bySymbol).sort()) {
    const sheet = workbook.addWorksheet(sym, { views: [{ state: "frozen", ySplit: 1 }] });
    styleSheet(sheet, [headers, ...rows]);
  }

  // Legend tab
  const legend = workbook.addWorksheet("Legend");
  legend.columns = [{ key: "col1", width: 20 }, { key: "col2", width: 30 }];
  const legendData = [
    ["Colour", "Meaning"],
    ["🟢 Green", "OPEN — trade placed, waiting for TP/SL"],
    ["🔴 Red", "BLOCKED — conditions not met, no trade"],
    ["🟡 Gold", "WIN — take profit hit"],
    ["🟠 Orange", "LOSS — stop loss hit"],
  ];
  const legendColors = [HEADER, GREEN, RED, GOLD, ORANGE];
  const legendText  = [WHITE, "FF000000", WHITE, "FF000000", "FF000000"];
  legendData.forEach((r, i) => {
    const row = legend.addRow(r);
    if (i === 0) {
      row.eachCell(c => { c.font = { bold: true, color: { argb: WHITE } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } }; c.border = HEADER_BORDER; });
    } else {
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: legendColors[i] } };
      row.getCell(1).font = { bold: true, color: { argb: legendText[i] } };
      row.eachCell(c => { c.border = THIN_BORDER; });
    }
  });

  await workbook.xlsx.writeFile(OUT_FILE);
  console.log(`✅ Excel exported → ${OUT_FILE} (${Object.keys(bySymbol).length} symbol tabs + All Trades)`);
}

if (process.argv[1]?.includes("export-excel")) {
  main().catch(console.error);
}
