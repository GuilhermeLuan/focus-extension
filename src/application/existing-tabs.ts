import { decideNavigation } from "./navigation";
import type { ActiveSession } from "../domain/types";

export type ExistingTab = {
  id?: number;
  url?: string;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
  incognito?: boolean;
  cookieStoreId?: string;
};

export type TabsApi = {
  query(queryInfo: Record<string, never>): Promise<readonly ExistingTab[]>;
  update(tabId: number, updateProperties: { url: string }): Promise<unknown>;
};

export type ExistingTabsAdapter = {
  scan(session: ActiveSession): Promise<void>;
};

/** Applies the active session to pages that were already open when it began. */
export class ExistingTabsScanner implements ExistingTabsAdapter {
  public constructor(
    private readonly tabs: TabsApi,
    private readonly blockedPageUrl: string
  ) {}

  public async scan(session: ActiveSession): Promise<void> {
    let tabs: readonly ExistingTab[];
    try {
      tabs = await this.tabs.query({});
    } catch {
      return;
    }

    const updates = tabs.flatMap((tab) => {
      const tabId = tab.id;
      if (typeof tabId !== "number" || typeof tab.url !== "string") return [];

      const decision = decideNavigation({ url: tab.url, type: "main_frame" }, session, this.blockedPageUrl);
      if (decision.type !== "redirect") return [];

      return [Promise.resolve().then(() => this.tabs.update(tabId, { url: decision.redirectUrl }))];
    });

    await Promise.allSettled(updates);
  }
}
