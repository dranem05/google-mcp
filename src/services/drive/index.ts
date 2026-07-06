import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult, mimeShortcut } from "../../utils/formatting.js";
import { escapeDriveQueryValue } from "../../utils/drive-query.js";
import { decodeCompositePageToken, encodeCompositePageToken } from "../../utils/pagination.js";

import { drive_v3 } from "googleapis";
import { writeFile, stat, unlink } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ensureCacheInitialized, maybePeriodicSweep, cachePath } from "../../utils/download-cache.js";

// Minimal extension -> MIME map for uploads when the caller doesn't specify one.
const UPLOAD_EXT_TO_MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
  ".json": "application/json", ".xml": "application/xml", ".pdf": "application/pdf",
  ".zip": "application/zip", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Hard cap for inline (returnContent=true) downloads to keep tool responses
// from blowing past MCP/LLM context budgets and to avoid OOM. Callers that
// need larger payloads should use the default disk mode.
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Output MIME types we treat as text in inline mode. Everything else is
// returned as base64 to avoid corrupting binary bytes through UTF-8.
// Workspace files can be exported as text (markdown/csv/html) OR as
// binary (PDF/DOCX/XLSX), so the source format doesn't determine
// encoding — the OUTPUT MIME does.
//
// Covers text/* (markdown, plain, csv, html, xml, etc.), structured
// data formats commonly served as text (json, xml, javascript, sql,
// yaml), and any structured suffix (+json, +xml, +yaml). When unsure,
// we fall through to base64 — a base64-wrapped text payload is
// recoverable, but a UTF-8-decoded binary is corrupted.
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/sql",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
  "application/x-www-form-urlencoded",
]);
function isTextMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime)) return true;
  // Structured suffixes like application/atom+xml, application/ld+json.
  return /\+(?:json|xml|yaml)$/.test(mime);
}

const MIME_TO_EXT: Record<string, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/rtf": "rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

function extensionFor(mime: string | null | undefined): string {
  if (!mime) return "bin";
  return MIME_TO_EXT[mime] || mime.split("/").pop()?.split(".").pop() || "bin";
}

// Field mask shared by the Drive `list` calls below and by
// formatFileForList: list-style responses are pruned down to the minimum
// useful set (owner display name and webViewLink cost real tokens across
// dozens/hundreds of list rows and are rarely needed until a caller drills
// into one specific file).
const LIST_FIELD_MASK = "id,name,mimeType,modifiedTime,size,parents";

export function formatFileForList(f: drive_v3.Schema$File): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size,
    parents: f.parents,
  };
}

