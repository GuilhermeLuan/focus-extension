import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { createBlockedPageModel, getSafeDestination } from "../../src/application/blocked";
import { formatEndTime, formatRemaining, presentationCopy as copy } from "../../src/presentation/catalog";
import "./style.css";

export type BlockedPageAdapter = {
  runtime: {
    sendMessage(request: BackgroundRequest): Promise<StateResponse>;
  };
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>) => void): void;
      removeListener(listener: (changes: Record<string, unknown>) => void): void;
    };
  };
  navigation: {
    assign(destination: string): void;
  };
};

export type BlockedPageProps = {
  adapter?: BlockedPageAdapter;
  clock?: () => number;
};

const defaultClock = () => Date.now();

function createDefaultAdapter(): BlockedPageAdapter {
  return {
    runtime: {
      sendMessage: (request) => browser.runtime.sendMessage(request) as Promise<StateResponse>
    },
    storage: {
      onChanged: {
        addListener: (listener) => browser.storage.onChanged.addListener(listener as never),
        removeListener: (listener) => browser.storage.onChanged.removeListener(listener as never)
      }
    },
    navigation: {
      assign: (destination) => window.location.assign(destination)
    }
  };
}

const defaultAdapter = createDefaultAdapter();

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ExtensionState }
  | { status: "error" };

function captureLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    hostname: params.get("hostname") || copy.blocked.hostnameFallback,
    sessionId: params.get("sessionId") ?? undefined,
    destination: getSafeDestination(params.get("destination") ?? undefined)
  };
}

export function BlockedPage({ adapter = defaultAdapter, clock = defaultClock }: BlockedPageProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [now, setNow] = useState(() => clock());
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const [captured] = useState(() => captureLocation());
  const previousBlocked = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      try {
        const response = await adapter.runtime.sendMessage({ type: "GET_STATE" });
        if (disposed) return;
        setLoadState(response.ok ? { status: "ready", data: response.data } : { status: "error" });
      } catch {
        if (!disposed) setLoadState({ status: "error" });
      }
    };

    void refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.configuration || changes.activeSession) void refresh();
    };
    adapter.storage.onChanged.addListener(onChanged);
    return () => {
      disposed = true;
      adapter.storage.onChanged.removeListener(onChanged);
    };
  }, [adapter]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(clock()), 1000);
    return () => window.clearInterval(timer);
  }, [clock]);

  const activeSession = loadState.status === "ready" ? loadState.data.activeSession : undefined;
  const model = createBlockedPageModel(captured.sessionId, activeSession);
  const blocked = loadState.status !== "ready" || model.status === "blocked";
  const capturedSession = blocked && loadState.status === "ready" && model.status === "blocked"
    ? activeSession
    : undefined;
  const remaining = capturedSession ? formatRemaining(capturedSession.endsAt, now) : undefined;

  useEffect(() => {
    const previous = previousBlocked.current;
    if (!blocked && previous === true) {
      setStatusAnnouncement(copy.blocked.releasedAnnouncement);
    } else if (blocked && previous === false) {
      setStatusAnnouncement("");
    }
    previousBlocked.current = blocked;
  }, [blocked]);

  const blockedMessage = loadState.status === "error"
    ? copy.blocked.unavailable
    : loadState.status === "loading"
      ? copy.loading
      : copy.blocked.blockedMessage;

  return (
    <main className={`blocked-page ${blocked ? "is-blocked" : "is-released"}`}>
      <section className="blocked-shell" aria-labelledby="blocked-hostname">
        <p className="brand">{copy.brand}</p>
        <div className="botanical-line" aria-hidden="true">
          <span className="botanical-leaf botanical-leaf-left" />
          <span className="botanical-leaf botanical-leaf-right" />
        </div>
        <p className="kicker">{blocked ? copy.blocked.kicker : copy.blocked.releasedKicker}</p>
        <h1 id="blocked-hostname">{captured.hostname}</h1>

        {blocked ? (
          <div className="blocked-content">
            <p className="message">{blockedMessage}</p>
            {capturedSession && (
              <>
                <p className="profile-context">
                  <span className="profile-label">{copy.blocked.profileLabel}</span>
                  <strong>{capturedSession.profileSnapshot.name}</strong>
                </p>
                <p className="profile-description">{copy.blocked.profileContext(capturedSession.profileSnapshot.name)}</p>
                <p className="end-time">{copy.blocked.endTime(formatEndTime(capturedSession.endsAt))}</p>
                <p className="remaining" aria-label={`${copy.blocked.remainingLabel}: ${remaining}`}>
                  {remaining}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="released-content">
            <p className="message">{copy.blocked.releasedMessage}</p>
            <p className="released-reason">{copy.blocked.releasedReason}</p>
            {captured.destination ? (
              <button
                className="return"
                type="button"
                onClick={() => adapter.navigation.assign(captured.destination!)}
              >
                {copy.blocked.returnTo(captured.hostname)}
              </button>
            ) : (
              <p className="no-destination">{copy.blocked.noDestination}</p>
            )}
          </div>
        )}
      </section>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{statusAnnouncement}</p>
    </main>
  );
}

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement) createRoot(rootElement).render(<BlockedPage />);
}
