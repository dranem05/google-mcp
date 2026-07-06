import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/** Shared scratch directory for tools that write downloaded content to disk. */
export const DOWNLOAD_CACHE_DIR = join(tmpdir(), "google-mcp");
const DOWNLOAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Sweeps the cache dir of files older than DOWNLOAD_CACHE_TTL_MS. */
async function sweepStaleDownloads(): Promise<void> {
  const entries = await readdir(DOWNLOAD_CACHE_DIR);
  const cutoff = Date.now() - DOWNLOAD_CACHE_TTL_MS;
  // Sequential sweep keeps file-descriptor and IO pressure bounded even
  // when the cache dir has accumulated many entries.
  for (const entry of entries) {
    const path = join(DOWNLOAD_CACHE_DIR, entry);
    try {
      const s = await stat(path);
      if (s.isFile() && s.mtimeMs < cutoff) await unlink(path);
    } catch {
      // Entry was removed concurrently or otherwise inaccessible. Ignore.
    }
  }
}

// One-shot initialization of the cache dir: ensures the directory exists
// and runs an initial sweep. Subsequent downloads re-run the sweep at most
// once per DOWNLOAD_CACHE_TTL_MS interval (lastSweepAt), so a long-running
// process doesn't get stuck on the first sweep forever. If init fails, the
// cached promise is cleared so the next call can retry.
let cacheInitPromise: Promise<void> | null = null;
let lastSweepAt = 0;

/**
 * Ensures the shared cache dir exists and has had at least one stale-file
 * sweep. Safe to call before every disk-mode download; only does real work
 * once per process (until maybePeriodicSweep() decides a re-sweep is due).
 */
export function ensureCacheInitialized(): Promise<void> {
  if (cacheInitPromise) return cacheInitPromise;
  cacheInitPromise = (async () => {
    await mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
    await sweepStaleDownloads();
    lastSweepAt = Date.now();
  })().catch((err) => {
    cacheInitPromise = null;
    throw err;
  });
  return cacheInitPromise;
}

/**
 * Fire-and-forget re-sweep if more than DOWNLOAD_CACHE_TTL_MS has passed
 * since the last one. Never blocks a download.
 */
export function maybePeriodicSweep(): void {
  if (Date.now() - lastSweepAt < DOWNLOAD_CACHE_TTL_MS) return;
  lastSweepAt = Date.now(); // optimistic: prevents concurrent re-entry
  sweepStaleDownloads().catch(() => {
    // Best-effort; an error here is non-fatal for downloads.
  });
}

export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/** Builds a collision-resistant path in the shared cache dir for `baseName.ext`. */
export function cachePath(baseName: string, ext: string): string {
  const suffix = randomBytes(4).toString("hex");
  return join(DOWNLOAD_CACHE_DIR, `${safeFileName(baseName)}-${Date.now()}-${suffix}.${ext}`);
}
