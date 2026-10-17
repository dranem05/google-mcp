import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the googleapis Sheets client so the real note handlers run against
// canned responses — no network, no credentials.
const sheetsStub = {
  spreadsheets: { get: vi.fn(), getByDataFilter: vi.fn(), batchUpdate: vi.fn() },
};
vi.mock("googleapis", () => ({ google: { sheets: () => sheetsStub, drive: () => ({}) } }));

const { registerSheetsTools } = await import("./index.js");

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function handler(name: string): Handler {
  const handlers = new Map<string, Handler>();
  const server = { tool: (toolName: string, ...rest: unknown[]) => handlers.set(toolName, rest[rest.length - 1] as Handler) };
  registerSheetsTools(server as never, { auth: {} } as never);
  return handlers.get(name)!;
}

describe("sheets note handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheetsStub.spreadsheets.get.mockResolvedValue({ data: { sheets: [{ properties: { sheetId: 5, title: "My Sheet" } }] } });
    sheetsStub.spreadsheets.batchUpdate.mockResolvedValue({ data: {} });
  });

  it("sheets_append_note rejects a range over the cap before fetching or writing", async () => {
    await expect(handler("sheets_append_note")({ spreadsheetId: "s", range: "'My Sheet'!A1:J1001", note: "x" }))
      .rejects.toThrow(/10010 cells, exceeding the 10000-cell cap/);
    expect(sheetsStub.spreadsheets.getByDataFilter).not.toHaveBeenCalled();
    expect(sheetsStub.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it("sheets_append_note appends onto each cell's fetched note", async () => {
    sheetsStub.spreadsheets.getByDataFilter.mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 5, title: "My Sheet" }, data: [{ rowData: [{ values: [{ note: "old" }] }] }] }] },
    });
    await handler("sheets_append_note")({ spreadsheetId: "s", range: "'My Sheet'!A1:B1", note: "new" });
    const request = sheetsStub.spreadsheets.batchUpdate.mock.calls[0][0].requestBody.requests[0];
    expect(request.updateCells.rows).toEqual([{ values: [{ note: "old\nnew" }, { note: "new" }] }]);
  });

  it("sheets_read_notes over a huge bounded range returns just the notes the API sent", async () => {
    sheetsStub.spreadsheets.getByDataFilter.mockResolvedValue({
      data: {
        sheets: [
          { properties: { sheetId: 9, title: "Other" }, data: [{ rowData: [{ values: [{ note: "wrong sheet" }] }] }] },
          { properties: { sheetId: 5, title: "My Sheet" }, data: [{ startRow: 4, rowData: [{ values: [{}, { note: "b5" }] }] }] },
        ],
      },
    });
    const res = await handler("sheets_read_notes")({ spreadsheetId: "s", range: "'My Sheet'!A1:ZZ100000" });
    expect(JSON.parse(res.content[0].text)).toEqual({ notes: [{ cell: "'My Sheet'!B5", note: "b5" }] });
    expect(sheetsStub.spreadsheets.getByDataFilter.mock.calls[0][0].requestBody.dataFilters[0].gridRange).toEqual({
      sheetId: 5, startRowIndex: 0, endRowIndex: 100000, startColumnIndex: 0, endColumnIndex: 702,
    });
  });
});
