import { describe, expect, it } from "vitest";
import { calendar_v3 } from "googleapis";
import { formatEventForList } from "./index.js";

describe("formatEventForList", () => {
  const baseEvent: calendar_v3.Schema$Event = {
    id: "evt1",
    summary: "Team sync",
    description: "Weekly sync",
    start: { dateTime: "2026-07-06T10:00:00Z" },
    end: { dateTime: "2026-07-06T11:00:00Z" },
    location: "Room 1",
    status: "confirmed",
    htmlLink: "https://calendar.google.com/event?eid=abc",
    attendees: [
      { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted", organizer: true, self: true },
      { email: "bob@example.com", displayName: "Bob", responseStatus: "needsAction" },
    ],
    conferenceData: {
      conferenceId: "conf123",
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
    },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    creator: { email: "alice@example.com" },
    organizer: { email: "alice@example.com" },
  };

  it("trims attendees to email + responseStatus only", () => {
    const result = formatEventForList(baseEvent, false);
    expect(result.attendees).toEqual([
      { email: "alice@example.com", responseStatus: "accepted" },
      { email: "bob@example.com", responseStatus: "needsAction" },
    ]);
  });

  it("drops conferenceData when includeDetails is false", () => {
    const result = formatEventForList(baseEvent, false);
    expect(result.conferenceData).toBeUndefined();
    expect("conferenceData" in JSON.parse(JSON.stringify(result))).toBe(false);
  });

  it("keeps full conferenceData when includeDetails is true", () => {
    const result = formatEventForList(baseEvent, true);
    expect(result.conferenceData).toEqual(baseEvent.conferenceData);
  });

  it("still trims attendees even when includeDetails is true", () => {
    const result = formatEventForList(baseEvent, true);
    expect(result.attendees).toEqual([
      { email: "alice@example.com", responseStatus: "accepted" },
      { email: "bob@example.com", responseStatus: "needsAction" },
    ]);
  });

  it("preserves the other formatEvent fields unchanged", () => {
    const result = formatEventForList(baseEvent, false);
    expect(result.id).toBe("evt1");
    expect(result.summary).toBe("Team sync");
    expect(result.start).toEqual(baseEvent.start);
    expect(result.end).toEqual(baseEvent.end);
    expect(result.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
  });

  it("handles an event with no attendees", () => {
    const result = formatEventForList({ ...baseEvent, attendees: undefined }, false);
    expect(result.attendees).toBeUndefined();
  });
});
