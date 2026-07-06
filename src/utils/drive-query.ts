/**
 * Escapes a value for safe interpolation into a Drive API `q` string literal
 * (e.g. `name contains '${escapeDriveQueryValue(query)}'`).
 *
 * Per the Drive search-terms reference, a literal inside single quotes must
 * have its backslashes and single quotes backslash-escaped:
 * https://developers.google.com/drive/api/guides/ref-search-terms
 *
 * Backslashes must be escaped first so a value's own escaping can't be
 * "un-escaped" by the quote-escaping pass that follows.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
