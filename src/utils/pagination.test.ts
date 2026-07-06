import { describe, expect, it } from "vitest";
import { decodeCompositePageToken, encodeCompositePageToken } from "./pagination.js";

describe("encodeCompositePageToken / decodeCompositePageToken", () => {
  it("round-trips multiple named sub-cursors", () => {
    const token = encodeCompositePageToken({ folders: "f-tok", files: "file-tok" });
    expect(token).toBeTypeOf("string");
    expect(decodeCompositePageToken(token)).toEqual({ folders: "f-tok", files: "file-tok" });
  });

  it("drops undefined sub-cursors when encoding", () => {
    const token = encodeCompositePageToken({ folders: "f-tok", files: undefined });
    expect(decodeCompositePageToken(token)).toEqual({ folders: "f-tok" });
  });

  it("returns undefined when every sub-cursor is absent", () => {
    expect(encodeCompositePageToken({ folders: undefined, files: undefined })).toBeUndefined();
    expect(encodeCompositePageToken({})).toBeUndefined();
  });

  it("decodes an undefined token to an empty object", () => {
    expect(decodeCompositePageToken(undefined)).toEqual({});
  });

  it("decodes garbage/foreign tokens to an empty object instead of throwing", () => {
    expect(decodeCompositePageToken("not-base64-json!!")).toEqual({});
    expect(decodeCompositePageToken(Buffer.from("[1,2,3]").toString("base64url"))).toEqual({});
    expect(decodeCompositePageToken(Buffer.from('"just a string"').toString("base64url"))).toEqual({});
  });

  it("produces a token that is opaque (not directly readable JSON)", () => {
    const token = encodeCompositePageToken({ folders: "abc" });
    expect(token).not.toContain("folders");
  });
});
