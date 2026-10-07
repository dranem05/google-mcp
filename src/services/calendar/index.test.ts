import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { google, calendar_v3 } from "googleapis";
import { formatEventForList, registerCalendarTools } from "./index.js";

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

describe("calendar attendee schema (create/update)", () => {
  type Handler = (opts: Record<string, unknown>) => Promise<unknown>;
  const setup = async () => {
    const patch = vi.fn().mockResolvedValue({ data: { id: "evt1" } });
    vi.spyOn(google, "calendar").mockReturnValue({ events: { patch } } as never);
    const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
    const server = { tool: (name: string, _d: string, shape: z.ZodRawShape, handler: Handler) => { tools.set(name, { shape, handler }); } };
    registerCalendarTools(server as never, { auth: {} as never });
    return { patch, tools };
  };

  // Shape of calendar_get_event output (Google's raw attendee objects).
  const readAttendees = [
    { email: "a@example.com", displayName: "A", responseStatus: "accepted", self: true, organizer: true, id: "123" },
    { email: "b@example.com", optional: true, responseStatus: "needsAction", comment: "maybe", additionalGuests: 2 },
    { email: "room@example.com", resource: true, responseStatus: "accepted" },
  ];

  const forwarded = [
    { email: "a@example.com", displayName: "A" },
    { email: "b@example.com", optional: true },
    { email: "room@example.com", resource: true },
  ];

  it("update_event accepts get_event-shaped attendees and forwards only organizer-controlled fields", async () => {
    const { patch, tools } = await setup();
    const t = tools.get("calendar_update_event")!;
    const parsed = z.object(t.shape).parse({ calendarId: "primary", eventId: "evt1", attendees: readAttendees });
    await t.handler(parsed);
    expect(patch.mock.calls[0][0].requestBody.attendees).toEqual(forwarded);
  });

  it("update_event accepts optional on an attendee", async () => {
    const { patch, tools } = await setup();
    const t = tools.get("calendar_update_event")!;
    const parsed = z.object(t.shape).parse({ calendarId: "primary", eventId: "evt1", attendees: [{ email: "b@example.com", optional: true }] });
    await t.handler(parsed);
    expect(patch.mock.calls[0][0].requestBody.attendees).toEqual([{ email: "b@example.com", optional: true }]);
  });

  it("create_event and update_event share the same attendee schema", async () => {
    const { tools } = await setup();
    const c = z.object(tools.get("calendar_create_event")!.shape).shape.attendees;
    const u = z.object(tools.get("calendar_update_event")!.shape).shape.attendees;
    for (const sch of [c, u]) expect(sch.safeParse(readAttendees).success).toBe(true);
  });
});

describe("calendar_create_event attendee forwarding", () => {
  it("forwards only organizer-controlled attendee fields", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt1" } });
    vi.spyOn(google, "calendar").mockReturnValue({ events: { insert }, calendars: { get: vi.fn().mockResolvedValue({ data: { timeZone: "UTC" } }) } } as never);
    const tools = new Map<string, { shape: z.ZodRawShape; handler: (o: Record<string, unknown>) => Promise<unknown> }>();
    registerCalendarTools({ tool: (n: string, _d: string, shape: z.ZodRawShape, handler: never) => { tools.set(n, { shape, handler }); } } as never, { auth: {} as never });
    const t = tools.get("calendar_create_event")!;
    const parsed = z.object(t.shape).parse({
      calendarId: "primary", summary: "x", start: "2026-07-06T10:00:00Z", end: "2026-07-06T11:00:00Z",
      attendees: [{ email: "b@example.com", optional: true, responseStatus: "accepted", comment: "c", self: true }],
    });
    await t.handler(parsed);
    expect(insert.mock.calls[0][0].requestBody.attendees).toEqual([{ email: "b@example.com", optional: true }]);
  });
});
