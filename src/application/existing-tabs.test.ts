import { describe, expect, it, vi } from "vitest";
import { ExistingTabsScanner, type ExistingTab, type TabsApi } from "./existing-tabs";
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
    domains: [{ canonicalHost: "youtube.com", displayHost: "youtube.com", kind: "domain" }]
  }
};

describe("existing tabs scanner", () => {
  it("queries every exposed tab and updates only matching HTTP(S) tabs with a URL", async () => {
    const tabs: ExistingTab[] = [
      { id: 1, url: "https://youtube.com/watch?v=one", windowId: 1, active: false, pinned: true },
      { id: 2, url: "http://m.youtube.com/watch?v=two", windowId: 2, active: false, incognito: true, cookieStoreId: "firefox-container-1" },
      { id: 3, url: "https://example.com/", windowId: 3, active: true },
      { id: 4, url: "ftp://youtube.com/file", windowId: 1 },
      { id: 5, url: "https://example.com/no-id" },
      { id: 6, windowId: 2 },
      { url: "https://youtube.com/no-tab-id" },
      { id: 7, url: "not a URL" }
    ];
    const query = vi.fn(async () => tabs);
    const update = vi.fn(async (_tabId: number, _properties: { url: string }) => undefined);
    const browserTabs: TabsApi = { query, update };
    const scanner = new ExistingTabsScanner(browserTabs, "moz-extension://focus/blocked.html");

    await scanner.scan(session);

    expect(query).toHaveBeenCalledWith({});
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 1, {
      url: "moz-extension://focus/blocked.html?hostname=youtube.com&sessionId=session-1&destination=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Done"
    });
    expect(update).toHaveBeenNthCalledWith(2, 2, {
      url: "moz-extension://focus/blocked.html?hostname=m.youtube.com&sessionId=session-1&destination=http%3A%2F%2Fm.youtube.com%2Fwatch%3Fv%3Dtwo"
    });
    expect(update.mock.calls.every(([, properties]) => Object.keys(properties).join(",") === "url")).toBe(true);
  });

  it("absorbs an update failure and continues updating other matching tabs", async () => {
    const query = vi.fn(async () => [
      { id: 1, url: "https://youtube.com/closed" },
      { id: 2, url: "https://youtube.com/open" }
    ] satisfies ExistingTab[]);
    const update = vi.fn(async (tabId: number) => {
      if (tabId === 1) throw new Error("tab not found");
    });
    const scanner = new ExistingTabsScanner({ query, update }, "moz-extension://focus/blocked.html");

    await expect(scanner.scan(session)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(2, 2, {
      url: "moz-extension://focus/blocked.html?hostname=youtube.com&sessionId=session-1&destination=https%3A%2F%2Fyoutube.com%2Fopen"
    });
  });

  it("absorbs a query failure", async () => {
    const query = vi.fn(async () => {
      throw new Error("tabs unavailable");
    });
    const update = vi.fn(async (_tabId: number, _properties: { url: string }) => undefined);
    const scanner = new ExistingTabsScanner({ query, update }, "moz-extension://focus/blocked.html");

    await expect(scanner.scan(session)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});
