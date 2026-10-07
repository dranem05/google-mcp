import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../server.js";
import { assertToolsStrict } from "./errors.js";
import { deepStrict, newStrictifyStats } from "./strict-params.js";

function makeCtx() {
  return { auth: new OAuth2Client(), accountSlug: "test-slug" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemaOf(server: McpServer, name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools[name].inputSchema;
}

describe("strict tool parameters (registration choke point)", () => {
  const server = createServer(makeCtx());
  const event = { calendarId: "primary", summary: "s", start: "2026-10-01T10:00:00", end: "2026-10-01T11:00:00" };

  it("makes every registered tool strict", () => {
    const { strict, noArgs } = assertToolsStrict(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strict + noArgs).toBe(Object.keys((server as any)._registeredTools).length);
    expect(strict).toBeGreaterThan(100);
  });

  it("rejects a misspelled top-level parameter", () => {
    const r = schemaOf(server, "calendar_create_event").safeParse({ ...event, timezone: "UTC" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toContain("timezone");
  });

  it("rejects a misspelled nested parameter, including inside array items", () => {
    const s = schemaOf(server, "calendar_create_event");
    expect(s.safeParse({ ...event, reminders: { useDefault: false, override: [] } }).success).toBe(false);
    expect(s.safeParse({ ...event, attendees: [{ email: "a@b.c", optinal: true }] }).success).toBe(false);
  });

  it("accepts valid parameters unchanged, defaults still applied", () => {
    const r = schemaOf(server, "gmail_draft_email").safeParse({ to: ["a@b.c"], subject: "s", body: "b" });
    expect(r.success).toBe(true);
    expect(r.data.mimeType).toBe("text/plain");
  });

  it("accepts and ignores extra keys on a zero-parameter tool", () => {
    const schema = schemaOf(server, "gmail_list_labels");
    expect(schema.safeParse({}).success).toBe(true);
    const r = schema.safeParse({ random_string: "x" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
    expect(() => assertToolsStrict(server)).not.toThrow();
  });

  it("assertToolsStrict counts a zero-property object as a no-arg tool", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    s.registerTool("noargs-bypass", { inputSchema: {} }, async () => ({ content: [] }));
    expect(() => assertToolsStrict(s)).not.toThrow();
  });

  it("assertToolsStrict accepts an explicit top-level passthrough as an opt-out", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    s.tool("loose", { a: z.string() }, async () => ({ content: [] }));
    // simulate an explicit catchall schema registered by hand
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._registeredTools["loose"].inputSchema = z.looseObject({ a: z.string() });
    expect(() => assertToolsStrict(s)).not.toThrow();
  });

  it("assertToolsStrict names the missing private SDK internal", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertToolsStrict({} as any)).toThrow(/_registeredTools/);
  });

  it("registers a tool with a transformed parameter and still rejects unknown nested keys", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    s.tool(
      "pipe-ok",
      { opts: z.object({ n: z.string() }).transform((o) => ({ n: o.n.toUpperCase() })) },
      async () => ({ content: [] })
    );
    const schema = schemaOf(s, "pipe-ok");
    expect(schema.safeParse({ opts: { n: "a" } }).data).toEqual({ opts: { n: "A" } });
    expect(schema.safeParse({ opts: { n: "a", extra: 1 } }).success).toBe(false);
    expect(() => assertToolsStrict(s)).not.toThrow();
  });

  it("leaves no loosely-registered tool behind when strictification throws", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    expect(() =>
      s.tool("lazy-gap", { o: z.lazy(() => z.object({ a: z.string() })) }, async () => ({ content: [] }))
    ).toThrow(/lazy-gap/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Object.keys((s as any)._registeredTools)).not.toContain("lazy-gap");
    expect(() => assertToolsStrict(s)).not.toThrow();
  });

  it("fails the startup assertion when a tool bypasses the choke point", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    s.registerTool("bypass", { inputSchema: { a: z.string() } }, async () => ({ content: [] }));
    expect(() => assertToolsStrict(s)).toThrow(/bypass/);
  });

  it("throws at registration when an object is nested under z.preprocess", () => {
    const s = createServer(makeCtx(), { families: ["meet"] });
    expect(() =>
      s.tool(
        "preprocess-gap",
        { opts: z.preprocess((v) => v, z.object({ timeZone: z.string().optional() })) },
        async () => ({ content: [] })
      )
    ).toThrow(/preprocess-gap/);
  });
});

describe("deepStrict", () => {
  it("preserves descriptions, checks, and function defaults on rebuilt wrappers", () => {
    let n = 0;
    const src = z
      .array(z.object({ a: z.string() }))
      .min(1)
      .default(() => [{ a: `v${++n}` }])
      .describe("the list");
    const out = deepStrict(src, newStrictifyStats());
    expect(out.description).toBe("the list");
    expect(out.safeParse([]).success).toBe(false); // .min(1) survived
    expect(out.parse(undefined)).toEqual([{ a: "v1" }]);
    expect(out.parse(undefined)).toEqual([{ a: "v2" }]); // default still re-evaluated
    expect(out.safeParse([{ a: "x", b: 1 }]).success).toBe(false);
  });

  it("leaves explicit passthrough objects alone", () => {
    const stats = newStrictifyStats();
    const out = deepStrict(z.looseObject({ a: z.string() }), stats);
    expect(out.safeParse({ a: "x", extra: 1 }).success).toBe(true);
    expect(stats.explicitCatchall).toBe(1);
  });
});

describe("deepStrict edge cases", () => {
  it("keeps walking below an object that is already .strict()", () => {
    const out = deepStrict(z.object({ o: z.strictObject({ n: z.object({ x: z.string() }) }) }), newStrictifyStats());
    expect(out.safeParse({ o: { n: { x: "a" } } }).success).toBe(true);
    expect(out.safeParse({ o: { n: { x: "a", typo: 1 } } }).success).toBe(false);
  });
  it("refuses .catch() rather than turning a typo into a silent fallback", () => {
    expect(() =>
      deepStrict(z.object({ o: z.object({ a: z.string() }).catch({ a: "DEFAULT" }) }), newStrictifyStats())
    ).toThrow(/catch/);
  });
});
