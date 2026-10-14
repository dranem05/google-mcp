import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { google } from "googleapis";
import { registerCalendarTools } from "./index.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("calendar_update_event removeConference", () => {
  type Handler = (opts: Record<string, unknown>) => Promise<unknown>;
  const setup = () => {
    const patch = vi.fn().mockResolvedValue({ data: { id: "evt1" } });
    vi.spyOn(google, "calendar").mockReturnValue({ events: { patch } } as never);
    const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
    const server = { tool: (name: string, _d: string, shape: z.ZodRawShape, handler: Handler) => { tools.set(name, { shape, handler }); } };
    registerCalendarTools(server as never, { auth: {} as never });
    const t = tools.get("calendar_update_event")!;
    const run = (args: Record<string, unknown>) => t.handler(z.object(t.shape).parse({ calendarId: "primary", eventId: "evt1", ...args }));
    return { patch, run };
  };

  it("removeConference sends conferenceData null with conferenceDataVersion 1", async () => {
    const { patch, run } = setup();
    await run({ removeConference: true });
    const arg = patch.mock.calls[0][0];
    expect(arg.conferenceDataVersion).toBe(1);
    expect(arg.requestBody).toHaveProperty("conferenceData", null);
    // JSON keeps the null, so it reaches the API and clears the field.
    expect(JSON.parse(JSON.stringify(arg.requestBody))).toEqual({ conferenceData: null });
  });

  it("omitting removeConference sends neither conferenceData nor conferenceDataVersion", async () => {
    const { patch, run } = setup();
    await run({ summary: "Renamed" });
    const arg = patch.mock.calls[0][0];
    expect(arg.conferenceDataVersion).toBeUndefined();
    expect(arg.requestBody).toEqual({ summary: "Renamed" });
    expect("conferenceData" in arg.requestBody).toBe(false);
  });

  it("removeConference: false is a no-op", async () => {
    const { patch, run } = setup();
    await run({ summary: "Renamed", removeConference: false });
    const arg = patch.mock.calls[0][0];
    expect(arg.conferenceDataVersion).toBeUndefined();
    expect("conferenceData" in arg.requestBody).toBe(false);
  });

  it("removeConference combines with other field updates", async () => {
    const { patch, run } = setup();
    await run({ summary: "Renamed", removeConference: true });
    expect(patch.mock.calls[0][0].requestBody).toEqual({ summary: "Renamed", conferenceData: null });
  });
});
