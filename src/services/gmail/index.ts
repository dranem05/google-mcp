import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, gmail_v1 } from "googleapis";
import { z } from "zod";
import { writeFile, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import {
  buildRawEmail,
  buildReplyHeaders,
  decodeBase64UrlToBuffer,
  encodeBase64Url,
  extractAttachments,
  bestBodyText,
  extractBody,
  formatMessage,
  getHeader,
  type EmailAttachment,
  type OriginalMessageHeaders,
} from "../../utils/email.js";
import { withConcurrencyLimit } from "../../utils/concurrency.js";
import { mapGoogleError } from "../../utils/errors.js";
import { ensureCacheInitialized, maybePeriodicSweep, cachePath } from "../../utils/download-cache.js";

const FILTER_TEMPLATES: Record<string, { criteria: Record<string, unknown>; action: Record<string, unknown> }> = {
  newsletter: { criteria: { query: "unsubscribe" }, action: { removeLabelIds: ["INBOX"] } },
  social_notifications: { criteria: { from: "notification" }, action: { removeLabelIds: ["INBOX"] } },
  auto_archive_noreply: { criteria: { from: "noreply" }, action: { removeLabelIds: ["INBOX"] } },
};

// Hard cap for inline (base64-in-response) attachment downloads, mirroring
// drive_download_file's inline-mode cap: keeps tool responses from blowing
// past MCP/LLM context budgets. Larger attachments are written to disk.
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

// Minimal extension -> MIME map used to guess an attachment's content type when
// the caller doesn't supply one. Falls back to application/octet-stream.
const EXT_TO_MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
  ".json": "application/json", ".pdf": "application/pdf", ".zip": "application/zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const attachmentSchema = z.object({
  path: z.string().optional().describe("Local filesystem path to read the attachment from"),
  content_base64: z.string().optional().describe("Base64 of the file bytes, as an alternative to path"),
  filename: z.string().optional().describe("Attachment filename; defaults to the basename of path"),
  mime_type: z.string().optional().describe("MIME type; guessed from the file extension if omitted"),
});
type AttachmentInput = z.infer<typeof attachmentSchema>;

/** Resolves attachment inputs (path or base64) into ready-to-encode EmailAttachments. */
async function resolveAttachments(attachments: AttachmentInput[] | undefined): Promise<EmailAttachment[]> {
  if (!attachments?.length) return [];
  return Promise.all(
    attachments.map(async (att) => {
      let contentBase64: string;
      let filename = att.filename;
      if (att.path) {
        const buf = await readFile(att.path); // throws a clean ENOENT if missing
        contentBase64 = buf.toString("base64");
        filename ||= basename(att.path);
      } else if (att.content_base64) {
        contentBase64 = att.content_base64;
      } else {
        throw new Error("Each attachment must supply either a path or content_base64.");
      }
      if (!filename) throw new Error("Attachment from content_base64 requires a filename.");
      const mimeType = att.mime_type || EXT_TO_MIME[extname(filename).toLowerCase()] || "application/octet-stream";
      return { filename, mimeType, contentBase64 };
    })
  );
}

