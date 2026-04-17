import { readFileSync } from "fs";
import ExcelJS from "exceljs";
import "dotenv/config";

const CSV_FILE = process.env.TRADE_LOG_PATH || "trades.csv";
const OUT_FILE = CSV_FILE.replace(".csv", ".xlsx");

const GREEN  = "FF00C853"; // open trades
const RED    = "FFD50000"; // blocked trades
const GOLD   = "FFFFD600"; // win
const ORANGE = "FFFF6D00"; // loss
const WHITE  = "FFFFFFFF";
const HEADER = "FF1565C0"; // header row blue

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

export async function exportToExcel() {
  return main();
}

async function main() {
  const raw = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  if (raw.length < 2) { console.log("No trades to export."); return; }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Trades", { views: [{ state: "frozen", ySplit: 1 }] });

  // Parse headers
  const headers = raw[0].split(",");
  sheet.columns = headers.map(h => ({
    header: h.replace(/"/g, ""),
    key: h,
    width: Math.max(h.length + 4, 14),
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } };
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = HEADER_BORDER;
  });
  headerRow.height = 22;

  // Add data rows with color coding
  for (let i = 1; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) continue;

    // Handle quoted fields
    const cols = [];
    let current = "", inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { cols.push(current); current = ""; }
      else current += ch;
    }
    cols.push(current);

    const row = sheet.addRow(cols.map(c => c.replace(/"/g, "")));
    row.height = 18;

    const status = (cols[12] || "").replace(/"/g, "").trim().toUpperCase();

    let bgColor = null;
    if (status === "BLOCKED") bgColor = RED;
    else if (status === "OPEN")    bgColor = GREEN;
    else if (status === "WIN")     bgColor = GOLD;
    else if (status === "LOSS")    bgColor = ORANGE;

    if (bgColor) {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        cell.font = { color: { argb: status === "BLOCKED" ? WHITE : "FF000000" } };
        cell.alignment = { vertical: "middle" };
        cell.border = THIN_BORDER;
      });
    } else {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.alignment = { vertical: "middle" };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? "FFF5F5F5" : WHITE } };
        cell.border = THIN_BORDER;
      });
    }
  }

  // Add legend sheet
  const legend = workbook.addWorksheet("Legend");
  legend.columns = [{ key: "col1", width: 20 }, { key: "col2", width: 30 }];
  const legendData = [
    ["Colour", "Meaning"],
    ["🔵 Blue header", "Column labels"],
    ["🟢 Green", "OPEN — trade placed, waiting for TP/SL"],
    ["🔴 Red", "BLOCKED — conditions not met, no trade"],
    ["🟡 Gold", "WIN — take profit hit"],
    ["🟠 Orange", "LOSS — stop loss hit"],
  ];
  legendData.forEach((r, i) => {
    const row = legend.addRow(r);
    const colors = [HEADER, HEADER, GREEN, RED, GOLD, ORANGE];
    const textColors = [WHITE, WHITE, "FF000000", WHITE, "FF000000", "FF000000"];
    if (i > 0) {
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors[i] } };
      row.getCell(1).font = { bold: true, color: { argb: textColors[i] } };
      row.eachCell(c => { c.border = THIN_BORDER; });
    } else {
      row.eachCell(c => { c.font = { bold: true, color: { argb: WHITE } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } }; c.border = HEADER_BORDER; });
    }
  });

  await workbook.xlsx.writeFile(OUT_FILE);
  console.log(`✅ Exported → ${OUT_FILE}`);
}

main().catch(console.error);
