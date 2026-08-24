import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { createConfirmationModel, type ConfirmationModel } from "../../src/application/confirmation";
import { getCancelSessionPresentation } from "../../src/application/cancellation";
import { createHoldController, type HoldController } from "../../src/application/hold";
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
    PROFILE_REQUIRED: "Selecione um perfil para iniciar.",
    PROFILE_NOT_FOUND: "O perfil selecionado não está mais disponível.",
    INVALID_DURATION: "Escolha uma duração entre 5 e 180 minutos, em passos de 5.",
    PRIVATE_PERMISSION_REQUIRED: "Permita o uso em janelas privadas nas configurações do Firefox.",
    SESSION_ALREADY_ACTIVE: "Já existe uma sessão em andamento.",
    URL_UNAVAILABLE: "A aba atual não tem uma URL HTTP(S) disponível.",
    NO_ACTIVE_SESSION: "Não há uma sessão ativa para cancelar.",
    CANCEL_WINDOW_CLOSED: "A janela de cancelamento terminou.",
    STORAGE_ERROR: "Não foi possível carregar o Focus Lock."
  };
  return messages[error] ?? error;
}

const durationOptions = Array.from({ length: 36 }, (_, index) => (index + 1) * 5);

function Popup() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  const [durationMinutes, setDurationMinutes] = useState(50);
  const [confirmation, setConfirmation] = useState<ConfirmationModel>();
  const [holdProgress, setHoldProgress] = useState(0);
  const [holdVersion, setHoldVersion] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelWindowClosedForSession, setCancelWindowClosedForSession] = useState<string | undefined>();
  const holdRef = useRef<HoldController | undefined>(undefined);
  const cancellingRef = useRef(false);

  const refresh = async () => {
    const response = await send({ type: "GET_STATE" });
    if (response.ok) {
      setState(response.data);
      if (!response.data.activeSession) {
        const savedDuration = response.data.configuration.lastDurationMinutes;
        setDurationMinutes(durationOptions.includes(savedDuration) ? savedDuration : 50);
        setCancelWindowClosedForSession(undefined);
      }
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
    if (state?.activeSession) return;
    const savedDuration = state?.configuration.lastDurationMinutes;
    if (savedDuration !== undefined) {
      setDurationMinutes(durationOptions.includes(savedDuration) ? savedDuration : 50);
    }
  }, [state?.configuration.lastDurationMinutes, state?.activeSession]);

  useEffect(() => {
    if (!state?.activeSession) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const deadlineTimer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, state.activeSession.cancelAllowedUntil - Date.now())
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(deadlineTimer);
    };
  }, [state?.activeSession?.id, state?.activeSession?.cancelAllowedUntil]);

  const active = state?.activeSession;
  const cancelPresentation = active && cancelWindowClosedForSession !== active.id
    ? getCancelSessionPresentation(active, now)
    : { canCancel: false as const };
  const selectedProfile = useMemo(
    () => state?.configuration.profiles.find((profile) => profile.id === state.configuration.lastSelectedProfileId)
      ?? state?.configuration.profiles[0],
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
    if (!confirmation) return;
    setIsStarting(true);
    setHoldProgress(1);
    const response = await send({
      type: "START_SESSION",
      profileId: confirmation.profileId,
      durationMinutes: confirmation.durationMinutes
    });
    if (response.ok) {
      setState(response.data);
      setConfirmation(undefined);
      setIsStarting(false);
      setError(undefined);
    } else {
      setIsStarting(false);
      setError(errorMessage(response.error));
      setHoldProgress(0);
      holdRef.current?.dispose();
      holdRef.current = undefined;
      setHoldVersion((version) => version + 1);
    }
  };

  const cancelSession = async () => {
    const current = state?.activeSession;
    if (!current || !getCancelSessionPresentation(current, now).canCancel || cancellingRef.current) return;
    cancellingRef.current = true;
    setIsCancelling(true);
    try {
      const response = await send({ type: "CANCEL_SESSION" });
      if (response.ok) {
        setState(response.data);
        setCancelWindowClosedForSession(undefined);
        setError(undefined);
      } else if (response.error === "CANCEL_WINDOW_CLOSED") {
        await refresh();
        setCancelWindowClosedForSession(current.id);
        setError("A janela de cancelamento terminou.");
      } else {
        setError(errorMessage(response.error));
      }
    } catch {
      setError(errorMessage("STORAGE_ERROR"));
    } finally {
      cancellingRef.current = false;
      setIsCancelling(false);
    }
  };

  const startSessionRef = useRef<() => void>(() => undefined);
  startSessionRef.current = () => void startSession();

  useEffect(() => {
    if (!confirmation) {
      holdRef.current?.dispose();
      holdRef.current = undefined;
      setHoldProgress(0);
      return;
    }
    const controller = createHoldController({
      now: () => Date.now(),
      timers: {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (timer) => window.clearTimeout(timer as number)
      },
      onComplete: () => startSessionRef.current()
    });
    holdRef.current = controller;
    const progressTimer = window.setInterval(() => setHoldProgress(controller.progress()), 40);
    return () => {
      window.clearInterval(progressTimer);
      controller.dispose();
      if (holdRef.current === controller) holdRef.current = undefined;
    };
  }, [confirmation, holdVersion]);

  const enterConfirmation = () => {
    if (!selectedProfile) return;
    setError(undefined);
    setConfirmation(createConfirmationModel(selectedProfile, durationMinutes, Date.now()));
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
          {cancelPresentation.canCancel && (
            <button className="secondary" type="button" disabled={isCancelling} onClick={() => void cancelSession()}>
              {cancelPresentation.label}
            </button>
          )}
          <p className="remaining">{remaining}</p>
          <p className="muted">As regras ficam somente para leitura durante a sessão.</p>
        </section>
      ) : confirmation ? (
        <section className="confirmation" aria-label="Resumo da sessão">
          <p className="label">Confira antes de iniciar</p>
          <p className="summary-profile"><strong>{confirmation.profileName}</strong></p>
          <p className="summary-line">{confirmation.durationMinutes} minutos · termina às {confirmation.endTimeLabel}</p>
          <p className="muted">{confirmation.hostnameLabel}</p>
          <button
            className="primary hold"
            type="button"
            disabled={isStarting}
            onPointerDown={(event) => holdRef.current?.pointerDown(event.button)}
            onPointerUp={() => {
              holdRef.current?.pointerUp();
              if (!isStarting) setHoldProgress(0);
            }}
            onPointerCancel={() => {
              holdRef.current?.pointerCancel();
              if (!isStarting) setHoldProgress(0);
            }}
            onPointerLeave={() => {
              holdRef.current?.pointerLeave();
              if (!isStarting) setHoldProgress(0);
            }}
            onBlur={() => {
              holdRef.current?.blur();
              if (!isStarting) setHoldProgress(0);
            }}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") event.preventDefault();
              holdRef.current?.keyDown(event.key, event.repeat);
            }}
            onKeyUp={(event) => {
              holdRef.current?.keyUp(event.key);
              if (!isStarting) setHoldProgress(0);
            }}
          >
            <span className="hold-progress" style={{ transform: `scaleX(${holdProgress})` }} aria-hidden="true" />
            <span className="hold-label">{holdProgress >= 1 ? "Iniciando…" : "Mantenha pressionado por 2 segundos"}</span>
          </button>
          <button className="secondary" type="button" disabled={isStarting} onClick={() => setConfirmation(undefined)}>
            Voltar
          </button>
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
          <label htmlFor="duration">Duração</label>
          <select
            id="duration"
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
          >
            {durationOptions.map((option) => <option key={option} value={option}>{option} minutos</option>)}
          </select>
          <button className="secondary" type="button" onClick={() => void blockCurrentSite()}>
            Bloquear este site
          </button>
          <button
            className="primary"
            type="button"
            disabled={!selectedProfile}
            onClick={enterConfirmation}
          >
            Avançar
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
