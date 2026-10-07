import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  users: {
    getProfile: vi.fn(),
    settings: { sendAs: { list: vi.fn() } },
    messages: { get: vi.fn(), send: vi.fn() },
    drafts: { create: vi.fn() },
  },
};

vi.mock("googleapis", () => ({ google: { gmail: () => api } }));

import { registerGmailTools } from "./index.js";
import { decodeBase64UrlToBuffer } from "../../utils/email.js";

type Handler = (opts: Record<string, unknown>) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _d: string, _s: unknown, h: Handler) => void handlers.set(name, h),
};
registerGmailTools(fakeServer as never, { auth: {} as never });

const sendAs = [
  { sendAsEmail: "primary@example.com", displayName: "Primary", isDefault: true },
  { sendAsEmail: "ops@example.com", displayName: "Doe, Jane", verificationStatus: "accepted" },
];

function rawOf(call: { requestBody?: { raw?: string; message?: { raw?: string } } }): string {
  const raw = call.requestBody?.raw ?? call.requestBody?.message?.raw;
  return decodeBase64UrlToBuffer(raw!).toString("utf-8");
}

beforeEach(() => {
  vi.clearAllMocks();
  api.users.settings.sendAs.list.mockResolvedValue({ data: { sendAs } });
  api.users.getProfile.mockResolvedValue({ data: { emailAddress: "primary@example.com" } });
  api.users.messages.send.mockResolvedValue({ data: { id: "m1", threadId: "t1" } });
  api.users.drafts.create.mockResolvedValue({ data: { id: "d1", message: { id: "m1" } } });
  api.users.messages.get.mockResolvedValue({
    data: {
      threadId: "t1",
      payload: {
        headers: [
          { name: "Message-ID", value: "<m@x>" },
          { name: "Subject", value: "Hi" },
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "primary@example.com, ops@example.com, carol@example.com" },
        ],
      },
    },
  });
});

const base = { to: ["a@example.com"], subject: "S", body: "B", mimeType: "text/plain" };

describe("from wiring", () => {
  it("send puts the resolved From in the raw message", async () => {
    await handlers.get("gmail_send_email")!({ ...base, from: "ops@example.com" });
    expect(rawOf(api.users.messages.send.mock.calls[0][0])).toContain('From: "Doe, Jane" <ops@example.com>');
  });

  it("draft puts the resolved From in the raw message", async () => {
    await handlers.get("gmail_draft_email")!({ ...base, from: "ops@example.com" });
    expect(rawOf(api.users.drafts.create.mock.calls[0][0])).toContain('From: "Doe, Jane" <ops@example.com>');
  });

  it("reply puts the resolved From in the raw message", async () => {
    await handlers.get("gmail_reply_to_email")!({ messageId: "x", body: "B", mimeType: "text/plain", from: "ops@example.com" });
    expect(rawOf(api.users.messages.send.mock.calls[0][0])).toContain('From: "Doe, Jane" <ops@example.com>');
  });

  it("reply-all from an alias CCs neither the alias nor the primary", async () => {
    await handlers.get("gmail_reply_to_email")!({ messageId: "x", body: "B", mimeType: "text/plain", replyAll: true, from: "ops@example.com" });
    const raw = rawOf(api.users.messages.send.mock.calls[0][0]);
    expect(raw).toMatch(/^Cc: carol@example\.com\r?$/m);
  });

  it("does not call sendAs.list or emit From when `from` is omitted", async () => {
    await handlers.get("gmail_send_email")!({ ...base });
    await handlers.get("gmail_draft_email")!({ ...base });
    await handlers.get("gmail_reply_to_email")!({ messageId: "x", body: "B", mimeType: "text/plain" });
    expect(api.users.settings.sendAs.list).not.toHaveBeenCalled();
    for (const c of [...api.users.messages.send.mock.calls, ...api.users.drafts.create.mock.calls]) {
      expect(rawOf(c[0])).not.toMatch(/^From:/m);
    }
  });
});
