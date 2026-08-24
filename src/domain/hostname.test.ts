import { describe, expect, it } from "vitest";
import {
  analyzeBlockedHostInsertion,
  matchesBlockedHost,
  normalizeBlockedHost
} from "./hostname";

describe("normalizeBlockedHost", () => {
  it("normalizes URLs, www, trailing dots, case, and ignores URL parts", () => {
    expect(normalizeBlockedHost("  https://WWW.Example.COM.:8443/path?q=1#x  ")).toEqual({
      canonicalHost: "example.com",
      displayHost: "example.com",
      kind: "domain"
    });
  });

  it("keeps IDNA as ASCII canonical data while retaining a readable display host", () => {
    expect(normalizeBlockedHost("例え.テスト")).toEqual({
      canonicalHost: "xn--r8jz45g.xn--zckzah",
      displayHost: "例え.テスト",
      kind: "domain"
    });
  });

  it("classifies IPv4, IPv6, and localhost", () => {
    expect(normalizeBlockedHost("127.0.0.1")).toMatchObject({ canonicalHost: "127.0.0.1", kind: "ipv4" });
    expect(normalizeBlockedHost("https://[2001:DB8::1]:443/path")).toMatchObject({ canonicalHost: "2001:db8::1", kind: "ipv6" });
    expect(normalizeBlockedHost("LOCALHOST.")).toMatchObject({ canonicalHost: "localhost", kind: "localhost" });
  });

  it("rejects non-http protocols, credentials, spaces, public suffixes, and protected hosts", () => {
    for (const input of [
      "ftp://example.com",
      "about:blank",
      "https://user:pass@example.com",
      "foo bar.example.com",
      "_service.example.com",
      "-invalid.example.com",
      "com",
      "addons.mozilla.org",
      "foo.accounts.firefox.com",
      "firefox.com"
    ]) {
      expect(normalizeBlockedHost(input), input).toBeNull();
    }
  });
});

describe("matchesBlockedHost", () => {
  it("matches domain suffixes only on label boundaries", () => {
    const rule = normalizeBlockedHost("youtube.com")!;
    expect(matchesBlockedHost("youtube.com", rule)).toBe(true);
    expect(matchesBlockedHost("m.youtube.com", rule)).toBe(true);
    expect(matchesBlockedHost("notyoutube.com", rule)).toBe(false);
    expect(matchesBlockedHost("youtube.com.example.org", rule)).toBe(false);
  });

  it("matches IPs and localhost exactly", () => {
    const ip = normalizeBlockedHost("127.0.0.1")!;
    const ipv6 = normalizeBlockedHost("[::1]")!;
    const local = normalizeBlockedHost("localhost")!;
    expect(matchesBlockedHost("127.0.0.1", ip)).toBe(true);
    expect(matchesBlockedHost("127.0.0.10", ip)).toBe(false);
    expect(matchesBlockedHost("[::1]", ipv6)).toBe(true);
    expect(matchesBlockedHost("foo.localhost", local)).toBe(false);
  });
});

describe("analyzeBlockedHostInsertion", () => {
  const youtube = normalizeBlockedHost("youtube.com")!;
  const mobile = normalizeBlockedHost("m.youtube.com")!;

  it("reports equality and narrower rules as already covered", () => {
    expect(analyzeBlockedHostInsertion("youtube.com", [youtube])).toEqual({
      type: "covered",
      candidate: youtube,
      existing: youtube
    });
    expect(analyzeBlockedHostInsertion("m.youtube.com", [youtube])).toMatchObject({
      type: "covered",
      existing: youtube
    });
  });

  it("requires confirmation before adding a broader rule and removes covered domains after confirmation", () => {
    expect(analyzeBlockedHostInsertion("youtube.com", [mobile])).toEqual({
      type: "confirm",
      candidate: youtube,
      removedHosts: [mobile]
    });
    expect(analyzeBlockedHostInsertion("youtube.com", [mobile], true)).toEqual({
      type: "add",
      candidate: youtube,
      removedHosts: [mobile]
    });
  });

  it("keeps different IPs and localhost rules independent", () => {
    const first = normalizeBlockedHost("127.0.0.1")!;
    const second = normalizeBlockedHost("127.0.0.2")!;
    expect(analyzeBlockedHostInsertion(second, [first]).type).toBe("add");
  });
});
