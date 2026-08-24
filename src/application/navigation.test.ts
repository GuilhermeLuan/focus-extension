import { describe, expect, it } from "vitest";
import { decideNavigation, NavigationGuard, type NavigationRequest } from "./navigation";
import type { ActiveSession } from "../domain/types";

const session: ActiveSession = {
  schemaVersion: 1,
  id: "session-1",
  startedAt: 1_000,
  cancelAllowedUntil: 61_000,
  endsAt: 3_001_000,
  durationMinutes: 50,
  profileSnapshot: {
    id: "focus",
    name: "Foco",
    domains: [
      { canonicalHost: "youtube.com", displayHost: "youtube.com", kind: "domain" },
      { canonicalHost: "127.0.0.1", displayHost: "127.0.0.1", kind: "ipv4" },
      { canonicalHost: "localhost", displayHost: "localhost", kind: "localhost" }
    ]
  }
};

describe("navigation decision", () => {
  it("redirects a matching main-frame HTTP navigation to the local block page", () => {
    const request: NavigationRequest = {
      url: "https://m.youtube.com/watch?v=abc",
      type: "main_frame"
    };

    const decision = decideNavigation(request, session, "moz-extension://focus/blocked.html");

    expect(decision).toEqual({
      type: "redirect",
      redirectUrl: "moz-extension://focus/blocked.html?hostname=m.youtube.com&sessionId=session-1&destination=https%3A%2F%2Fm.youtube.com%2Fwatch%3Fv%3Dabc"
    });
  });

  it("preserves the complete encoded HTTP destination including its fragment", () => {
    const decision = decideNavigation(
      { url: "https://m.youtube.com/watch?v=a%26b#comments", type: "main_frame" },
      session,
      "moz-extension://focus/blocked.html"
    );

    expect(decision).toEqual({
      type: "redirect",
      redirectUrl: "moz-extension://focus/blocked.html?hostname=m.youtube.com&sessionId=session-1&destination=https%3A%2F%2Fm.youtube.com%2Fwatch%3Fv%3Da%2526b%23comments"
    });
  });

  it("allows subresources, other hosts, and non-HTTP protocols", () => {
    const requests: NavigationRequest[] = [
      { url: "https://youtube.com/player", type: "sub_frame" },
      { url: "https://youtube.com/image.png", type: "image" },
      { url: "https://example.org/", type: "main_frame" },
      { url: "ftp://youtube.com/file", type: "main_frame" }
    ];

    for (const request of requests) {
      expect(decideNavigation(request, session, "moz-extension://focus/blocked.html")).toEqual({ type: "allow" });
    }
  });

  it("uses exact matching for IP and localhost rules", () => {
    expect(decideNavigation({ url: "http://127.0.0.1:3000", type: "main_frame" }, session, "moz-extension://focus/blocked.html").type).toBe("redirect");
    expect(decideNavigation({ url: "http://127.0.0.10", type: "main_frame" }, session, "moz-extension://focus/blocked.html")).toEqual({ type: "allow" });
    expect(decideNavigation({ url: "http://foo.localhost", type: "main_frame" }, session, "moz-extension://focus/blocked.html")).toEqual({ type: "allow" });
  });
});

describe("navigation guard", () => {
  it("does not preserve a session that is already at its end time", async () => {
    const guard = new NavigationGuard(
      async () => ({ activeSession: { ...session, endsAt: 5_000 } }),
      "moz-extension://focus/blocked.html",
      () => 5_000
    );

    await expect(guard.decide({ url: "https://youtube.com/", type: "main_frame" })).resolves.toEqual({ type: "allow" });
  });
});
