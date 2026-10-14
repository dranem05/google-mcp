import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Stub the googleapis Sheets client so the real tool handlers run against
// canned responses — no network, no credentials.
const sheetsStub = {
  spreadsheets: { batchUpdate: vi.fn() },
};
vi.mock("googleapis", () => ({ google: { sheets: () => sheetsStub, drive: () => ({}) } }));

const { registerSheetsTools } = await import("./index.js");

type Handler = (params: unknown) => Promise<unknown>;
const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
const server = {
  tool: (name: string, ...rest: unknown[]) =>
    tools.set(name, { shape: rest[rest.length - 2] as z.ZodRawShape, handler: rest[rest.length - 1] as Handler }),
};
registerSheetsTools(server as never, { auth: {} } as never);

function lastRequest(): Record<string, any> {
  const call = sheetsStub.spreadsheets.batchUpdate.mock.calls.at(-1)![0];
  return call.requestBody.requests[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  sheetsStub.spreadsheets.batchUpdate.mockResolvedValue({
    data: { replies: [{ addSheet: { properties: { sheetId: 7, title: "Tab" } } }] },
  });
});

describe("sheets_add_sheet index", () => {
  const add = (extra: Record<string, unknown> = {}) =>
    tools.get("sheets_add_sheet")!.handler({ spreadsheetId: "test-spreadsheet-id", title: "Tab", ...extra });

  it("passes index through to addSheet.properties when given", async () => {
    await add({ index: 0 });
    expect(lastRequest().addSheet.properties.index).toBe(0);
    await add({ index: 3 });
    expect(lastRequest().addSheet.properties.index).toBe(3);
  });

  it("omits index from addSheet.properties when not given", async () => {
    await add();
    expect(lastRequest().addSheet.properties).not.toHaveProperty("index");
    expect(lastRequest().addSheet.properties).toEqual({
      title: "Tab",
      gridProperties: { rowCount: 1000, columnCount: 26 },
    });
  });

  it("accepts only non-negative integers for index", () => {
    const schema = z.object(tools.get("sheets_add_sheet")!.shape);
    const base = { spreadsheetId: "test-spreadsheet-id", title: "Tab" };
    expect(schema.safeParse({ ...base, index: 2 }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, index: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, index: 1.5 }).success).toBe(false);
  });
});

describe("sheets_format_cells wrapStrategy / verticalAlignment", () => {
  const range = { spreadsheetId: "test-spreadsheet-id", sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 };
  const format = (extra: Record<string, unknown> = {}) => tools.get("sheets_format_cells")!.handler({ ...range, ...extra });

  it("writes wrapStrategy and verticalAlignment to the format and the fields mask when given", async () => {
    await format({ wrapStrategy: "WRAP", verticalAlignment: "TOP" });
    const { repeatCell } = lastRequest();
    expect(repeatCell.cell.userEnteredFormat).toEqual({ wrapStrategy: "WRAP", verticalAlignment: "TOP" });
    expect(repeatCell.fields.split(",").sort()).toEqual([
      "userEnteredFormat.verticalAlignment",
      "userEnteredFormat.wrapStrategy",
    ]);
  });

  it("writes each one independently", async () => {
    await format({ wrapStrategy: "CLIP" });
    expect(lastRequest().repeatCell.cell.userEnteredFormat).toEqual({ wrapStrategy: "CLIP" });
    expect(lastRequest().repeatCell.fields).toBe("userEnteredFormat.wrapStrategy");

    await format({ verticalAlignment: "MIDDLE" });
    expect(lastRequest().repeatCell.cell.userEnteredFormat).toEqual({ verticalAlignment: "MIDDLE" });
    expect(lastRequest().repeatCell.fields).toBe("userEnteredFormat.verticalAlignment");
  });

  it("leaves both out of the format and the fields mask when not given", async () => {
    await format({ bold: true, horizontalAlignment: "CENTER" });
    const { repeatCell } = lastRequest();
    expect(repeatCell.cell.userEnteredFormat).toEqual({ textFormat: { bold: true }, horizontalAlignment: "CENTER" });
    expect(repeatCell.fields).toBe("userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment");
    expect(repeatCell.fields).not.toMatch(/wrapStrategy|verticalAlignment/);
  });

  it("restricts both to the Sheets API enum values", () => {
    const schema = z.object(tools.get("sheets_format_cells")!.shape);
    for (const v of ["OVERFLOW_CELL", "LEGACY_WRAP", "CLIP", "WRAP"]) {
      expect(schema.safeParse({ ...range, wrapStrategy: v }).success).toBe(true);
    }
    for (const v of ["TOP", "MIDDLE", "BOTTOM"]) {
      expect(schema.safeParse({ ...range, verticalAlignment: v }).success).toBe(true);
    }
    expect(schema.safeParse({ ...range, wrapStrategy: "SPILL" }).success).toBe(false);
    expect(schema.safeParse({ ...range, verticalAlignment: "CENTER" }).success).toBe(false);
  });
});
