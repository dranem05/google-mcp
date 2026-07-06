import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuth } from "./auth.js";

describe("loadAuth", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeCreds(extra: Record<string, unknown> = {}): string {
    dir = mkdtempSync(join(tmpdir(), "google-mcp-auth-test-"));
    const credPath = join(dir, "google-test-slug-credentials.json");
    writeFileSync(
      credPath,
      JSON.stringify({
        client_id: "client-id-123",
        client_secret: "client-secret-456",
        refresh_token: "refresh-token-789",
        token: "initial-access-token",
        token_uri: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        ...extra,
      })
    );
    return credPath;
  }

  it("loads credentials and sets expiry_date on the client when present in the file", () => {
    writeCreds({ expiry_date: 1750000000000 });

    const client = loadAuth("test-slug", dir!);

    expect(client.credentials.access_token).toBe("initial-access-token");
    expect(client.credentials.refresh_token).toBe("refresh-token-789");
    expect(client.credentials.expiry_date).toBe(1750000000000);
  });

  it("leaves expiry_date unset when absent from the file", () => {
    writeCreds();

    const client = loadAuth("test-slug", dir!);

    expect(client.credentials.expiry_date).toBeUndefined();
  });

  it("persists a refreshed access_token and expiry_date atomically on the 'tokens' event, preserving other fields", () => {
    const credPath = writeCreds({ expiry_date: 1111 });

    const client = loadAuth("test-slug", dir!);
    client.emit("tokens", { access_token: "refreshed-token", expiry_date: 2222222222222 });

    const written = JSON.parse(readFileSync(credPath, "utf-8"));
    expect(written.token).toBe("refreshed-token");
    expect(written.expiry_date).toBe(2222222222222);
    // Other fields preserved.
    expect(written.client_id).toBe("client-id-123");
    expect(written.client_secret).toBe("client-secret-456");
    expect(written.refresh_token).toBe("refresh-token-789");
    expect(written.token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(written.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
  });

  it("does not overwrite the credentials file with a partial tokens event missing an access_token", () => {
    const credPath = writeCreds({ expiry_date: 1111 });
    const client = loadAuth("test-slug", dir!);

    client.emit("tokens", { expiry_date: 3333 } as never);

    const written = JSON.parse(readFileSync(credPath, "utf-8"));
    expect(written.token).toBe("initial-access-token");
    expect(written.expiry_date).toBe(3333);
  });
});
