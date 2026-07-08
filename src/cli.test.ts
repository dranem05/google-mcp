import { describe, expect, it } from "vitest";
import { DEFAULT_ACCESS_TOKEN_ENV_VAR, resolveAuthMode } from "./cli.js";

describe("resolveAuthMode", () => {
  const tokenDir = "/home/user/.config/openbrain/tokens";

  it("selects credentials-file mode when --access-token-env is absent", () => {
    const mode = resolveAuthMode({ slug: "jane-acme-com", tokenDir }, "default");

    expect(mode).toEqual({
      mode: "credentials-file",
      slug: "jane-acme-com",
      tokenDir,
    });
  });

  it("still requires --slug in credentials-file mode", () => {
    expect(() => resolveAuthMode({ tokenDir }, "default")).toThrow(
      "required option '--slug <slug>' not specified"
    );
  });

  it("selects env-token mode with the default variable when the flag is bare", () => {
    const mode = resolveAuthMode({ tokenDir, accessTokenEnv: true }, "default");

    expect(mode).toEqual({
      mode: "env-token",
      envVar: DEFAULT_ACCESS_TOKEN_ENV_VAR,
      slug: undefined,
    });
    expect(DEFAULT_ACCESS_TOKEN_ENV_VAR).toBe("GOOGLE_ACCESS_TOKEN");
  });

  it("uses the named variable when one is given", () => {
    const mode = resolveAuthMode(
      { tokenDir, accessTokenEnv: "MC_GOOGLE_TOKEN" },
      "default"
    );

    expect(mode).toEqual({ mode: "env-token", envVar: "MC_GOOGLE_TOKEN", slug: undefined });
  });

  it("does not require --slug in env-token mode but passes it through as a label when given", () => {
    const mode = resolveAuthMode(
      { slug: "jane-acme-com", tokenDir, accessTokenEnv: true },
      "default"
    );

    expect(mode).toEqual({
      mode: "env-token",
      envVar: DEFAULT_ACCESS_TOKEN_ENV_VAR,
      slug: "jane-acme-com",
    });
  });

  it("rejects an explicit --token-dir combined with --access-token-env", () => {
    expect(() =>
      resolveAuthMode({ tokenDir: "/explicit/dir", accessTokenEnv: true }, "cli")
    ).toThrow(/--token-dir.*--access-token-env|--access-token-env.*--token-dir/);
  });

  it("ignores the default token-dir value in env-token mode (only an explicit flag conflicts)", () => {
    const mode = resolveAuthMode({ tokenDir, accessTokenEnv: true }, "default");

    expect(mode.mode).toBe("env-token");
  });
});
