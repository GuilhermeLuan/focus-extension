import { browser } from "wxt/browser";
import { ExistingTabsScanner } from "../src/application/existing-tabs";
import { NavigationGuard } from "../src/application/navigation";
import { BackgroundService } from "../src/application/service";
import type { ActionIndicator } from "../src/application/service";
import { StateStore, type StorageArea } from "../src/application/storage";
import type { BackgroundRequest } from "../src/domain/types";

const storage: StorageArea = {
  get: (keys) => browser.storage.local.get(keys ?? undefined) as Promise<Record<string, unknown>>,
  set: (values) => browser.storage.local.set(values),
  remove: (keys) => browser.storage.local.remove(keys)
};

const alarms = {
  create: (name: string, alarm: { when: number }) => browser.alarms.create(name, alarm),
  clear: (name: string) => browser.alarms.clear(name)
};

const actionIndicator: ActionIndicator = {
  setActive: () => browser.action.setIcon({ path: browser.runtime.getURL("/icon-active.svg") }),
  setInactive: () => browser.action.setIcon({ path: browser.runtime.getURL("/icon-inactive.svg") })
};

const store = new StateStore(storage);

export default defineBackground(() => {
  const blockedPageUrl = browser.runtime.getURL("blocked.html" as never);
  const existingTabs = new ExistingTabsScanner(
    {
      query: () => browser.tabs.query({}),
      update: (tabId, updateProperties) => browser.tabs.update(tabId, updateProperties)
    },
    blockedPageUrl
  );
  const service = new BackgroundService(store, {
    alarms,
    indicator: actionIndicator,
    isAllowedIncognitoAccess: () => browser.extension.isAllowedIncognitoAccess(),
    existingTabs
  });
  const navigation = new NavigationGuard(() => store.read(), blockedPageUrl);

  void service.handle({ type: "GET_STATE" });

  browser.runtime.onMessage.addListener((message: unknown) => {
    return service.handle(message as BackgroundRequest);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    void service.handleAlarm(alarm.name);
  });

  browser.webRequest.onBeforeRequest.addListener(
    (async (details: { url: string; type: string }) => {
      const decision = await navigation.decide({ url: details.url, type: details.type });
      return decision.type === "redirect" ? { redirectUrl: decision.redirectUrl } : {};
    }) as never,
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking"]
  );
});
