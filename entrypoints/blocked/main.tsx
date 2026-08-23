import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { ExtensionState, StateResponse } from "../../src/domain/types";
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
  const hostname = useMemo(() => new URLSearchParams(window.location.search).get("hostname") ?? "site", []);

  useEffect(() => {
    void sendState().then((response) => {
      if (response.ok) setState(response.data);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const session = state?.activeSession;
  const ended = !session || session.endsAt <= now;

  return (
    <main className="blocked" aria-live="polite">
      <p className="eyebrow">FOCUS LOCK</p>
      <div className="orb" aria-hidden="true">●</div>
      <p className="kicker">Navegação pausada</p>
      <h1>{hostname}</h1>
      {ended ? (
        <p className="message">A sessão terminou.</p>
      ) : (
        <>
          <p className="message">Este hostname está bloqueado pelo perfil <strong>Foco</strong>.</p>
          <p className="remaining">{formatRemaining(session.endsAt, now)}</p>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<BlockedPage />);
