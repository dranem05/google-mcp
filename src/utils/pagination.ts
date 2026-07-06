/**
 * Some tools fan out to more than one underlying `list` call per invocation
 * (e.g. drive_list_folder_contents lists folders and files separately) but
 * still need to expose a single opaque `pageToken` in/`nextPageToken` out
 * pair to the caller. These helpers pack/unpack multiple named sub-cursors
 * into one base64url token string.
 *
 * Encoding returns undefined when every sub-cursor is absent, so callers can
 * assign the result straight to `nextPageToken` (undefined = no more pages).
 * Decoding never throws: a missing/invalid/foreign token decodes to `{}`, so
 * every sub-list naturally starts from the beginning rather than erroring.
 */
export function encodeCompositePageToken(parts: Record<string, string | undefined>): string | undefined {
  const present = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
  if (Object.keys(present).length === 0) return undefined;
  return Buffer.from(JSON.stringify(present), "utf-8").toString("base64url");
}

export function decodeCompositePageToken(token: string | undefined): Record<string, string | undefined> {
  if (!token) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | undefined>;
    }
    return {};
  } catch {
    return {};
  }
}
