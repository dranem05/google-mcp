import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, meet_v2 } from "googleapis";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";

export function registerMeetTools(server: McpServer, ctx: ServiceContext): void {
  const meetApi = google.meet({ version: "v2", auth: ctx.auth });

  server.tool("meet_create_link", "Create a standalone Google Meet meeting space and return its join link, without putting anything on your calendar. Use this for an ad-hoc link. To schedule a titled meeting on the calendar with a Meet link, use calendar_create_event (with conferenceData) or calendar_add_meet_link instead. REQUIRES the meetings.space.created OAuth scope: accounts authorized before this scope was added get a 403 'insufficient authentication scopes' error until add-google-account.sh is re-run for the account; if that happens, tell the user to re-run it (do not retry) or fall back to calendar_create_event with conferenceData.", {
    summary: z.string().optional().describe("Ignored: a standalone Meet space has no title. To title a meeting, create a calendar event instead."),
  }, async () => {
    // Meet REST v2 spaces.create mints a reusable meeting space directly,
    // instead of the old approach of inserting a real event starting NOW on
    // the primary calendar (which polluted the calendar). Requires the
    // meetings.space.created OAuth scope.
    const res = await meetApi.spaces.create({ requestBody: {} });
    return textResult({
      meetLink: res.data.meetingUri,
      meetingCode: res.data.meetingCode,
      space: res.data.name,
    });
  });

  server.tool("meet_list_meetings", "List recent Google Meet conference records", {
    pageSize: z.number().optional().describe("Number of records to return (max 100)"),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ pageSize, pageToken }) => {
    try {
      const res = await meetApi.conferenceRecords.list({ pageSize: pageSize || 25, pageToken });
      return textResult({
        conferenceRecords: res.data.conferenceRecords || [],
        nextPageToken: res.data.nextPageToken,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return textResult({ error: `Meet API error: ${msg}. Note: Meet REST API requires Google Workspace.` });
    }
  });

  server.tool("meet_get_transcript", "Get the transcript of a Google Meet recording", {
    conferenceRecordName: z.string().describe("Conference record resource name (e.g., 'conferenceRecords/abc123')"),
  }, async ({ conferenceRecordName }) => {
    try {
      const meet = meetApi;
      const transcripts = await meet.conferenceRecords.transcripts.list({ parent: conferenceRecordName });

      if (!transcripts.data.transcripts?.length) return textResult("No transcripts found for this conference.");

      const entries = await Promise.all(
        transcripts.data.transcripts.map(async (t) => {
          const all: meet_v2.Schema$TranscriptEntry[] = [];
          let pageToken: string | undefined;
          do {
            const entriesRes = await meet.conferenceRecords.transcripts.entries.list({
              parent: t.name!,
              pageSize: 100,
              pageToken,
            });
            all.push(...(entriesRes.data.transcriptEntries || []));
            pageToken = entriesRes.data.nextPageToken || undefined;
          } while (pageToken);
          return all;
        })
      );

      return textResult(entries.flat());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return textResult({ error: `Meet API error: ${msg}. Note: Transcripts require Google Workspace Business Standard or higher.` });
    }
  });
}
