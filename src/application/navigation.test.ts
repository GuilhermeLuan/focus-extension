import { describe, expect, it } from "vitest";
import { decideNavigation, type NavigationRequest } from "./navigation";
import type { ActiveSession } from "../domain/types";

const session: ActiveSession = {
  schemaVersion: 1,
  id: "session-1",
  startedAt: 1_000,
  endsAt: 3_001_000,
  durationMinutes: 50,
  profileSnapshot: {
    id: "focus",
    name: "Foco",
    hostname: "youtube.com"
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
      redirectUrl: "moz-extension://focus/blocked.html?hostname=m.youtube.com&sessionId=session-1"
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
});
