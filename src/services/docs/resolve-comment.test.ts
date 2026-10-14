import { describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocsTools } from "./index.js";

const driveApiMock = {
  comments: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  replies: {
    create: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("googleapis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("googleapis")>();
  return {
    ...actual,
    google: {
      ...actual.google,
      docs: vi.fn(() => ({})),
      drive: vi.fn(() => driveApiMock),
    },
  };
});

/** Gets a registered tool's handler directly from the McpServer's internal registry. */
function toolCallback(server: McpServer, name: string): (args: unknown) => unknown {
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => unknown }> })
    ._registeredTools[name].handler;
}

describe("docs_resolve_comment", () => {
  function makeServer() {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDocsTools(server, { auth: new OAuth2Client(), accountSlug: "test-slug" });
    return server;
  }

  it("resolves via replies.create with action: resolve, not comments.update", async () => {
    driveApiMock.replies.create.mockResolvedValueOnce({
      data: { id: "reply1", action: "resolve", createdTime: "2026-01-01T00:00:00Z" },
    });
    const server = makeServer();
    const result = await toolCallback(server, "docs_resolve_comment")({
      documentId: "doc1",
      commentId: "comment1",
    });

    expect(driveApiMock.replies.create).toHaveBeenCalledWith({
      fileId: "doc1",
      commentId: "comment1",
      fields: "id,action,author,createdTime",
      requestBody: { action: "resolve" },
    });
    expect(driveApiMock.comments.update).not.toHaveBeenCalled();
    expect(JSON.parse((result as { content: [{ text: string }] }).content[0].text)).toEqual({
      commentId: "comment1",
      resolved: true,
      replyId: "reply1",
    });
  });

  it("includes an optional closing note in the resolving reply", async () => {
    driveApiMock.replies.create.mockResolvedValueOnce({
      data: { id: "reply2", action: "resolve" },
    });
    const server = makeServer();
    await toolCallback(server, "docs_resolve_comment")({
      documentId: "doc1",
      commentId: "comment1",
      content: "Looks good, closing this out.",
    });

    expect(driveApiMock.replies.create).toHaveBeenCalledWith({
      fileId: "doc1",
      commentId: "comment1",
      fields: "id,action,author,createdTime",
      requestBody: { action: "resolve", content: "Looks good, closing this out." },
    });
  });
});
