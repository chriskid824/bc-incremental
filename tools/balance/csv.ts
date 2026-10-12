/** Minimal CSV writer (RFC 4180 quoting, "\n" line endings) for the balance simulator. */

export type CsvValue = string | number | boolean | null;

/** Significant digits kept for non-integer numbers. */
export const CSV_FLOAT_PRECISION = 6;

/**
 * Integers print as-is; other numbers keep CSV_FLOAT_PRECISION significant digits without
 * trailing zeros (12.3457, 0.25, 1.23457e+21). null prints as an empty field.
 */
export function csvNumber(value: number): string {
  if (Number.isInteger(value) || !Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(CSV_FLOAT_PRECISION)));
}

/** One field, quoted when it contains a comma, a double quote or a line break. */
export function csvField(value: CsvValue): string {
  if (value === null) return '';
  const text = typeof value === 'number' ? csvNumber(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: readonly CsvValue[]): string {
  return values.map(csvField).join(',');
}

/** Header plus rows; every row must have one value per column. Ends with a newline. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [csvLine(header)];
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`CSV row has ${row.length} values, header has ${header.length}`);
    }
    lines.push(csvLine(row));
  }
  return lines.join('\n') + '\n';
}
