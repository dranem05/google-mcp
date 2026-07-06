/**
 * Pure helpers for the Drive-native markdown round-trip used by the docs
 * markdown tools. The heavy lifting (markdown <-> native Docs conversion) is
 * done by Drive's own export/import; these helpers only handle the string
 * plumbing around it.
 */

/**
 * Joins an existing markdown export with new markdown to append. Ensures the
 * two blocks are separated by a blank line so the appended content starts a
 * fresh paragraph/heading rather than merging into the last line of the
 * existing document. Drive's markdown export normally ends with a trailing
 * newline; we normalize trailing whitespace before inserting the separator so
 * the result is deterministic regardless of how many trailing newlines the
 * export carried.
 */
export function concatMarkdownForAppend(existingMarkdown: string, newMarkdown: string): string {
  const existing = existingMarkdown.replace(/\s+$/, "");
  if (existing === "") return newMarkdown;
  const addition = newMarkdown.replace(/^\n+/, "");
  return `${existing}\n\n${addition}`;
}
