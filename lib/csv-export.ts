/**
 * CSV building for the admin "Download SACCO Books" exports.
 *
 * Spreadsheet-safe by construction:
 *  - UTF-8 BOM + CRLF line endings, so Excel opens the file correctly on the
 *    first try (no import wizard, no mangled UGX amounts).
 *  - CSV-injection hardening: a cell starting with =, +, -, @ or a tab would be
 *    evaluated as a FORMULA when an accountant opens the book in Excel or
 *    Google Sheets. Member-controlled values (names, phones, notes) are defused
 *    with a leading apostrophe before quoting.
 */

export function csvEscape(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else {
    s = String(value);
  }

  // Formula injection: defuse cells that a spreadsheet would evaluate.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }

  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ];
  // \uFEFF = UTF-8 BOM; CRLF is the line ending Excel expects.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `ledger-KUNSAC-2026-10-22.csv` — safe for the Content-Disposition header. */
export function csvFilename(report: string, orgCode: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeCode = (orgCode || 'sacco').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'sacco';
  const safeReport = report.replace(/[^a-z0-9-]/g, '');
  return `${safeReport}-${safeCode}-${date}.csv`;
}
