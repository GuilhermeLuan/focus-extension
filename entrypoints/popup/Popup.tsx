import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundError, BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { createConfirmationModel, type ConfirmationModel } from "../../src/application/confirmation";
import { getCancelSessionPresentation } from "../../src/application/cancellation";
import { createHoldController, type HoldController } from "../../src/application/hold";
import {
  formatEndTime,
  formatRemaining,
  formatSiteCount,
  popupErrorMessage,
  presentationCopy as copy
} from "../../src/presentation/catalog";

export type PopupAdapter = {
  runtime: {
    sendMessage(request: BackgroundRequest): Promise<StateResponse>;
    openOptionsPage(): Promise<void>;
  };
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ url?: string }>>;
  };
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>) => void): void;
      removeListener(listener: (changes: Record<string, unknown>) => void): void;
    };
  };
  close(): void;
  confirm(message: string): boolean;
};

export type PopupProps = {
  adapter: PopupAdapter;
  clock?: () => number;
};

const durationOptions = Array.from({ length: 36 }, (_, index) => (index + 1) * 5);
const defaultClock = () => Date.now();
type PopupErrorCode = BackgroundError | "UNEXPECTED";

const profileRecoveryErrors = new Set<PopupErrorCode>([
  "PROFILE_EMPTY",
  "PROFILE_REQUIRED",
  "PROFILE_NOT_FOUND",
  "INVALID_DURATION",
  "PRIVATE_PERMISSION_REQUIRED"
]);

const stateRecoveryErrors = new Set<PopupErrorCode>([
  "SESSION_ALREADY_ACTIVE",
  "NO_ACTIVE_SESSION",
  "CANCEL_WINDOW_CLOSED"
]);

