import { Credentials, OAuth2Client } from "google-auth-library";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface CredentialsFile {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token?: string;
  token_uri?: string;
  scopes?: string[];
  expiry_date?: number;
}

/**
 * Writes the refreshed access_token/expiry_date back to the per-account
 * credentials file, preserving every other field. Writes to a sibling temp
 * file and renames over the target so a crash mid-write can't corrupt the
 * credentials file (rename is atomic on the same filesystem).
 */
function persistTokens(credPath: string, tokens: Credentials): void {
  try {
    const raw = readFileSync(credPath, "utf-8");
    const creds: CredentialsFile = JSON.parse(raw);

    if (tokens.access_token) creds.token = tokens.access_token;
    if (tokens.expiry_date) creds.expiry_date = tokens.expiry_date;

    const tmpPath = `${credPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(creds, null, 2));
    renameSync(tmpPath, credPath);
  } catch (error) {
    console.error(`[google-mcp] Failed to persist refreshed tokens to ${credPath}:`, error);
  }
}

/**
 * Hosted / env-token mode: build an auth client from a ready-to-use access
 * token in the named environment variable. The host owns the token lifecycle
 * (refresh, persistence), so this client gets the bare token and nothing
 * else — no client id/secret, no refresh token, no "tokens" listener, and no
 * filesystem access of any kind. When the token expires mid-process the
 * Google API's 401 surfaces through the normal error mapping for the host to
 * classify; this process never attempts a refresh.
 */
export function loadEnvTokenAuth(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env
): OAuth2Client {
  const token = env[envVarName]?.trim();
  if (!token) {
    throw new Error(
      `Environment variable ${envVarName} is not set or empty. ` +
        `--access-token-env mode requires a ready-to-use Google access token in it.`
    );
  }

  const client = new OAuth2Client();
  client.setCredentials({ access_token: token });
  return client;
}

export function loadAuth(slug: string, tokenDir: string): OAuth2Client {
  const credPath = join(tokenDir, `google-${slug}-credentials.json`);

  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch {
    throw new Error(
      `Credentials file not found: ${credPath}\nRun add-google-account.sh to create it.`
    );
  }

  const creds: CredentialsFile = JSON.parse(raw);

  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
    throw new Error(
      `Credentials file missing required fields (client_id, client_secret, refresh_token): ${credPath}`
    );
  }

  const client = new OAuth2Client(creds.client_id, creds.client_secret);
  client.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.token || undefined,
    expiry_date: creds.expiry_date,
  });

  // The OAuth2Client refreshes access tokens in-memory as needed; without
  // this, every new process starts from the (possibly stale) token in the
  // credentials file and has to re-refresh, and any refresh made mid-session
  // would be lost. Persist it back so it's reused across processes.
  client.on("tokens", (tokens) => {
    persistTokens(credPath, tokens);
  });

  return client;
}
