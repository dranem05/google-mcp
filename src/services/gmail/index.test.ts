import { describe, expect, it } from "vitest";
import { gmail_v1 } from "googleapis";
import { pickSendAs, resolveFromAddress } from "./index.js";

describe("pickSendAs", () => {
  const primary: gmail_v1.Schema$SendAs = {
    sendAsEmail: "primary@example.com",
    displayName: "Example User",
    isDefault: true,
    signature: "<div>Best,<br>Patrick</div>",
  };
  const alias: gmail_v1.Schema$SendAs = {
    sendAsEmail: "alias@example.com",
    displayName: "Alias Name",
    isDefault: false,
    signature: "<div>Alias sig</div>",
  };
  const sendAsList = [alias, primary];

  it("picks the entry marked isDefault when no address is requested", () => {
    expect(pickSendAs(sendAsList)?.sendAsEmail).toBe("primary@example.com");
  });

  it("picks the exact sendAsEmail match when one is requested, ignoring isDefault", () => {
    expect(pickSendAs(sendAsList, "alias@example.com")?.sendAsEmail).toBe("alias@example.com");
  });

  it("returns undefined when the requested sendAsEmail has no match", () => {
    expect(pickSendAs(sendAsList, "missing@example.com")).toBeUndefined();
  });

  it("falls back to the first entry when none is marked default", () => {
    const noDefault = [alias, { ...primary, isDefault: false }];
    expect(pickSendAs(noDefault)?.sendAsEmail).toBe("alias@example.com");
  });

  it("returns undefined for an empty list", () => {
    expect(pickSendAs([])).toBeUndefined();
  });
});

describe("resolveFromAddress", () => {
  const primary: gmail_v1.Schema$SendAs = {
    sendAsEmail: "primary@example.com",
    displayName: "Example User",
    isDefault: true,
  };
  const alias: gmail_v1.Schema$SendAs = {
    sendAsEmail: "alias@example.com",
    displayName: "Team Alias",
    isDefault: false,
  };
  const noDisplayName: gmail_v1.Schema$SendAs = {
    sendAsEmail: "bare@example.com",
    isDefault: false,
  };
  const sendAsList = [primary, alias, noDisplayName];

  it("builds 'Display Name <addr>' from the verified alias when given a bare address", () => {
    expect(resolveFromAddress("alias@example.com", sendAsList)).toBe("Team Alias <alias@example.com>");
  });

  it("matches by address and ignores any display name the caller supplied, using the verified alias's own", () => {
    expect(resolveFromAddress("Some Random Name <alias@example.com>", sendAsList)).toBe(
      "Team Alias <alias@example.com>"
    );
  });

  it("matches case-insensitively", () => {
    expect(resolveFromAddress("ALIAS@EXAMPLE.COM", sendAsList)).toBe("Team Alias <alias@example.com>");
  });

  it("falls back to the bare address when the matched alias has no displayName", () => {
    expect(resolveFromAddress("bare@example.com", sendAsList)).toBe("bare@example.com");
  });

  it("throws naming the valid aliases when the address isn't a verified send-as", () => {
    expect(() => resolveFromAddress("unknown@example.com", sendAsList)).toThrow(
      /unknown@example\.com.*not a verified send-as address/
    );
    expect(() => resolveFromAddress("unknown@example.com", sendAsList)).toThrow(
      /primary@example\.com, alias@example\.com, bare@example\.com/
    );
  });

  it("throws with a clear message for an empty send-as list", () => {
    expect(() => resolveFromAddress("anything@example.com", [])).toThrow(/none configured/);
  });
});
