import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BackgroundRequest, StateResponse } from "../../src/domain/types";
import { Popup, type PopupAdapter } from "./Popup";
import "./style.css";

const adapter: PopupAdapter = {
  runtime: {
    sendMessage: (request: BackgroundRequest) => browser.runtime.sendMessage(request) as Promise<StateResponse>,
    openOptionsPage: () => browser.runtime.openOptionsPage()
  },
  tabs: {
    query: (query) => browser.tabs.query(query) as Promise<Array<{ url?: string }>>
  },
  storage: {
    onChanged: {
      addListener: (listener) => browser.storage.onChanged.addListener(listener as never),
      removeListener: (listener) => browser.storage.onChanged.removeListener(listener as never)
    }
  },
  close: () => window.close(),
  confirm: (message) => window.confirm(message)
};

createRoot(document.getElementById("root")!).render(<Popup adapter={adapter} />);