export function Popup({ adapter, clock = defaultClock }: PopupProps) {
  const [state, setState] = useState<ExtensionState>();
  const [error, setError] = useState<{ code: PopupErrorCode; message: string }>();
  const [now, setNow] = useState(() => clock());
  const [durationMinutes, setDurationMinutes] = useState(50);
  const [confirmation, setConfirmation] = useState<ConfirmationModel>();
  const [holdProgress, setHoldProgress] = useState(0);
  const [holdVersion, setHoldVersion] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelWindowClosedForSession, setCancelWindowClosedForSession] = useState<string>();
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const holdRef = useRef<HoldController | undefined>(undefined);
  const cancellingRef = useRef(false);
  const startingRef = useRef(false);
  const retryActionRef = useRef<() => void | Promise<void>>(() => undefined);
  const previousSessionRef = useRef<{ id: string; canCancel: boolean } | undefined>(undefined);

  const send = (request: BackgroundRequest): Promise<StateResponse> => adapter.runtime.sendMessage(request);

  const clearError = () => setError(undefined);

  const showError = (code: PopupErrorCode, retry?: () => void | Promise<void>) => {
    setError({ code, message: popupErrorMessage(code) });
    retryActionRef.current = retry ?? (() => void refresh());
  };

  const refresh = async () => {
    try {
      const response = await send({ type: "GET_STATE" });
      if (response.ok) {
        setState(response.data);
        if (!response.data.activeSession) {
          const savedDuration = response.data.configuration.lastDurationMinutes;
          setDurationMinutes(durationOptions.includes(savedDuration) ? savedDuration : 50);
          setCancelWindowClosedForSession(undefined);
        }
        clearError();
      } else {
        showError(response.error, refresh);
      }
    } catch {
      showError("UNEXPECTED", refresh);
    }
  };

  useEffect(() => {
    void refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.configuration || changes.activeSession) void refresh();
    };
    adapter.storage.onChanged.addListener(onChanged);
    return () => adapter.storage.onChanged.removeListener(onChanged);
  }, [adapter]);

  useEffect(() => {
    if (state?.activeSession) return;
    const savedDuration = state?.configuration.lastDurationMinutes;
    if (savedDuration !== undefined) {
      setDurationMinutes(durationOptions.includes(savedDuration) ? savedDuration : 50);
    }
  }, [state?.configuration.lastDurationMinutes, state?.activeSession]);

  useEffect(() => {
    if (!state?.activeSession) return;
    setNow(clock());
    const timer = window.setInterval(() => setNow(clock()), 1000);
    const deadlineTimer = window.setTimeout(
      () => setNow(clock()),
      Math.max(0, state.activeSession.cancelAllowedUntil - clock())
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(deadlineTimer);
    };
  }, [clock, state?.activeSession?.id, state?.activeSession?.cancelAllowedUntil]);

  const active = state?.activeSession;
  const cancelPresentation = active && cancelWindowClosedForSession !== active.id
    ? getCancelSessionPresentation(active, now)
    : { canCancel: false as const };
  useEffect(() => {
    if (!active) return;
    const canCancel = cancelPresentation.canCancel;
    const previous = previousSessionRef.current;
    if (!previous || previous.id !== active.id) {
      setStatusAnnouncement(canCancel ? copy.announcements.started : copy.announcements.protected);
    } else if (previous.canCancel && !canCancel) {
      setStatusAnnouncement(copy.announcements.protected);
    }
    previousSessionRef.current = { id: active.id, canCancel };
  }, [active?.id, active?.cancelAllowedUntil, cancelPresentation.canCancel, cancelWindowClosedForSession]);

  const selectedProfile = useMemo(
    () => state?.configuration.profiles.find((profile) => profile.id === state.configuration.lastSelectedProfileId)
      ?? state?.configuration.profiles[0],
    [state]
  );
  const idleEndTime = useMemo(
    () => formatEndTime(now + durationMinutes * 60_000),
    [durationMinutes, now]
  );
  const remaining = useMemo(
    () => (active ? formatRemaining(active.endsAt, now) : undefined),
    [active, now]
  );

  const selectProfile = async (profileId: string) => {
    const response = await send({ type: "SELECT_PROFILE", profileId });
    if (response.ok) {
      setState(response.data);
      clearError();
    } else {
      showError(response.error, () => void selectProfile(profileId));
    }
  };

  const startSession = async () => {
    const currentConfirmation = confirmation;
    if (!currentConfirmation || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setHoldProgress(1);
    try {
      const response = await send({
        type: "START_SESSION",
        profileId: currentConfirmation.profileId,
        durationMinutes: currentConfirmation.durationMinutes
      });
      if (response.ok) {
        setState(response.data);
        setConfirmation(undefined);
        clearError();
      } else {
        showError(response.error, clearError);
      }
    } catch {
      showError("UNEXPECTED", clearError);
    } finally {
      startingRef.current = false;
      setIsStarting(false);
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
        setStatusAnnouncement(copy.announcements.cancelled);
        clearError();
      } else if (response.error === "CANCEL_WINDOW_CLOSED") {
        setCancelWindowClosedForSession(current.id);
        setStatusAnnouncement(copy.announcements.protected);
        showError(response.error, refresh);
      } else {
        showError(response.error, refresh);
      }
    } catch {
      showError("UNEXPECTED", () => void cancelSession());
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
      now: clock,
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
  }, [clock, confirmation, holdVersion]);

  const enterConfirmation = () => {
    if (!selectedProfile) return;
    clearError();
    setStatusAnnouncement(copy.announcements.review);
    setConfirmation(createConfirmationModel(selectedProfile, durationMinutes, clock()));
  };

  const blockCurrentSite = async () => {
    try {
      const tabs = await adapter.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      if (!url) {
        showError("URL_UNAVAILABLE", blockCurrentSite);
        return;
      }
      let response = await send({ type: "BLOCK_CURRENT_SITE", url });
      if (!response.ok && response.error === "CONFIRM_CONSOLIDATION" && response.consolidation && selectedProfile) {
        const hosts = response.consolidation.removedHosts.map((host) => host.displayHost).join(", ");
        if (adapter.confirm(copy.prompts.consolidation(hosts))) {
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
        clearError();
      } else {
        showError(response.error, blockCurrentSite);
      }
    } catch {
      showError("UNEXPECTED", blockCurrentSite);
    }
  };

  const openOptions = async () => {
    await adapter.runtime.openOptionsPage();
    adapter.close();
  };

  const errorRecovery = error
    ? profileRecoveryErrors.has(error.code)
      ? { label: copy.recoveries.recoverProfiles, action: openOptions }
      : stateRecoveryErrors.has(error.code)
        ? { label: copy.recoveries.refreshState, action: refresh }
        : { label: copy.recoveries.retry, action: () => retryActionRef.current() }
    : undefined;

  const cancelSeconds = active
    ? Math.ceil(Math.max(0, active.cancelAllowedUntil - now) / 1000)
    : 0;
  const errorPanel = error ? (
    <div className="error-panel">
      <p className="error-message" role="alert">{error.message}</p>
      {errorRecovery && (
        <button className="secondary error-recovery" type="button" onClick={() => void errorRecovery.action()}>
          {errorRecovery.label}
        </button>
      )}
    </div>
  ) : null;

  return (
    <main className="popup">
      <header className="popup-header">
        <div>
          <p className="eyebrow">{copy.brand}</p>
          <h1>{copy.title}</h1>
        </div>
        <span className="leaf" aria-hidden="true" />
      </header>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{statusAnnouncement}</p>

      {!state && !error ? <p className="loading">{copy.loading}</p> : null}
      {!state && error ? <section className="load-error" aria-label={copy.recoveries.loadLabel}>{errorPanel}</section> : null}
      {active ? (
        <section className={`active${error ? " has-error" : ""}`} aria-label={copy.active.sectionLabel}>
          {errorPanel}
          <p className="active-kicker">{copy.active.sectionLabel}</p>
          <p className="label">{copy.active.status}</p>
          <p className="active-state"><strong>{cancelPresentation.canCancel ? copy.active.cancelable : copy.active.protected}</strong></p>
          <p className="remaining">{remaining}</p>
          <p className="active-end">{copy.active.endTime(formatEndTime(active.endsAt))}</p>
          <p className="label">{copy.active.profileLabel}</p>
          <p className="hostname"><strong>{active.profileSnapshot.name}</strong></p>
          <p className="muted">{formatSiteCount(active.profileSnapshot.domains.length)}</p>
          {cancelPresentation.canCancel && (
            <button className="danger" type="button" disabled={isCancelling} onClick={() => void cancelSession()}>
              {copy.active.cancel(cancelSeconds)}
            </button>
          )}
          {!cancelPresentation.canCancel && <p className="protected-note">{copy.active.protectedNote}</p>}
          <p className="muted active-read-only">{copy.active.readOnly}</p>
        </section>
      ) : confirmation ? (
        <section className="confirmation" aria-label={copy.confirmation.sectionLabel}>
          {errorPanel}
          <p className="label">{copy.confirmation.kicker}</p>
          <p className="summary-profile"><strong>{confirmation.profileName}</strong></p>
          <p className="muted">{formatSiteCount(confirmation.hostnameCount)}</p>
          <p className="summary-line">{copy.confirmation.summary(confirmation.durationMinutes)}</p>
          <p className="summary-end">{copy.confirmation.endTime(formatEndTime(confirmation.endsAt))}</p>
          <p className="confirmation-note">{copy.confirmation.notice}</p>
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
            <span className="hold-label">{holdProgress >= 1 ? copy.confirmation.starting : copy.confirmation.hold}</span>
          </button>
          <button className="secondary" type="button" disabled={isStarting} onClick={() => setConfirmation(undefined)}>
            {copy.confirmation.back}
          </button>
        </section>
      ) : state ? (
        <section className="idle" aria-label={copy.idle.sectionLabel}>
          {errorPanel}
          <div className="garden-time">
            <p className="quiet">{copy.idle.status}</p>
            <p className="time">{copy.idle.duration(durationMinutes)}</p>
            <p className="end">{copy.idle.endTime(idleEndTime)}</p>
          </div>
          <div className="profile-line">
            <label htmlFor="profile">{copy.idle.profileLabel}</label>
            <span className="profile-count">{formatSiteCount(selectedProfile?.domains.length ?? 0)}</span>
          </div>
          <select
            id="profile"
            aria-label={copy.idle.profileLabel}
            value={selectedProfile?.id ?? ""}
            onChange={(event) => void selectProfile(event.target.value)}
          >
            {state.configuration.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
          <label htmlFor="duration">{copy.idle.durationLabel}</label>
          <select
            id="duration"
            aria-label={copy.idle.durationLabel}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
          >
            {durationOptions.map((option) => <option key={option} value={option}>{copy.idle.durationOption(option)}</option>)}
          </select>
          <button className="secondary" type="button" onClick={() => void blockCurrentSite()}>
            {copy.idle.blockCurrentSite}
          </button>
          <button className="primary" type="button" disabled={!selectedProfile} onClick={enterConfirmation}>
            {copy.idle.reviewAndStart}
          </button>
          <button className="options-link" type="button" onClick={() => void openOptions()}>
            {copy.idle.manageProfiles}
          </button>
        </section>
      ) : null}
    </main>
  );
}
