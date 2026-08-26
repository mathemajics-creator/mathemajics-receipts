// csv.js — shared CSV cell rules for the receipt and invoice exports, so both
// files get identical formula-injection and RFC-4180 handling.

const { ymd } = require('./format');

// Formula-injection defense first (a leading =, +, - or @ makes Excel/Sheets
// treat the cell as a formula), then RFC-4180 quoting.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// A date cell is the same YYYY-MM-DD the JSON responses carry — one date
// implementation for every surface, for the same reason there is one money().
// The accountant's spreadsheet and the API must not disagree about a day.
const isoDate = ymd;

module.exports = { csvCell, isoDate };
