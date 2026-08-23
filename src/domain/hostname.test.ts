import { describe, expect, it } from "vitest";
import { matchesHostname } from "./hostname";

describe("hostname matching", () => {
  it("matches the hostname and its subdomains without matching lookalikes", () => {
    expect(matchesHostname("youtube.com", "youtube.com")).toBe(true);
    expect(matchesHostname("m.youtube.com", "youtube.com")).toBe(true);
    expect(matchesHostname("notyoutube.com", "youtube.com")).toBe(false);
    expect(matchesHostname("youtube.com.example.org", "youtube.com")).toBe(false);
  });
});
