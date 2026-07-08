import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnvTokenAuth } from "./auth.js";

// Env-token mode must NEVER touch the filesystem: no credentials file read,
// no refreshed-token writeback. Replace the fs functions auth.ts uses with
// spies that fail loudly if called. (google-auth-library is externalized by
// vitest, so this mock only intercepts our own source files — exactly the
// boundary we want to assert on.)
const fsSpies = vi.hoisted(() => ({
  readFileSync: vi.fn(() => {
    throw new Error("fs.readFileSync must not be called in env-token mode");
  }),
  writeFileSync: vi.fn(() => {
    throw new Error("fs.writeFileSync must not be called in env-token mode");
  }),
  renameSync: vi.fn(() => {
    throw new Error("fs.renameSync must not be called in env-token mode");
  }),
}));

vi.mock("node:fs", () => fsSpies);

describe("loadEnvTokenAuth", () => {
  beforeEach(() => {
    fsSpies.readFileSync.mockClear();
    fsSpies.writeFileSync.mockClear();
    fsSpies.renameSync.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a client from the named env var with the access token only", () => {
    const client = loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN", {
      GOOGLE_ACCESS_TOKEN: "ya29.test-access-token",
    });

    expect(client.credentials.access_token).toBe("ya29.test-access-token");
    // No refresh material of any kind: the host owns refresh.
    expect(client.credentials.refresh_token).toBeUndefined();
    expect(client.credentials.expiry_date).toBeUndefined();
    // No OAuth client id/secret — this client cannot refresh even by accident.
    expect(client._clientId).toBeUndefined();
    expect(client._clientSecret).toBeUndefined();
    // No writeback listener (credentials-file mode installs one).
    expect(client.listenerCount("tokens")).toBe(0);
  });

  it("reads the token from a custom env var name", () => {
    const client = loadEnvTokenAuth("MC_GOOGLE_TOKEN", {
      MC_GOOGLE_TOKEN: "custom-var-token",
      GOOGLE_ACCESS_TOKEN: "wrong-token",
    });

    expect(client.credentials.access_token).toBe("custom-var-token");
  });

  it("defaults to process.env when no env object is passed", () => {
    vi.stubEnv("GOOGLE_ACCESS_TOKEN", "from-process-env");

    const client = loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN");

    expect(client.credentials.access_token).toBe("from-process-env");
  });

  it("fails fast, naming the variable, when it is unset", () => {
    expect(() => loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN", {})).toThrow(
      /GOOGLE_ACCESS_TOKEN/
    );
  });

  it("fails fast when the variable is empty or whitespace", () => {
    expect(() => loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN", { GOOGLE_ACCESS_TOKEN: "" })).toThrow(
      /GOOGLE_ACCESS_TOKEN/
    );
    expect(() =>
      loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN", { GOOGLE_ACCESS_TOKEN: "   " })
    ).toThrow(/GOOGLE_ACCESS_TOKEN/);
  });

  it("never reads or writes the filesystem", () => {
    loadEnvTokenAuth("GOOGLE_ACCESS_TOKEN", { GOOGLE_ACCESS_TOKEN: "tok" });

    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
    expect(fsSpies.writeFileSync).not.toHaveBeenCalled();
    expect(fsSpies.renameSync).not.toHaveBeenCalled();
  });
});
