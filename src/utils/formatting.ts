// Compact (no pretty-print indent): tool responses are consumed by the
// model, not a human reading a terminal, and the `null, 2` indentation was
// spending real context-window tokens on whitespace with no benefit.
export function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text" as const, text }] };
}

export function mimeShortcut(input: string): string {
  const shortcuts: Record<string, string> = {
    document: "application/vnd.google-apps.document",
    spreadsheet: "application/vnd.google-apps.spreadsheet",
    presentation: "application/vnd.google-apps.presentation",
    folder: "application/vnd.google-apps.folder",
    form: "application/vnd.google-apps.form",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return shortcuts[input] || input;
}