export function registerGmailTools(server: McpServer, ctx: ServiceContext): void {
  const api = google.gmail({ version: "v1", auth: ctx.auth });

  // Cache the authenticated user's email address (users.getProfile) for the
  // process lifetime. Only used as a reply-all self-exclusion fallback, and it
  // can't change mid-process, so one lookup covers every reply.
  let cachedProfileEmail: string | undefined;
  let profileFetched = false;
  async function getSelfEmail(): Promise<string | undefined> {
    if (profileFetched) return cachedProfileEmail;
    try {
      const res = await api.users.getProfile({ userId: "me" });
      cachedProfileEmail = res.data.emailAddress || undefined;
    } catch {
      cachedProfileEmail = undefined;
    }
    profileFetched = true;
    return cachedProfileEmail;
  }

  server.tool("gmail_search_emails", "Search emails using Gmail search syntax", {
    query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ query, maxResults, pageToken }) => {
    const gmail = api;
    const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: maxResults || 10, pageToken });
    if (!res.data.messages?.length) return textResult("No messages found.");

    const ids = res.data.messages;
    const settled = await withConcurrencyLimit(ids, 5, async (m) => {
      const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
      return {
        id: full.data.id,
        threadId: full.data.threadId,
        snippet: full.data.snippet,
        subject: getHeader(full.data.payload?.headers, "subject"),
        from: getHeader(full.data.payload?.headers, "from"),
        date: getHeader(full.data.payload?.headers, "date"),
      };
    });

    const messages: Array<{ id?: string | null; threadId?: string | null; snippet?: string | null; subject?: string; from?: string; date?: string }> = [];
    const failures: Array<{ id?: string | null; error: string }> = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        messages.push(result.value);
      } else {
        failures.push({ id: ids[i].id, error: mapGoogleError(result.reason) });
      }
    });

    return textResult({
      messages,
      nextPageToken: res.data.nextPageToken,
      ...(failures.length ? { failures } : {}),
    });
  });

  server.tool("gmail_read_email", "Read the full content of an email", {
    messageId: z.string().describe("ID of the email message to retrieve"),
  }, async ({ messageId }) => {
    const res = await api.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return textResult(formatMessage(res.data));
  });

  server.tool("gmail_send_email", "Send a brand-new email. To reply within an existing thread (correct threading headers, Re: subject), use gmail_reply_to_email instead.", {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    mimeType: z.enum(["text/plain", "text/html", "multipart/alternative"]).optional().default("text/plain"),
    threadId: z.string().optional().describe("Thread ID to reply to"),
    inReplyTo: z.string().optional().describe("RFC822 Message-ID header value to reference (not a Gmail message id). Prefer gmail_reply_to_email, which fills this in for you."),
    attachments: z.array(attachmentSchema).optional().describe("Files to attach, each { path | content_base64, filename?, mime_type? }"),
  }, async (opts) => {
    const attachments = await resolveAttachments(opts.attachments);
    const raw = encodeBase64Url(buildRawEmail({ ...opts, attachments }));
    const res = await api.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: opts.threadId },
    });
    return textResult({ id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds });
  });

  server.tool("gmail_draft_email", "Create an email draft", {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    mimeType: z.enum(["text/plain", "text/html", "multipart/alternative"]).optional().default("text/plain"),
    threadId: z.string().optional().describe("Thread ID to reply to"),
    inReplyTo: z.string().optional().describe("RFC822 Message-ID header value being replied to (not a Gmail message id)"),
    attachments: z.array(attachmentSchema).optional().describe("Files to attach, each { path | content_base64, filename?, mime_type? }"),
  }, async (opts) => {
    const attachments = await resolveAttachments(opts.attachments);
    const raw = encodeBase64Url(buildRawEmail({ ...opts, attachments }));
    const res = await api.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: opts.threadId } },
    });
    return textResult({ draftId: res.data.id, messageId: res.data.message?.id, threadId: res.data.message?.threadId });
  });

  server.tool("gmail_reply_to_email", "Reply to an existing email, correctly threaded. Pass the Gmail API message id of the message you're replying to; this fetches its RFC822 Message-ID/References/Subject and builds a proper In-Reply-To + References chain, a 'Re:' subject, and reuses the thread. Use this instead of gmail_send_email whenever you're responding to a received message.", {
    messageId: z.string().describe("Gmail API id of the message being replied to (e.g. from gmail_search_emails)"),
    body: z.string().describe("Reply body (plain text)"),
    htmlBody: z.string().optional().describe("HTML version of the reply body"),
    mimeType: z.enum(["text/plain", "text/html", "multipart/alternative"]).optional().default("text/plain"),
    replyAll: z.boolean().optional().default(false).describe("Reply to the sender plus all other recipients (To+Cc), excluding yourself. Default false replies only to the sender."),
    cc: z.array(z.string()).optional().describe("Extra CC recipients to add on top of those computed for the reply"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    attachments: z.array(attachmentSchema).optional().describe("Files to attach, each { path | content_base64, filename?, mime_type? }"),
  }, async (opts) => {
    const original = await api.users.messages.get({
      userId: "me",
      id: opts.messageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject", "From", "To", "Cc"],
    });
    const headers = original.data.payload?.headers;
    const originalHeaders: OriginalMessageHeaders = {
      messageIdHeader: getHeader(headers, "message-id"),
      references: getHeader(headers, "references"),
      subject: getHeader(headers, "subject"),
      from: getHeader(headers, "from"),
      to: getHeader(headers, "to"),
      cc: getHeader(headers, "cc"),
    };
    const selfEmail = opts.replyAll ? await getSelfEmail() : undefined;
    const reply = buildReplyHeaders(originalHeaders, { replyAll: opts.replyAll, selfEmail });
    const cc = [...reply.cc, ...(opts.cc || [])];
    const attachments = await resolveAttachments(opts.attachments);

    const raw = encodeBase64Url(buildRawEmail({
      to: reply.to,
      cc: cc.length ? cc : undefined,
      bcc: opts.bcc,
      subject: reply.subject,
      body: opts.body,
      htmlBody: opts.htmlBody,
      mimeType: opts.mimeType,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments,
    }));
    const res = await api.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: original.data.threadId || undefined },
    });
    return textResult({ id: res.data.id, threadId: res.data.threadId, to: reply.to, cc, subject: reply.subject });
  });

  server.tool("gmail_modify_email", "Modify email labels (add/remove)", {
    messageId: z.string().describe("ID of the message to modify"),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
  }, async ({ messageId, addLabelIds, removeLabelIds }) => {
    const res = await api.users.messages.modify({
      userId: "me", id: messageId,
      requestBody: { addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] },
    });
    return textResult({ id: res.data.id, labelIds: res.data.labelIds });
  });

  server.tool("gmail_delete_email", "Move an email to trash", {
    messageId: z.string().describe("ID of the message to trash"),
  }, async ({ messageId }) => {
    await api.users.messages.trash({ userId: "me", id: messageId });
    return textResult({ success: true, messageId });
  });

  server.tool("gmail_batch_delete_emails", "Permanently delete multiple emails", {
    messageIds: z.array(z.string()).describe("IDs of messages to delete"),
  }, async ({ messageIds }) => {
    await api.users.messages.batchDelete({ userId: "me", requestBody: { ids: messageIds } });
    return textResult({ success: true, count: messageIds.length });
  });

  server.tool("gmail_batch_modify_emails", "Modify labels on multiple emails", {
    messageIds: z.array(z.string()).describe("IDs of messages to modify"),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
  }, async ({ messageIds, addLabelIds, removeLabelIds }) => {
    await api.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: messageIds, addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] },
    });
    return textResult({ success: true, count: messageIds.length });
  });

  server.tool("gmail_create_filter", "Create a Gmail filter with custom criteria and actions", {
    criteria: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      query: z.string().optional(),
      negatedQuery: z.string().optional(),
      hasAttachment: z.boolean().optional(),
      excludeChats: z.boolean().optional(),
      size: z.number().optional(),
      sizeComparison: z.enum(["unspecified", "smaller", "larger"]).optional(),
    }).describe("Filter matching criteria"),
    action: z.object({
      addLabelIds: z.array(z.string()).optional(),
      removeLabelIds: z.array(z.string()).optional(),
      forward: z.string().optional(),
    }).describe("Actions to perform on matching emails"),
  }, async ({ criteria, action }) => {
    const res = await api.users.settings.filters.create({
      userId: "me",
      requestBody: { criteria, action },
    });
    return textResult({ id: res.data.id, criteria: res.data.criteria, action: res.data.action });
  });

  server.tool("gmail_create_filter_from_template", "Create a filter from a predefined template", {
    template: z.enum(["newsletter", "social_notifications", "auto_archive_noreply"]).describe("Template name"),
    customizations: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      query: z.string().optional(),
      addLabelIds: z.array(z.string()).optional(),
      removeLabelIds: z.array(z.string()).optional(),
      forward: z.string().optional(),
    }).optional().describe("Customizations to apply on top of the template"),
  }, async ({ template, customizations }) => {
    const tpl = FILTER_TEMPLATES[template];
    // Split customizations into criteria-shaped keys vs action-shaped keys
    // explicitly, rather than spreading the whole object into criteria —
    // addLabelIds/removeLabelIds/forward are FilterAction fields, not
    // FilterCriteria fields, and don't belong there.
    const criteria: Record<string, unknown> = { ...tpl.criteria };
    if (customizations?.from !== undefined) criteria.from = customizations.from;
    if (customizations?.to !== undefined) criteria.to = customizations.to;
    if (customizations?.subject !== undefined) criteria.subject = customizations.subject;
    if (customizations?.query !== undefined) criteria.query = customizations.query;

    const action: Record<string, unknown> = { ...tpl.action };
    if (customizations?.addLabelIds) action.addLabelIds = customizations.addLabelIds;
    if (customizations?.removeLabelIds) action.removeLabelIds = customizations.removeLabelIds;
    if (customizations?.forward) action.forward = customizations.forward;

    const res = await api.users.settings.filters.create({ userId: "me", requestBody: { criteria, action } });
    return textResult({ id: res.data.id, template, criteria: res.data.criteria, action: res.data.action });
  });

  server.tool("gmail_delete_filter", "Delete a Gmail filter", {
    filterId: z.string().describe("ID of the filter to delete"),
  }, async ({ filterId }) => {
    await api.users.settings.filters.delete({ userId: "me", id: filterId });
    return textResult({ success: true, filterId });
  });

  server.tool("gmail_get_filter", "Get details of a Gmail filter", {
    filterId: z.string().describe("ID of the filter to retrieve"),
  }, async ({ filterId }) => {
    const res = await api.users.settings.filters.get({ userId: "me", id: filterId });
    return textResult(res.data);
  });

  server.tool("gmail_list_filters", "List all Gmail filters", {}, async () => {
    const res = await api.users.settings.filters.list({ userId: "me" });
    return textResult(res.data.filter || []);
  });

  server.tool("gmail_create_label", "Create a Gmail label", {
    name: z.string().describe("Label name"),
    messageListVisibility: z.enum(["show", "hide"]).optional(),
    labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  }, async ({ name, messageListVisibility, labelListVisibility }) => {
    const res = await api.users.labels.create({
      userId: "me",
      requestBody: { name, messageListVisibility, labelListVisibility },
    });
    return textResult({ id: res.data.id, name: res.data.name });
  });

  server.tool("gmail_delete_label", "Delete a Gmail label", {
    labelId: z.string().describe("ID of the label to delete"),
  }, async ({ labelId }) => {
    await api.users.labels.delete({ userId: "me", id: labelId });
    return textResult({ success: true, labelId });
  });

  server.tool("gmail_update_label", "Update a Gmail label", {
    labelId: z.string().describe("ID of the label to update"),
    name: z.string().optional().describe("New label name"),
    messageListVisibility: z.enum(["show", "hide"]).optional(),
    labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  }, async ({ labelId, name, messageListVisibility, labelListVisibility }) => {
    const res = await api.users.labels.update({
      userId: "me", id: labelId,
      requestBody: { name, messageListVisibility, labelListVisibility },
    });
    return textResult({ id: res.data.id, name: res.data.name });
  });

  server.tool("gmail_list_labels", "List all Gmail labels", {}, async () => {
    const res = await api.users.labels.list({ userId: "me" });
    return textResult(res.data.labels?.map((l) => ({ id: l.id, name: l.name, type: l.type })) || []);
  });

  server.tool("gmail_get_or_create_label", "Get a label by name, creating it if it doesn't exist", {
    name: z.string().describe("Label name"),
  }, async ({ name }) => {
    const gmail = api;
    const labels = await gmail.users.labels.list({ userId: "me" });
    const existing = labels.data.labels?.find((l) => l.name?.toLowerCase() === name.toLowerCase());
    if (existing) return textResult({ id: existing.id, name: existing.name, created: false });

    const res = await gmail.users.labels.create({ userId: "me", requestBody: { name } });
    return textResult({ id: res.data.id, name: res.data.name, created: true });
  });

  server.tool("gmail_list_attachments", "List attachments on an email (returns attachment IDs, filenames, sizes)", {
    messageId: z.string().describe("ID of the email message"),
  }, async ({ messageId }) => {
    const res = await api.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const attachments = extractAttachments(res.data.payload);
    return textResult(attachments.length > 0 ? attachments : "No attachments found.");
  });

  server.tool("gmail_download_attachment", `Download an email attachment. Returns inline base64 for attachments up to ~${MAX_INLINE_ATTACHMENT_BYTES} bytes; larger attachments (or when outputPath is given) are written to disk instead and a path is returned.`, {
    messageId: z.string().describe("ID of the message containing the attachment"),
    attachmentId: z.string().describe("ID of the attachment to download"),
    outputPath: z.string().optional().describe("Local path to write the attachment to. If omitted, small attachments are returned inline as base64 and large attachments are written to a temp path instead."),
  }, async ({ messageId, attachmentId, outputPath }) => {
    const res = await api.users.messages.attachments.get({
      userId: "me", messageId, id: attachmentId,
    });
    const data = res.data.data;
    if (!data) return textResult({ error: "Attachment has no data" });

    const buffer = decodeBase64UrlToBuffer(data);
    const sizeBytes = res.data.size ?? buffer.byteLength;

    if (!outputPath && sizeBytes <= MAX_INLINE_ATTACHMENT_BYTES) {
      return textResult({ data, size: sizeBytes, encoding: "base64url" });
    }

    let path = outputPath;
    if (!path) {
      await ensureCacheInitialized();
      maybePeriodicSweep();
      path = cachePath(`attachment-${attachmentId}`, "bin");
    }
    await writeFile(path, buffer);
    return textResult({ path, size: buffer.byteLength });
  });

  // Per-message body snippet cap for thread reads: a whole thread can be many
  // long messages, so each is trimmed to keep the aggregate response bounded.
  const THREAD_BODY_MAX = 2000;
  function pruneThreadMessage(msg: gmail_v1.Schema$Message): Record<string, unknown> {
    const headers = msg.payload?.headers;
    const body = extractBody(msg.payload);
    let text = bestBodyText(body);
    if (text.length > THREAD_BODY_MAX) text = `${text.slice(0, THREAD_BODY_MAX)}\n\n[truncated]`;
    return {
      id: msg.id,
      from: getHeader(headers, "from"),
      to: getHeader(headers, "to"),
      cc: getHeader(headers, "cc"),
      date: getHeader(headers, "date"),
      subject: getHeader(headers, "subject"),
      body: text,
    };
  }

  server.tool("gmail_read_thread", "Read an entire email thread (conversation) at once — every message's headers and a trimmed body — given a thread id. Use this instead of gmail_read_email when you need the full back-and-forth context of a conversation.", {
    threadId: z.string().describe("Gmail thread id (the threadId field on any message in the thread)"),
    format: z.enum(["full", "metadata"]).optional().default("full").describe("full includes trimmed message bodies; metadata returns headers only"),
  }, async ({ threadId, format }) => {
    const res = await api.users.threads.get({
      userId: "me",
      id: threadId,
      format,
      ...(format === "metadata" ? { metadataHeaders: ["From", "To", "Cc", "Date", "Subject"] } : {}),
    });
    return textResult({
      threadId: res.data.id,
      messageCount: res.data.messages?.length || 0,
      messages: res.data.messages?.map(pruneThreadMessage) || [],
    });
  });

  server.tool("gmail_get_profile", "Get the authenticated user's Gmail profile: their email address plus total message/thread counts.", {}, async () => {
    const res = await api.users.getProfile({ userId: "me" });
    return textResult({
      emailAddress: res.data.emailAddress,
      messagesTotal: res.data.messagesTotal,
      threadsTotal: res.data.threadsTotal,
      historyId: res.data.historyId,
    });
  });

  server.tool("gmail_list_drafts", "List saved email drafts (draft id + a summary of each). Send one with gmail_send_draft or discard it with gmail_delete_draft.", {
    maxResults: z.number().optional().describe("Maximum number of drafts to return"),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ maxResults, pageToken }) => {
    const res = await api.users.drafts.list({ userId: "me", maxResults: maxResults || 20, pageToken });
    if (!res.data.drafts?.length) return textResult({ drafts: [], nextPageToken: res.data.nextPageToken });

    const settled = await withConcurrencyLimit(res.data.drafts, 5, async (d) => {
      const full = await api.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" });
      const headers = full.data.message?.payload?.headers;
      return {
        draftId: full.data.id,
        messageId: full.data.message?.id,
        threadId: full.data.message?.threadId,
        to: getHeader(headers, "to"),
        subject: getHeader(headers, "subject"),
        snippet: full.data.message?.snippet,
      };
    });
    const drafts = settled.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<unknown>).value);
    return textResult({ drafts, nextPageToken: res.data.nextPageToken });
  });

  server.tool("gmail_send_draft", "Send an existing draft by its draft id.", {
    draftId: z.string().describe("Id of the draft to send (from gmail_list_drafts)"),
  }, async ({ draftId }) => {
    const res = await api.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    return textResult({ id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds });
  });

  server.tool("gmail_delete_draft", "Permanently delete a draft by its draft id (discards it without sending).", {
    draftId: z.string().describe("Id of the draft to delete"),
  }, async ({ draftId }) => {
    await api.users.drafts.delete({ userId: "me", id: draftId });
    return textResult({ success: true, draftId });
  });

  server.tool("gmail_get_vacation", "Get the current vacation responder (out-of-office auto-reply) settings.", {}, async () => {
    const res = await api.users.settings.getVacation({ userId: "me" });
    return textResult(res.data);
  });

  server.tool("gmail_set_vacation", "Enable or disable the vacation responder (out-of-office auto-reply). Set enableAutoReply=false to turn it off.", {
    enableAutoReply: z.boolean().describe("Whether the auto-reply is active"),
    responseSubject: z.string().optional().describe("Subject line of the auto-reply"),
    responseBodyPlainText: z.string().optional().describe("Plain-text auto-reply body"),
    responseBodyHtml: z.string().optional().describe("HTML auto-reply body"),
    restrictToContacts: z.boolean().optional().describe("Only auto-reply to people in your contacts"),
    restrictToDomain: z.boolean().optional().describe("Only auto-reply to people in your organization's domain"),
    startTime: z.string().optional().describe("Start time as epoch milliseconds (string). Omit to start immediately."),
    endTime: z.string().optional().describe("End time as epoch milliseconds (string). Omit for no end."),
  }, async (opts) => {
    const res = await api.users.settings.updateVacation({
      userId: "me",
      requestBody: {
        enableAutoReply: opts.enableAutoReply,
        responseSubject: opts.responseSubject,
        responseBodyPlainText: opts.responseBodyPlainText,
        responseBodyHtml: opts.responseBodyHtml,
        restrictToContacts: opts.restrictToContacts,
        restrictToDomain: opts.restrictToDomain,
        startTime: opts.startTime,
        endTime: opts.endTime,
      },
    });
    return textResult(res.data);
  });
}
