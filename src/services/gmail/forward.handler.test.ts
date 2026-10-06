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

function decodeRaw(rawB64url: string): string {
  return Buffer.from(rawB64url, "base64url").toString("utf-8");
}

describe("gmail_forward_email attachments, threading, and size handling", () => {
  const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes for the handler test");
  const originalWithAttachment = {
    id: "m1",
    threadId: "t1",
    payload: {
      mimeType: "multipart/mixed",
      headers: original.payload.headers,
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Original body") } },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "att1", size: pdfBytes.byteLength },
        },
      ],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    gmailStub.users.drafts.create.mockResolvedValue({ data: { id: "d1", message: { id: "m2", threadId: "t1" } } });
    gmailStub.users.messages.send.mockResolvedValue({ data: { id: "m3", threadId: "t1" } });
  });

  it("fetches attachment bytes via attachments.get and includes them in the raw message", async () => {
    gmailStub.users.messages.get.mockResolvedValue({ data: originalWithAttachment });
    gmailStub.users.messages.attachments.get.mockResolvedValue({
      data: { data: pdfBytes.toString("base64url"), size: pdfBytes.byteLength },
    });

    const out = await forward({});
    expect(gmailStub.users.messages.attachments.get).toHaveBeenCalledWith({ userId: "me", messageId: "m1", id: "att1" });
    expect(out.draftId).toBe("d1");

    const raw = decodeRaw(gmailStub.users.drafts.create.mock.calls[0][0].requestBody.message.raw);
    const pdfBase64 = pdfBytes.toString("base64");
    expect(raw.replace(/\r\n/g, "")).toContain(pdfBase64);
  });

  it("refuses a too-large forward before fetching any attachment bytes, and never creates a draft or sends", async () => {
    const hugeOriginal = {
      ...originalWithAttachment,
      payload: {
        ...originalWithAttachment.payload,
        parts: [
          originalWithAttachment.payload.parts[0],
          { mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "att-huge", size: 20 * 1024 * 1024 } },
        ],
      },
    };
    gmailStub.users.messages.get.mockResolvedValue({ data: hugeOriginal });

    const out = await forward({});
    expect(out.error).toMatch(/too large to send/);
    expect(out.estimatedBytes).toBeGreaterThan(out.limitBytes);
    expect(gmailStub.users.messages.attachments.get).not.toHaveBeenCalled();
    expect(gmailStub.users.drafts.create).not.toHaveBeenCalled();
    expect(gmailStub.users.messages.send).not.toHaveBeenCalled();
  });

  it("passes the original message's threadId to drafts.create when asDraft is true", async () => {
    gmailStub.users.messages.get.mockResolvedValue({ data: original });
    const out = await forward({ asDraft: true });
    expect(out.threadId).toBe("t1");
    expect(gmailStub.users.drafts.create.mock.calls[0][0].requestBody.message.threadId).toBe("t1");
  });

  it("calls messages.send (not drafts.create) and passes threadId when asDraft is false", async () => {
    gmailStub.users.messages.get.mockResolvedValue({ data: original });
    const out = await forward({ asDraft: false });
    expect(gmailStub.users.drafts.create).not.toHaveBeenCalled();
    expect(gmailStub.users.messages.send).toHaveBeenCalledTimes(1);
    expect(gmailStub.users.messages.send.mock.calls[0][0].requestBody.threadId).toBe("t1");
    expect(out.id).toBe("m3");
    expect(out.threadId).toBe("t1");
  });
});
