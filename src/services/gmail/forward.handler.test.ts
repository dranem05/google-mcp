import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the googleapis Gmail client so the real gmail_forward_email handler runs
// against canned responses — no network, no credentials.
const gmailStub = {
  users: {
    messages: { get: vi.fn(), send: vi.fn(), attachments: { get: vi.fn() } },
    drafts: { create: vi.fn() },
    settings: { sendAs: { list: vi.fn() } },
  },
};
vi.mock("googleapis", () => ({ google: { gmail: () => gmailStub } }));

const { registerGmailTools } = await import("./index.js");

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

const original = {
  id: "m1",
  threadId: "t1",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Jane Doe <jane@example.com>" },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 5 Oct 2026 10:00:00 +0000" },
      { name: "Message-ID", value: "<abc@example.com>" },
    ],
    body: { data: b64url("Original body") },
  },
};

function forwardHandler() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as never) };
  registerGmailTools(server as never, { auth: {} } as never);
  return handlers.get("gmail_forward_email")!;
}

async function forward(params: Record<string, unknown>) {
  const res = (await forwardHandler()({ messageId: "m1", to: ["bob@example.com"], includeAttachments: true, includeSignature: true, asDraft: true, ...params })) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
}

describe("gmail_forward_email signature handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gmailStub.users.messages.get.mockResolvedValue({ data: original });
    gmailStub.users.drafts.create.mockResolvedValue({ data: { id: "d1", message: { id: "m2", threadId: "t1" } } });
  });

  it("still drafts the forward but reports a warning when the signature lookup fails", async () => {
    gmailStub.users.settings.sendAs.list.mockRejectedValue(new Error("Insufficient Permission"));
    const out = await forward({});
    expect(out.draftId).toBe("d1");
    expect(out.warning).toMatch(/Signature omitted.*Insufficient Permission/);
  });

  it("reports no warning when the signature lookup succeeds", async () => {
    gmailStub.users.settings.sendAs.list.mockResolvedValue({ data: { sendAs: [{ sendAsEmail: "me@example.com", isDefault: true, signature: "<b>Me</b>" }] } });
    const out = await forward({});
    expect(out.draftId).toBe("d1");
    expect(out.warning).toBeUndefined();
  });

  it("reports no warning when includeSignature is false", async () => {
    const out = await forward({ includeSignature: false });
    expect(gmailStub.users.settings.sendAs.list).not.toHaveBeenCalled();
    expect(out.warning).toBeUndefined();
  });
});
