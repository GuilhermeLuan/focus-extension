import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import "./style.css";

const send = (request: BackgroundRequest): Promise<StateResponse> =>
  browser.runtime.sendMessage(request) as Promise<StateResponse>;

function formatRemaining(endsAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function Popup() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());

  const refresh = async () => {
    const response = await send({ type: "GET_STATE" });
    if (response.ok) {
      setState(response.data);
      setHostname(response.data.configuration.profile.hostname ?? "");
      setError(undefined);
    } else {
      setError(response.error);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!state?.activeSession) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.activeSession]);

  const active = state?.activeSession;
  const remaining = useMemo(
    () => (active ? formatRemaining(active.endsAt, now) : undefined),
    [active, now]
  );

  const saveHostname = async () => {
    const response = await send({ type: "SET_HOSTNAME", hostname });
    if (response.ok) {
      setState(response.data);
      setHostname(response.data.configuration.profile.hostname ?? "");
      setError(undefined);
    } else {
      setError(response.error);
    }
  };

  const startSession = async () => {
    const response = await send({ type: "START_SESSION" });
    if (response.ok) {
      setState(response.data);
      setError(undefined);
    } else {
      setError(response.error);
    }
  };

  return (
    <main className="popup" aria-live="polite">
      <p className="eyebrow">FOCUS LOCK</p>
      <h1>Pomodoro</h1>
      <p className="profile">Perfil: <strong>Foco</strong></p>

      {active ? (
        <section className="active" aria-label="Sessão ativa">
          <p className="label">Hostname bloqueado</p>
          <p className="hostname">{active.profileSnapshot.hostname}</p>
          <p className="remaining">{remaining}</p>
          <p className="muted">O foco termina em breve.</p>
        </section>
      ) : (
        <section className="idle">
          <label htmlFor="hostname">Hostname</label>
          <input
            id="hostname"
            type="text"
            value={hostname}
            placeholder="youtube.com"
            onChange={(event) => setHostname(event.target.value)}
          />
          <button className="secondary" type="button" onClick={() => void saveHostname()}>
            Salvar
          </button>
          <button
            className="primary"
            type="button"
            disabled={!state?.configuration.profile.hostname}
            onClick={() => void startSession()}
          >
            Iniciar 50 min
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
