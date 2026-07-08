/** Default env var read by --access-token-env when no name is given. */
export const DEFAULT_ACCESS_TOKEN_ENV_VAR = "GOOGLE_ACCESS_TOKEN";

/** The commander option values resolveAuthMode cares about. */
export interface RawCliOptions {
  slug?: string;
  tokenDir: string;
  /** `true` when --access-token-env is passed bare, the var name when given one, undefined when absent. */
  accessTokenEnv?: string | boolean;
}

export type AuthMode =
  | { mode: "credentials-file"; slug: string; tokenDir: string }
  | { mode: "env-token"; envVar: string; slug?: string };

/**
 * Decides between the two auth modes from parsed CLI options.
 *
 * - Default (no --access-token-env): the existing credentials-file mode.
 *   --slug stays required, exactly as before.
 * - --access-token-env [VAR]: hosted env-token mode. --slug becomes an
 *   optional label (used in error hints), and an explicit --token-dir is
 *   rejected — this mode never touches credentials on disk, so combining
 *   the two is a configuration mistake worth failing fast on.
 *
 * @param tokenDirSource commander's value source for --token-dir ("cli" when
 *   the flag was passed explicitly, "default" otherwise).
 */
export function resolveAuthMode(
  opts: RawCliOptions,
  tokenDirSource: string | undefined
): AuthMode {
  if (opts.accessTokenEnv !== undefined && opts.accessTokenEnv !== false) {
    if (tokenDirSource === "cli") {
      throw new Error(
        "option '--token-dir' cannot be used with '--access-token-env' (env-token mode never reads credentials from disk)"
      );
    }
    const envVar =
      typeof opts.accessTokenEnv === "string"
        ? opts.accessTokenEnv
        : DEFAULT_ACCESS_TOKEN_ENV_VAR;
    return { mode: "env-token", envVar, slug: opts.slug };
  }

  if (!opts.slug) {
    // Same message and exit path commander's requiredOption produced before
    // --slug became conditionally required.
    throw new Error("required option '--slug <slug>' not specified");
  }

  return { mode: "credentials-file", slug: opts.slug, tokenDir: opts.tokenDir };
}
