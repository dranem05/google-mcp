import { describe, expect, it } from "vitest";
import { gmail_v1 } from "googleapis";
import { pickSendAs } from "./index.js";

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