export function registerDriveTools(server: McpServer, ctx: ServiceContext): void {
  const api = google.drive({ version: "v3", auth: ctx.auth });

  server.tool("drive_list_files", "List files in Drive with optional filtering", {
    folderId: z.string().optional().describe("Folder ID to list. Use 'root' for top-level."),
    mimeType: z.string().optional().describe("Filter by MIME type. Shortcuts: document, spreadsheet, presentation, folder, pdf, zip"),
    maxResults: z.number().optional().default(20),
    orderBy: z.enum(["name", "modifiedTime", "createdTime", "quotaBytesUsed"]).optional().default("modifiedTime"),
    sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
    ownedByMe: z.boolean().optional(),
    modifiedAfter: z.string().optional().describe("ISO 8601 date filter"),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ folderId, mimeType, maxResults, orderBy, sortDirection, ownedByMe, modifiedAfter, pageToken }) => {
    const qParts: string[] = ["trashed = false"];
    if (folderId) qParts.push(`'${escapeDriveQueryValue(folderId)}' in parents`);
    if (mimeType) qParts.push(`mimeType = '${escapeDriveQueryValue(mimeShortcut(mimeType))}'`);
    if (ownedByMe) qParts.push("'me' in owners");
    if (modifiedAfter) qParts.push(`modifiedTime > '${escapeDriveQueryValue(modifiedAfter)}'`);

    const order = `${orderBy} ${sortDirection === "asc" ? "" : "desc"}`.trim();
    const res = await api.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: qParts.join(" and "),
      pageSize: maxResults,
      pageToken,
      orderBy: order,
      fields: `nextPageToken,files(${LIST_FIELD_MASK})`,
    });
    return textResult({
      files: res.data.files?.map(formatFileForList) || [],
      total: res.data.files?.length || 0,
      hasMore: !!res.data.nextPageToken,
      nextPageToken: res.data.nextPageToken,
    });
  });

  server.tool("drive_list_folder_contents", "List files and subfolders in a Drive folder", {
    folderId: z.string().describe("Folder ID. Use 'root' for top-level."),
    includeFiles: z.boolean().optional().default(true),
    includeSubfolders: z.boolean().optional().default(true),
    maxResults: z.number().optional().default(50),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ folderId, includeFiles, includeSubfolders, maxResults, pageToken }) => {
    const drive = api;
    const { folders: folderToken, files: fileToken } = decodeCompositePageToken(pageToken);

    // The folder and file listings are two independent Drive queries with no
    // data dependency between them — run them concurrently instead of
    // serially awaiting one after the other.
    const [folderRes, fileRes] = await Promise.all([
      includeSubfolders
        ? drive.files.list({
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            q: `'${escapeDriveQueryValue(folderId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            pageSize: maxResults,
            pageToken: folderToken,
            orderBy: "name",
            fields: `nextPageToken,files(${LIST_FIELD_MASK})`,
          })
        : undefined,
      includeFiles
        ? drive.files.list({
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            q: `'${escapeDriveQueryValue(folderId)}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
            pageSize: maxResults,
            pageToken: fileToken,
            orderBy: "name",
            fields: `nextPageToken,files(${LIST_FIELD_MASK})`,
          })
        : undefined,
    ]);

    const folders = (folderRes?.data.files || []).map(formatFileForList);
    const files = (fileRes?.data.files || []).map(formatFileForList);
    const nextPageToken = encodeCompositePageToken({
      folders: folderRes?.data.nextPageToken ?? undefined,
      files: fileRes?.data.nextPageToken ?? undefined,
    });

    return textResult({ folders, files, nextPageToken });
  });

  server.tool("drive_search_files", "Search Drive by name or content", {
    query: z.string().describe("Search term"),
    searchIn: z.enum(["name", "content", "both"]).optional().default("both"),
    folderId: z.string().optional(),
    mimeType: z.string().optional(),
    maxResults: z.number().optional().default(10),
    orderBy: z.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime"),
    sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
    modifiedAfter: z.string().optional(),
    pageToken: z.string().optional(),
  }, async ({ query, searchIn, folderId, mimeType, maxResults, orderBy, sortDirection, modifiedAfter, pageToken }) => {
    const qParts: string[] = ["trashed = false"];
    const escapedQuery = escapeDriveQueryValue(query);
    if (searchIn === "name") qParts.push(`name contains '${escapedQuery}'`);
    else if (searchIn === "content") qParts.push(`fullText contains '${escapedQuery}'`);
    else qParts.push(`(name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`);
    if (folderId) qParts.push(`'${escapeDriveQueryValue(folderId)}' in parents`);
    if (mimeType) qParts.push(`mimeType = '${escapeDriveQueryValue(mimeShortcut(mimeType))}'`);
    if (modifiedAfter) qParts.push(`modifiedTime > '${escapeDriveQueryValue(modifiedAfter)}'`);

    const res = await api.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: qParts.join(" and "),
      pageSize: maxResults,
      pageToken,
      orderBy: `${orderBy} ${sortDirection === "asc" ? "" : "desc"}`.trim(),
      fields: `nextPageToken,files(${LIST_FIELD_MASK})`,
    });

    return textResult({
      files: res.data.files?.map(formatFileForList) || [],
      total: res.data.files?.length || 0,
      hasMore: !!res.data.nextPageToken,
      nextPageToken: res.data.nextPageToken,
    });
  });

  server.tool("drive_move_file", "Move a file to a different folder", {
    fileId: z.string(),
    newParentId: z.string().describe("Destination folder ID. Use 'root' for top-level."),
    removeFromAllParents: z.boolean().optional().default(false).describe("Remove the file from all current parents. Always treated as true for Shared Drive items, which can only have one parent."),
  }, async ({ fileId, newParentId, removeFromAllParents }) => {
    const drive = api;
    // Always fetch parents + driveId. Shared Drive items can only have one
    // parent, so adding a new parent without removing the existing one
    // will fail. Force-remove existing parents on Shared Drive items.
    const file = await drive.files.get({
      supportsAllDrives: true,
      fileId,
      fields: "parents,driveId",
    });
    const isSharedDrive = !!file.data.driveId;
    let removeParents: string | undefined;
    if (removeFromAllParents || isSharedDrive) {
      removeParents = file.data.parents?.join(",");
    }
    const res = await drive.files.update({
      supportsAllDrives: true,
      fileId,
      addParents: newParentId,
      removeParents,
      fields: "id,name,parents",
    });
    return textResult({ id: res.data.id, name: res.data.name, message: `Moved to ${newParentId}` });
  });

  server.tool("drive_copy_file", "Copy a file", {
    fileId: z.string(),
    name: z.string().optional().describe("Name for the copy"),
    parentId: z.string().optional().describe("Destination folder ID"),
  }, async ({ fileId, name, parentId }) => {
    const res = await api.files.copy({
      supportsAllDrives: true,
      fileId,
      requestBody: { name, parents: parentId ? [parentId] : undefined },
      fields: "id,name,webViewLink",
    });
    return textResult({ id: res.data.id, name: res.data.name, url: res.data.webViewLink });
  });

  server.tool("drive_rename_file", "Rename a file", {
    fileId: z.string(),
    newName: z.string(),
  }, async ({ fileId, newName }) => {
    const res = await api.files.update({ supportsAllDrives: true, fileId, requestBody: { name: newName }, fields: "id,name" });
    return textResult({ id: res.data.id, name: res.data.name });
  });

  server.tool("drive_delete_file", "Move a file to trash or permanently delete it", {
    fileId: z.string(),
    permanent: z.boolean().optional().default(false),
  }, async ({ fileId, permanent }) => {
    const drive = api;
    if (permanent) {
      await drive.files.delete({ supportsAllDrives: true, fileId });
      return textResult({ success: true, action: "deleted", fileId });
    }
    await drive.files.update({ supportsAllDrives: true, fileId, requestBody: { trashed: true } });
    const file = await drive.files.get({ supportsAllDrives: true, fileId, fields: "id,name" });
    return textResult({ success: true, action: "trashed", fileId, fileName: file.data.name });
  });

  server.tool("drive_download_file", `Download a file from Drive. Default writes to a local temp path and returns { name, mimeType, path, bytes }; caller uses Read/Bash on the path. Pass returnContent=true to skip disk and return the body inline as { name, mimeType, content, bytes, encoding } where encoding is 'utf-8' for text MIME types (text/* and application/json) and 'base64' for everything else — including Workspace exports to binary formats like PDF/DOCX/XLSX. Inline mode is capped at ${MAX_INLINE_BYTES} bytes; larger files must use disk mode. Folders cannot be downloaded; use drive_list_folder_contents to enumerate them. Files older than 24h in the cache dir are cleaned up on first use per process.`, {
    fileId: z.string(),
    mimeType: z.string().optional().describe("Export MIME type for Google Workspace files (e.g., 'text/markdown', 'text/plain', 'application/pdf')"),
    returnContent: z.boolean().optional().default(false).describe("If true, return the file content inline (utf-8 for text MIME, base64 otherwise) instead of writing to disk. Default false: write to disk and return a path."),
  }, async ({ fileId, mimeType, returnContent }) => {
    const drive = api;
    const meta = await drive.files.get({
      supportsAllDrives: true,
      fileId,
      fields: "name,mimeType,size",
    });

    // Folders aren't downloadable — surface a clear error instead of letting
    // the API call below fail opaquely. Callers should use
    // drive_list_folder_contents to enumerate folder children.
    if (meta.data.mimeType === FOLDER_MIME) {
      throw new Error(
        `Cannot download a folder (fileId=${fileId}, name=${meta.data.name}). Use drive_list_folder_contents to list its contents.`
      );
    }

    const isWorkspace = !!meta.data.mimeType?.startsWith("application/vnd.google-apps.");
    const outMime = isWorkspace
      ? mimeType || "text/plain"
      : meta.data.mimeType || "application/octet-stream";

    // Inline mode: return body in the response, never touch disk.
    // Encoding choice keys off the OUTPUT MIME, not the source format —
    // Workspace docs can be exported to binary (PDF/DOCX) which MUST be
    // base64 to preserve bytes.
    if (returnContent) {
      // Pre-flight size guard for native files (meta.size is reliable for
      // them). Workspace exports don't have a meta.size — they're bounded
      // by Google's own export caps (~10MB), and we re-check post-download
      // below as a belt-and-braces guard.
      const reportedSize = meta.data.size ? Number(meta.data.size) : undefined;
      if (!isWorkspace && reportedSize !== undefined && reportedSize > MAX_INLINE_BYTES) {
        throw new Error(
          `File too large for inline mode: ${reportedSize} bytes > ${MAX_INLINE_BYTES} byte cap. Use the default disk mode (omit returnContent) for files this size.`
        );
      }
      const arraybufRes = isWorkspace
        ? await drive.files.export(
            { fileId, mimeType: outMime },
            { responseType: "arraybuffer" }
          )
        : await drive.files.get(
            { supportsAllDrives: true, fileId, alt: "media" },
            { responseType: "arraybuffer" }
          );
      const body = Buffer.from(arraybufRes.data as ArrayBuffer);
      if (body.byteLength > MAX_INLINE_BYTES) {
        throw new Error(
          `Downloaded body too large for inline mode: ${body.byteLength} bytes > ${MAX_INLINE_BYTES} byte cap. Use the default disk mode (omit returnContent).`
        );
      }
      const encoding: "utf-8" | "base64" = isTextMime(outMime) ? "utf-8" : "base64";
      return textResult({
        name: meta.data.name,
        mimeType: outMime,
        content: body.toString(encoding),
        bytes: body.byteLength,
        encoding,
      });
    }

    // Disk mode (default): ensure cache dir is initialized (with stale-file
    // sweep), then write to a temp path and return it. Trigger a periodic
    // re-sweep in the background if it's been more than DOWNLOAD_CACHE_TTL_MS
    // since the last one — handles long-running MCP processes.
    await ensureCacheInitialized();
    maybePeriodicSweep();

    const ext = extensionFor(outMime);
    const path = cachePath(meta.data.name || fileId, ext);

    let bytes: number;
    try {
      if (isWorkspace) {
        // Workspace exports are bounded by Google (~10MB Doc export cap); buffer is fine.
        const res = await drive.files.export(
          { fileId, mimeType: outMime },
          { responseType: "arraybuffer" }
        );
        const body = Buffer.from(res.data as ArrayBuffer);
        await writeFile(path, body);
        bytes = body.byteLength;
      } else {
        // Native files can be arbitrarily large; stream directly to disk.
        const res = await drive.files.get(
          { supportsAllDrives: true, fileId, alt: "media" },
          { responseType: "stream" }
        );
        await pipeline(res.data as Readable, createWriteStream(path));
        bytes = (await stat(path)).size;
      }
    } catch (err) {
      // Download failed mid-flight (network error, stream interruption,
      // export rejection). Remove any partial file before propagating so
      // callers don't see a path that points at corrupt/incomplete bytes.
      await unlink(path).catch(() => {});
      throw err;
    }

    return textResult({
      name: meta.data.name,
      mimeType: outMime,
      path,
      bytes,
    });
  });

  server.tool("drive_create_folder", "Create a new folder", {
    name: z.string(),
    parentId: z.string().optional().describe("Parent folder ID"),
  }, async ({ name, parentId }) => {
    const res = await api.files.create({
      supportsAllDrives: true,
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : undefined,
      },
      fields: "id,name,webViewLink",
    });
    return textResult({ id: res.data.id, name: res.data.name, url: res.data.webViewLink });
  });

  server.tool("drive_get_folder_info", "Get folder metadata and size", {
    folderId: z.string(),
  }, async ({ folderId }) => {
    const drive = api;
    const meta = await drive.files.get({ supportsAllDrives: true, fileId: folderId, fields: "id,name,modifiedTime,createdTime,owners,webViewLink" });
    const children = await drive.files.list({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
    });
    return textResult({ ...meta.data, childCount: children.data.files?.length || 0 });
  });

  server.tool("drive_upload_file", "Upload a local file into Google Drive. Reads from local_path (must exist) and creates a new Drive file. Defaults: name = the file's basename, mime_type = guessed from the extension, destination = My Drive root (pass folder_id to place it in a folder). Large files are uploaded resumably by the SDK.", {
    local_path: z.string().describe("Path to the local file to upload"),
    folder_id: z.string().optional().describe("Destination folder ID. Omit for My Drive root."),
    name: z.string().optional().describe("Name for the Drive file. Defaults to the local file's basename."),
    mime_type: z.string().optional().describe("MIME type. Guessed from the file extension if omitted."),
  }, async ({ local_path, folder_id, name, mime_type }) => {
    // Fail fast with a clean error if the path doesn't exist or isn't a file,
    // instead of letting a lazy read stream reject opaquely mid-upload.
    let fileStat;
    try {
      fileStat = await stat(local_path);
    } catch {
      throw new Error(`Local file not found: ${local_path}`);
    }
    if (!fileStat.isFile()) {
      throw new Error(`Not a regular file: ${local_path}`);
    }

    const fileName = name || basename(local_path);
    const mimeType = mime_type || UPLOAD_EXT_TO_MIME[extname(local_path).toLowerCase()] || "application/octet-stream";

    const res = await api.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: fileName,
        parents: folder_id ? [folder_id] : undefined,
      },
      media: {
        mimeType,
        body: createReadStream(local_path),
      },
      fields: "id,name,mimeType,size,parents,webViewLink",
    });
    return textResult({
      id: res.data.id,
      name: res.data.name,
      mimeType: res.data.mimeType,
      size: res.data.size,
      url: res.data.webViewLink,
    });
  });

  server.tool("drive_share", "Share a Drive file (grant a permission). For a specific person or group use type='user'/'group' with an email; type='domain' with a domain; type='anyone' for a public link. Does NOT email the recipient by default (set sendNotificationEmail=true to notify).", {
    fileId: z.string(),
    role: z.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"]).describe("Access level to grant"),
    type: z.enum(["user", "group", "domain", "anyone"]).describe("Grantee type"),
    email: z.string().optional().describe("Email address for type=user or type=group"),
    domain: z.string().optional().describe("Domain for type=domain"),
    sendNotificationEmail: z.boolean().optional().default(false).describe("Whether to email the grantee. Default false."),
    emailMessage: z.string().optional().describe("Custom message to include when sendNotificationEmail is true"),
    allowFileDiscovery: z.boolean().optional().describe("For type=domain/anyone: whether the file surfaces in search. Default (unset) is a link-only share."),
  }, async ({ fileId, role, type, email, domain, sendNotificationEmail, emailMessage, allowFileDiscovery }) => {
    if ((type === "user" || type === "group") && !email) {
      throw new Error(`type='${type}' requires an email address.`);
    }
    if (type === "domain" && !domain) {
      throw new Error("type='domain' requires a domain.");
    }
    const permission: drive_v3.Schema$Permission = { role, type };
    if (email) permission.emailAddress = email;
    if (domain) permission.domain = domain;
    if (allowFileDiscovery !== undefined) permission.allowFileDiscovery = allowFileDiscovery;

    const res = await api.permissions.create({
      supportsAllDrives: true,
      fileId,
      sendNotificationEmail,
      emailMessage,
      requestBody: permission,
      fields: "id,type,role,emailAddress,domain,allowFileDiscovery",
    });
    return textResult(res.data);
  });

  server.tool("drive_list_permissions", "List who has access to a Drive file (its permissions).", {
    fileId: z.string(),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ fileId, pageToken }) => {
    const res = await api.permissions.list({
      supportsAllDrives: true,
      fileId,
      pageToken,
      fields: "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery)",
    });
    return textResult({ permissions: res.data.permissions || [], nextPageToken: res.data.nextPageToken });
  });
}
