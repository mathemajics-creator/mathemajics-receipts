// csv.js — shared CSV cell rules for the receipt and invoice exports, so both
// files get identical formula-injection and RFC-4180 handling.

// Formula-injection defense first (a leading =, +, - or @ makes Excel/Sheets
// treat the cell as a formula), then RFC-4180 quoting.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Postgres DATE arrives as a Date at local midnight — format locally
// (toISOString would shift the day in non-UTC timezones).
function isoDate(d) {
  if (d === null || d === undefined) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

module.exports = { csvCell, isoDate };
