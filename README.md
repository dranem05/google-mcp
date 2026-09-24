# google-mcp

A consolidated Google Workspace [MCP](https://modelcontextprotocol.io/) server: Gmail, Calendar, Meet, Drive, Docs, Sheets, and Slides tools in a single stdio process. Written in TypeScript against the official `googleapis` client.

## Process model: one process per account

Each running server is bound to exactly one Google account, selected with `--slug`:

```sh
google-mcp --slug jane-acme-com [--token-dir <dir>]
```

- Credentials are read from `<token-dir>/google-<slug>-credentials.json`; `--token-dir` defaults to `~/.config/openbrain/tokens`, so the usual path is `~/.config/openbrain/tokens/google-<slug>-credentials.json`.
- The credentials file holds the OAuth client id/secret and a refresh token. Refreshed access tokens are automatically persisted back to the file (atomic tmp-file + rename), so new processes reuse them instead of re-refreshing.
- In practice these processes are launched by **openbrain's `google-mcp.sh`**, one per configured account.

### Adding an account

Accounts are provisioned by `bootstrap/lib/add-google-account.sh`, which lives in the **external openbrain repo** (not in this repository). It runs the OAuth consent flow and writes the credentials file for the slug. Re-run it for an existing slug to grant newly required scopes (error messages from this server reference it when a refresh token has expired or been revoked).

### Hosted / env-token mode

For hosts that own token custody themselves (e.g. a hosted runtime that decrypts a per-connection OAuth bundle and refreshes tokens centrally), the server can instead take a ready-to-use access token from an environment variable:

```sh
GOOGLE_ACCESS_TOKEN=ya29... google-mcp --access-token-env            # reads GOOGLE_ACCESS_TOKEN
MY_TOKEN_VAR=ya29...       google-mcp --access-token-env MY_TOKEN_VAR
```

- The token is read once at startup and used for the life of the process. **Refresh is the host's job** — there is no refresh token, no OAuth client id/secret, and on a 401 the readable API error is surfaced for the host to classify; the server never attempts a refresh.
- **Nothing touches disk**: no credentials file is read and no token writeback of any kind happens.
- The flag is mutually exclusive with an explicit `--token-dir`. `--slug` becomes optional and, when given, is only used as an account label in error hints.
- Startup fails fast with a clear error naming the variable if it is unset or empty.

## Tool families

| Family | Prefix | What it covers |
|---|---|---|
| Gmail | `gmail_*` | Search/read/send/reply (threaded, with attachments), threads, drafts, labels, filters, vacation responder, profile, signature |
| Calendar | `calendar_*` | List/create/update/respond to events, recurring-event instances, free/busy, propose meeting times, Meet links on events, out-of-office/working-location events |
| Meet | `meet_*` | Create standalone Meet spaces, list conference records, fetch transcripts |
| Drive | `drive_*` | List/search/move/copy/rename/delete, folder management, download/upload, sharing and permissions |
| Docs | `docs_*` | Read/write Google Docs (native markdown in/out), text styling, tables, tabs, comments |
| Sheets | `sheets_*` | Read/write values (single, batch, append), sheet/tab management, formatting, borders/merges, charts, find/replace, named ranges |
| Slides | `slides_*` | Create/edit presentations, slides, text/shapes/images, styling, PDF export, thumbnails |

By default every family registers. `--families gmail,calendar` restricts the server to just the listed families (valid names: `gmail`, `calendar`, `meet`, `drive`, `docs`, `sheets`, `slides`); an unknown name fails startup with an error listing the valid ones. Works in both auth modes.

## Operational defaults

- **Compact output** — tool results are unindented JSON; responses are pruned to the fields a model actually needs (list views trim heavyweight nested objects).
- **Size caps** — `docs_read_document` caps output at 50k characters (raise via `maxLength`); Gmail message bodies are capped at 50k characters with a truncation note; Sheets reads fail loudly past a 10,000-cell cap (narrow the range and retry); Gmail attachment downloads over 2 MB are written to disk instead of returned inline (Drive downloads inline up to 10 MB).
- **Pagination** — list-style tools accept a `pageToken` and return a `nextPageToken` when more results exist; tools that fan out to multiple underlying lists use a single composite token with the same contract.
- **Retries** — every Google API call retries 429s and 5xx errors up to 3 times globally, honoring the server's `Retry-After` header.
- **Error mapping** — all tool handlers are wrapped centrally; Google API failures come back as readable errors (HTTP status + API message) with hints for expired auth and quota problems.
- **Token persistence** — refreshed access tokens are written back to the per-account credentials file automatically.
- **Downloads** — files fetched to disk land in a shared temp cache (`$TMPDIR/google-mcp`) that is swept of entries older than 24h.

### Gmail notes

- `gmail_get_signature` reads the real signature configured in Gmail's UI (Settings > General > Signature) via `users.settings.sendAs.list`, and returns the HTML **verbatim** — it does not reconstruct or reformat it. `gmail_draft_email`/`gmail_send_email` do not inject the signature automatically (the Gmail API only sends the MIME it's given; the web/app UI normally adds the signature client-side), so fetch it with this tool first for anything that should carry it.
- **Scope:** `sendAs.list` works with the existing `gmail.modify` grant — **no additional scope is required.** Verified live 2026-09-09 against a token whose recorded scopes contain no `gmail.settings.basic`: the endpoint returned HTTP 200 and the full signature HTML. Google enforces this endpoint more loosely than its reference docs suggest, which document `gmail.settings.basic`. The insufficient-scope handling in this tool is kept as defensive cover in case that enforcement tightens; it is not a condition anyone is expected to hit today.

### Meet notes

- `meet_create_link` creates a **standalone Meet space** via the Meet REST API v2 (`spaces.create`) — nothing is placed on the calendar. For a titled, scheduled meeting use `calendar_create_event` (with `conferenceData`) or `calendar_add_meet_link`.
- **Scope requirement:** `spaces.create` needs the `https://www.googleapis.com/auth/meetings.space.created` OAuth scope. **Existing accounts were authorized before this scope was requested and currently get `403 — Request had insufficient authentication scopes` from `meet_create_link`** (verified live). Re-run `add-google-account.sh` (external openbrain repo) for the account slug to re-consent with the new scope.
- Conference records and transcripts require Google Workspace (transcripts: Business Standard or higher).

## Development

```sh
npm install
npm run build     # tsc -> dist/
npm test          # vitest run
npm run dev       # tsx src/index.ts (needs --slug)
```

CI runs `tsc --noEmit` and the vitest suite on every push/PR.
