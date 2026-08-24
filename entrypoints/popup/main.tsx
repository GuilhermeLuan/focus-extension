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

function errorMessage(error: string): string {
  const messages: Record<string, string> = {
    INVALID_HOSTNAME: "Informe um hostname ou URL HTTP(S) válido.",
    PROTECTED_HOSTNAME: "Esse host é protegido pelo Firefox.",
    HOST_ALREADY_COVERED: "Essa regra já está coberta por outra.",
    PROFILE_EMPTY: "Adicione pelo menos uma regra antes de iniciar.",
    SESSION_ALREADY_ACTIVE: "Já existe uma sessão em andamento.",
    URL_UNAVAILABLE: "A aba atual não tem uma URL HTTP(S) disponível.",
    STORAGE_ERROR: "Não foi possível carregar o Focus Lock."
  };
  return messages[error] ?? error;
}

function Popup() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());

  const refresh = async () => {
    const response = await send({ type: "GET_STATE" });
    if (response.ok) {
      setState(response.data);
      setError(undefined);
    } else {
      setError(errorMessage(response.error));
    }
  };

  useEffect(() => {
    void refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.configuration || changes.activeSession) void refresh();
    };
    browser.storage.onChanged.addListener(onChanged as never);
    return () => browser.storage.onChanged.removeListener(onChanged as never);
  }, []);

  useEffect(() => {
    if (!state?.activeSession) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.activeSession]);

  const active = state?.activeSession;
  const selectedProfile = useMemo(
    () => state?.configuration.profiles.find((profile) => profile.id === state.configuration.lastSelectedProfileId),
    [state]
  );
  const remaining = useMemo(
    () => (active ? formatRemaining(active.endsAt, now) : undefined),
    [active, now]
  );

  const selectProfile = async (profileId: string) => {
    const response = await send({ type: "SELECT_PROFILE", profileId });
    if (response.ok) {
      setState(response.data);
      setError(undefined);
    } else setError(errorMessage(response.error));
  };

  const startSession = async () => {
    const response = await send({ type: "START_SESSION" });
    if (response.ok) {
      setState(response.data);
      setError(undefined);
    } else setError(errorMessage(response.error));
  };

  const blockCurrentSite = async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url;
    if (!url) {
      setError(errorMessage("URL_UNAVAILABLE"));
      return;
    }
    let response = await send({ type: "BLOCK_CURRENT_SITE", url });
    if (!response.ok && response.error === "CONFIRM_CONSOLIDATION" && response.consolidation && selectedProfile) {
      const hosts = response.consolidation.removedHosts.map((host) => host.displayHost).join(", ");
      if (window.confirm(`Esta regra absorve ${hosts}. Continuar?`)) {
        response = await send({
          type: "ADD_BLOCKED_HOST",
          profileId: selectedProfile.id,
          input: url,
          confirmConsolidation: true
        });
      }
    }
    if (response.ok) {
      setState(response.data);
      setError(undefined);
    } else setError(errorMessage(response.error));
  };

  const openOptions = async () => {
    await browser.runtime.openOptionsPage();
    window.close();
  };

  return (
    <main className="popup" aria-live="polite">
      <p className="eyebrow">FOCUS LOCK</p>
      <h1>Pomodoro</h1>

      {active ? (
        <section className="active" aria-label="Sessão ativa">
          <p className="label">Perfil em foco</p>
          <p className="hostname"><strong>{active.profileSnapshot.name}</strong></p>
          <ul className="host-list">
            {active.profileSnapshot.domains.map((host) => <li key={host.canonicalHost}>{host.displayHost}</li>)}
          </ul>
          <button className="secondary" type="button" disabled>Bloquear este site</button>
          <p className="remaining">{remaining}</p>
          <p className="muted">As regras ficam somente para leitura durante a sessão.</p>
        </section>
      ) : (
        <section className="idle">
          <label htmlFor="profile">Perfil</label>
          <select
            id="profile"
            value={selectedProfile?.id ?? ""}
            onChange={(event) => void selectProfile(event.target.value)}
          >
            {state?.configuration.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
          <p className="muted">{selectedProfile?.domains.length ?? 0} regra(s) de bloqueio</p>
          <button className="secondary" type="button" onClick={() => void blockCurrentSite()}>
            Bloquear este site
          </button>
          <button
            className="primary"
            type="button"
            disabled={!selectedProfile?.domains.length}
            onClick={() => void startSession()}
          >
            Iniciar 50 min
          </button>
          <button className="options-link" type="button" onClick={() => void openOptions()}>
            Gerenciar perfis
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
