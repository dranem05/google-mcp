import { describe, expect, it } from "vitest";
import { withConcurrencyLimit } from "./concurrency.js";

function defer<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("withConcurrencyLimit", () => {
  it("resolves every item, preserving input order, using Promise.allSettled semantics", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await withConcurrencyLimit(items, 2, async (n) => defer(n * 10, 5));

    expect(results).toHaveLength(5);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : undefined))).toEqual([
      10, 20, 30, 40, 50,
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("never runs more than `limit` tasks concurrently", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let current = 0;
    let max = 0;

    await withConcurrencyLimit(items, 5, async (n) => {
      current++;
      max = Math.max(max, current);
      await defer(undefined, 5);
      current--;
      return n;
    });

    expect(max).toBeLessThanOrEqual(5);
    expect(max).toBeGreaterThan(1); // sanity: it actually parallelizes, not fully serial
  });

  it("reports failures per-item without failing the whole batch", async () => {
    const items = ["a", "b", "c"];

    const results = await withConcurrencyLimit(items, 5, async (id) => {
      if (id === "b") throw new Error(`failed: ${id}`);
      return `ok: ${id}`;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok: a" });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toEqual(new Error("failed: b"));
    expect(results[2]).toEqual({ status: "fulfilled", value: "ok: c" });
  });

  it("handles an empty input array", async () => {
    const results = await withConcurrencyLimit([], 5, async (n) => n);
    expect(results).toEqual([]);
  });
});
