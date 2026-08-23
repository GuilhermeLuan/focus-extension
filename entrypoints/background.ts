import { browser } from "wxt/browser";
import { NavigationGuard } from "../src/application/navigation";
import { BackgroundService } from "../src/application/service";
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

const store = new StateStore(storage);
const service = new BackgroundService(store, { alarms });

export default defineBackground(() => {
  const blockedPageUrl = browser.runtime.getURL("blocked.html" as never);
  const navigation = new NavigationGuard(() => store.read(), blockedPageUrl);

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
