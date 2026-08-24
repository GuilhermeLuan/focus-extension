import { describe, expect, it } from "vitest";
import { createBlockedPageModel, getSafeDestination } from "./blocked";

describe("blocked page model", () => {
  it("stays blocked only for the captured session", () => {
    expect(createBlockedPageModel("session-1", { id: "session-1" })).toEqual({ status: "blocked" });
    expect(createBlockedPageModel("session-1", undefined)).toEqual({ status: "released" });
    expect(createBlockedPageModel("session-1", { id: "session-2" })).toEqual({ status: "released" });
  });

  it.each([
    ["https://example.com/path?q=1#part", "https://example.com/path?q=1#part"],
    ["http://localhost:3000/", "http://localhost:3000/"]
  ])("accepts %s as a safe destination", (input, expected) => {
    expect(getSafeDestination(input)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "ftp://example.com/file", "not a URL", undefined])(
    "rejects an unsafe destination %s",
    (input) => {
      expect(getSafeDestination(input)).toBeUndefined();
    }
  );
});
