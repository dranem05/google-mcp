import { describe, expect, it } from "vitest";
import { proposeTimes, mergeIntervals, parseHhMm, type Interval } from "./propose-times.js";

const HOUR = 60 * 60 * 1000;

/** Local hour-of-day (float) of an ISO instant in a timezone, for assertions. */
function localHour(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  return map.hour + map.minute / 60;
}

describe("mergeIntervals", () => {
  it("merges overlapping and adjacent intervals and drops empties", () => {
    const intervals: Interval[] = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 15, end: 20 },
      { start: 30, end: 30 }, // empty
      { start: 40, end: 50 },
    ];
    expect(mergeIntervals(intervals)).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 50 },
    ]);
  });
});

describe("parseHhMm", () => {
  it("parses HH:MM to minutes past midnight", () => {
    expect(parseHhMm("09:00")).toBe(540);
    expect(parseHhMm("17:30")).toBe(1050);
  });
  it("rejects malformed or out-of-range values", () => {
    expect(() => parseHhMm("9am")).toThrow();
    expect(() => parseHhMm("25:00")).toThrow();
  });
});

describe("proposeTimes", () => {
  const windowStart = Date.UTC(2026, 0, 5, 0, 0); // Mon 2026-01-05
  const windowEnd = Date.UTC(2026, 0, 8, 0, 0); // through Wed 2026-01-07

  it("prefers mid-morning, then mid-afternoon, on the earliest day when fully free", () => {
    const slots = proposeTimes({
      windowStart,
      windowEnd,
      durationMinutes: 60,
      busy: [],
      timeZone: "UTC",
    });
    expect(slots.length).toBe(5); // maxPerDay 2 across 3 days, capped at 5
    expect(slots[0].start).toBe("2026-01-05T10:00:00.000Z");
    expect(slots[1].start).toBe("2026-01-05T14:00:00.000Z");
    // Day 1's best still ranks below both of day 0's slots.
    expect(slots[2].start).toBe("2026-01-06T10:00:00.000Z");
  });

  it("keeps every slot inside working hours and long enough for the meeting", () => {
    const slots = proposeTimes({
      windowStart,
      windowEnd,
      durationMinutes: 90,
      busy: [],
      timeZone: "UTC",
    });
    for (const s of slots) {
      const startH = localHour(s.start, "UTC");
      const endMs = Date.parse(s.end) - Date.parse(s.start);
      expect(endMs).toBe(90 * 60 * 1000);
      expect(startH).toBeGreaterThanOrEqual(9);
      // A 90-min slot must finish by 17:30, so it can start no later than 16:00.
      expect(startH).toBeLessThanOrEqual(16);
    }
  });

  it("never proposes a slot overlapping a busy interval", () => {
    const busyStart = Date.UTC(2026, 0, 5, 9, 30);
    const busyEnd = Date.UTC(2026, 0, 5, 15, 0);
    const slots = proposeTimes({
      windowStart,
      windowEnd: Date.UTC(2026, 0, 6, 0, 0), // just day 0
      durationMinutes: 60,
      busy: [{ start: busyStart, end: busyEnd }],
      timeZone: "UTC",
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const st = Date.parse(s.start);
      const en = Date.parse(s.end);
      expect(st >= busyEnd || en <= busyStart).toBe(true);
    }
    // First free-and-fitting slot after the block is 15:00.
    expect(slots[0].start).toBe("2026-01-05T15:00:00.000Z");
  });

  it("caps results per day so suggestions spread across days", () => {
    const slots = proposeTimes({
      windowStart,
      windowEnd,
      durationMinutes: 60,
      busy: [],
      timeZone: "UTC",
      maxResults: 6,
      maxPerDay: 2,
    });
    const days = slots.map((s) => s.start.slice(0, 10));
    for (const day of new Set(days)) {
      expect(days.filter((d) => d === day).length).toBeLessThanOrEqual(2);
    }
  });

  it("interprets working hours in the given timezone (America/New_York)", () => {
    const slots = proposeTimes({
      windowStart: Date.UTC(2026, 0, 5, 0, 0),
      windowEnd: Date.UTC(2026, 0, 5, 23, 59),
      durationMinutes: 60,
      busy: [],
      timeZone: "America/New_York",
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const h = localHour(s.start, "America/New_York");
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(17.5);
    }
    // 09:00 New York in January is 14:00 UTC.
    expect(slots.every((s) => Date.parse(s.start) >= Date.UTC(2026, 0, 5, 14, 0))).toBe(true);
  });

  it("returns nothing for a zero/negative duration or inverted window", () => {
    expect(proposeTimes({ windowStart, windowEnd, durationMinutes: 0, busy: [], timeZone: "UTC" })).toEqual([]);
    expect(proposeTimes({ windowStart: windowEnd, windowEnd: windowStart, durationMinutes: 60, busy: [], timeZone: "UTC" })).toEqual([]);
  });
});
