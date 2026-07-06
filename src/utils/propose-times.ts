/**
 * Pure slot-ranking logic behind calendar_propose_times. Given busy intervals
 * (unioned across attendees, from a freebusy query), a search window, a meeting
 * duration, and working hours interpreted in a specific IANA timezone, it emits
 * the top-ranked open slots.
 *
 * Ranking prefers (in this order): earlier days, then times close to mid-morning
 * or mid-afternoon, and it penalizes slots overlapping the lunch hour (12:00-13:00
 * local). No more than `maxPerDay` slots are returned for any single day so the
 * suggestions spread across the window instead of clustering on day one.
 *
 * Everything here is deterministic and timezone-aware via Intl (no external deps),
 * so it's unit-tested directly without touching the Calendar API.
 */

export interface Interval {
  /** Epoch milliseconds. */
  start: number;
  end: number;
}

export interface RankedSlot {
  /** ISO 8601 UTC instant. */
  start: string;
  end: string;
  /** Lower is better. Exposed mainly for debugging/tests. */
  score: number;
}

export interface ProposeTimesOptions {
  windowStart: number;
  windowEnd: number;
  durationMinutes: number;
  /** Busy intervals across all attendees; overlaps are merged internally. */
  busy: Interval[];
  /** IANA timezone the working hours are expressed in (e.g. "America/New_York"). */
  timeZone: string;
  /** Minutes past local midnight the working day starts. Default 540 (09:00). */
  workingStartMinutes?: number;
  /** Minutes past local midnight the working day ends. Default 1050 (17:30). */
  workingEndMinutes?: number;
  /** Candidate start times are placed on this grid. Default 30 minutes. */
  slotGranularityMinutes?: number;
  /** Max slots to return. Default 5. */
  maxResults?: number;
  /** Max slots to return for any one calendar day. Default 2. */
  maxPerDay?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Offset (ms) to add to a UTC instant to get this timezone's local wall clock at that instant. */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - date.getTime();
}

/** Local wall-clock (Y/M/D + minutes past midnight) of a UTC instant in a timezone. */
function toLocalParts(timeZone: string, epochMs: number): { year: number; month: number; day: number; minutes: number } {
  const offset = tzOffsetMs(timeZone, new Date(epochMs));
  const local = new Date(epochMs + offset);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/**
 * Converts a local wall-clock time (Y/M/D + minutes past midnight) in a
 * timezone into a UTC instant. Resolves the offset twice so a guess landing on
 * the wrong side of a DST transition still yields the correct instant.
 */
function zonedTimeToEpoch(timeZone: string, year: number, month: number, day: number, minutes: number): number {
  const utcGuess = Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
  let offset = tzOffsetMs(timeZone, new Date(utcGuess));
  let epoch = utcGuess - offset;
  offset = tzOffsetMs(timeZone, new Date(epoch));
  epoch = utcGuess - offset;
  return epoch;
}

/** Sorts and merges overlapping/adjacent intervals into a disjoint, ascending list. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Subtracts busy intervals from [start, end], returning the free sub-intervals. */
function subtractBusy(start: number, end: number, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = start;
  for (const b of busy) {
    if (b.end <= cursor || b.start >= end) continue;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free;
}

/** Scores a candidate by local start minutes: distance to nearest preferred anchor + lunch penalty. */
function timePenalty(localStartMinutes: number, durationMinutes: number): number {
  const midMinutes = localStartMinutes + durationMinutes / 2;
  const mid = midMinutes / 60; // hours
  const anchorPenalty = Math.min(Math.abs(mid - 10.5), Math.abs(mid - 14.5));
  // Penalize a meeting whose midpoint falls inside the lunch hour (12:00-13:00).
  const lunchPenalty = mid >= 12 && mid < 13 ? 6 : 0;
  return anchorPenalty + lunchPenalty;
}

export function proposeTimes(opts: ProposeTimesOptions): RankedSlot[] {
  const {
    windowStart,
    windowEnd,
    durationMinutes,
    timeZone,
    workingStartMinutes = 9 * 60,
    workingEndMinutes = 17 * 60 + 30,
    slotGranularityMinutes = 30,
    maxResults = 5,
    maxPerDay = 2,
  } = opts;

  if (durationMinutes <= 0 || windowEnd <= windowStart) return [];

  const durationMs = durationMinutes * MINUTE_MS;
  const gridMs = Math.max(1, slotGranularityMinutes) * MINUTE_MS;
  const busy = mergeIntervals(opts.busy);

  // Iterate each local calendar day the window touches.
  const firstDay = toLocalParts(timeZone, windowStart);
  const lastDay = toLocalParts(timeZone, windowEnd);
  const dayStartEpoch = zonedTimeToEpoch(timeZone, firstDay.year, firstDay.month, firstDay.day, 0);

  const candidates: RankedSlot[] = [];
  // Cap the loop defensively; a window can't realistically span more days.
  const maxDays = Math.ceil((windowEnd - windowStart) / DAY_MS) + 2;

  for (let dayIndex = 0; dayIndex < maxDays; dayIndex++) {
    const noon = dayStartEpoch + dayIndex * DAY_MS + 12 * 60 * MINUTE_MS;
    const { year, month, day } = toLocalParts(timeZone, noon);
    const workStart = zonedTimeToEpoch(timeZone, year, month, day, workingStartMinutes);
    const workEnd = zonedTimeToEpoch(timeZone, year, month, day, workingEndMinutes);
    if (workStart > lastDayEnd(timeZone, lastDay)) break;

    const dayWindowStart = Math.max(workStart, windowStart);
    const dayWindowEnd = Math.min(workEnd, windowEnd);
    if (dayWindowEnd - dayWindowStart < durationMs) continue;

    const perDay: RankedSlot[] = [];
    for (const gap of subtractBusy(dayWindowStart, dayWindowEnd, busy)) {
      // Align the first candidate to the grid within the gap.
      const firstAligned = Math.ceil(gap.start / gridMs) * gridMs;
      for (let s = firstAligned; s + durationMs <= gap.end; s += gridMs) {
        const local = toLocalParts(timeZone, s);
        const score = dayIndex * 24 + timePenalty(local.minutes, durationMinutes);
        perDay.push({ start: new Date(s).toISOString(), end: new Date(s + durationMs).toISOString(), score });
      }
    }
    perDay.sort((a, b) => a.score - b.score);
    candidates.push(...perDay.slice(0, maxPerDay));
  }

  candidates.sort((a, b) => a.score - b.score || Date.parse(a.start) - Date.parse(b.start));
  return candidates.slice(0, maxResults);
}

/** End-of-day instant for the window's last local day, used to stop the day loop. */
function lastDayEnd(timeZone: string, lastDay: { year: number; month: number; day: number }): number {
  return zonedTimeToEpoch(timeZone, lastDay.year, lastDay.month, lastDay.day, 24 * 60);
}

/** Parses "HH:MM" into minutes past midnight. Throws on malformed input. */
export function parseHhMm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time-of-day "${value}" (expected HH:MM)`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time-of-day "${value}" (out of range)`);
  return hours * 60 + minutes;
}
