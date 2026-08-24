import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { ExtensionState, StateResponse } from "../../src/domain/types";
import { createBlockedPageModel, getSafeDestination } from "../../src/application/blocked";
import "./style.css";

const sendState = (): Promise<StateResponse> =>
  browser.runtime.sendMessage({ type: "GET_STATE" }) as Promise<StateResponse>;

function formatRemaining(endsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function BlockedPage() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [now, setNow] = useState(Date.now());
  const captured = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      hostname: params.get("hostname") ?? "site",
      sessionId: params.get("sessionId") ?? undefined,
      destination: getSafeDestination(params.get("destination") ?? undefined)
    };
  }, []);

  useEffect(() => {
    const refresh = () => {
      void sendState().then((response) => {
        if (response.ok) setState(response.data);
      });
    };
    refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.configuration || changes.activeSession) refresh();
    };
    browser.storage.onChanged.addListener(onChanged as never);
    return () => browser.storage.onChanged.removeListener(onChanged as never);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const session = state?.activeSession;
  const model = createBlockedPageModel(captured.sessionId, session);
  const blocked = state === undefined || model.status === "blocked";
  const profileName = session?.profileSnapshot.name ?? "Foco";

  return (
    <main className="blocked" aria-live="polite">
      <p className="eyebrow">FOCUS LOCK</p>
      <div className="orb" aria-hidden="true">●</div>
      <p className="kicker">Navegação pausada</p>
      <h1>{captured.hostname}</h1>
      {blocked ? (
        <>
          <p className="message">Este hostname está bloqueado pelo perfil <strong>{profileName}</strong>.</p>
          {session && <p className="remaining">{formatRemaining(session.endsAt, now)}</p>}
        </>
      ) : (
        <>
          <p className="message">A sessão terminou ou foi cancelada.</p>
          {captured.destination && (
            <button className="return" type="button" onClick={() => window.location.assign(captured.destination!)}>
              Voltar ao site
            </button>
          )}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<BlockedPage />);
