import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import {
  BackupValidationError,
  decodeBackupFile,
  parseConfigurationBackup,
  preImportBackupFileName,
  serializeConfigurationBackup,
  summarizeConfigurationBackup,
  type BackupSummary
} from "../../src/application/backup";
import { downloadJsonFile } from "./download";
import {
  popupErrorMessage,
  presentationCopy as copy
} from "../../src/presentation/catalog";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ExportConfigurationData,
  ExtensionState,
  StateResponse
} from "../../src/domain/types";
import "./style.css";

export type OptionsAdapter = {
  runtime: {
    sendMessage(request: BackgroundRequest): Promise<StateResponse | BackgroundResponse<ExportConfigurationData>>;
  };
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>) => void): void;
      removeListener(listener: (changes: Record<string, unknown>) => void): void;
    };
  };
  download(fileName: string, content: string): void;
  confirm(message: string): boolean;
};

export type OptionsProps = { adapter?: OptionsAdapter };

type ConsolidationPrompt = { profileId: string; input: string; hosts: string[] };

type SelectedBackup = { content: string; summary: BackupSummary };

function createDefaultAdapter(): OptionsAdapter {
  return {
    runtime: {
      sendMessage: (request) => browser.runtime.sendMessage(request) as Promise<StateResponse | BackgroundResponse<ExportConfigurationData>>
    },
    storage: {
      onChanged: {
        addListener: (listener) => browser.storage.onChanged.addListener(listener as never),
        removeListener: (listener) => browser.storage.onChanged.removeListener(listener as never)
      }
    },
    download: downloadJsonFile,
    confirm: (message) => window.confirm(message)
  };
}

const defaultAdapter = createDefaultAdapter();

function backupErrorMessage(error: unknown): string {
  if (error instanceof BackupValidationError) {
    if (error.code === "BACKUP_TOO_LARGE") return copy.options.errors.backupTooLarge;
    if (error.code === "UNSUPPORTED_BACKUP_VERSION") return copy.options.errors.unsupportedBackupVersion;
    return copy.options.errors.invalidBackup;
  }
  return copy.options.errors.fileRead;
}

function serviceErrorMessage(error: string): string {
  if (error === "CONFIGURATION_CHANGED") return copy.options.errors.configurationChanged;
  if (error === "IMPORT_SESSION_ACTIVE") return copy.options.errors.importSessionActive;
  return popupErrorMessage(error);
}

function profileFromState(state: ExtensionState | undefined, profileId: string | undefined) {
  return state?.configuration.profiles.find((profile) => profile.id === profileId);
}

export function Options({ adapter = defaultAdapter }: OptionsProps) {
  const [state, setState] = useState<ExtensionState>();
  const [profileName, setProfileName] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [error, setError] = useState<string>();
  const [consolidation, setConsolidation] = useState<ConsolidationPrompt>();
  const [selectedBackup, setSelectedBackup] = useState<SelectedBackup>();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const hostInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => profileFromState(state, state?.configuration.lastSelectedProfileId),
    [state]
  );
  const locked = Boolean(selected && state?.activeSession?.profileSnapshot.id === selected.id);

  const setStateAndProfileName = (next: ExtensionState) => {
    setState(next);
    setRenameInput(profileFromState(next, next.configuration.lastSelectedProfileId)?.name ?? "");
  };

  const refresh = async () => {
    try {
      const response = await adapter.runtime.sendMessage({ type: "GET_STATE" });
      if (response.ok && "configuration" in response.data) {
        setStateAndProfileName(response.data);
        setError(undefined);
      } else if (!response.ok) setError(serviceErrorMessage(response.error));
      else setError(popupErrorMessage("STORAGE_ERROR"));
    } catch {
      setError(popupErrorMessage("STORAGE_ERROR"));
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

  const run = async (request: BackgroundRequest): Promise<boolean> => {
    try {
      const response = await adapter.runtime.sendMessage(request);
      if (response.ok) {
        if ("configuration" in response.data) setStateAndProfileName(response.data);
        setError(undefined);
        return true;
      }
      if (response.error === "CONFIRM_CONSOLIDATION" && response.consolidation && request.type === "ADD_BLOCKED_HOST") {
        setConsolidation({
          profileId: request.profileId,
          input: request.input,
          hosts: response.consolidation.removedHosts.map((host) => host.displayHost)
        });
      } else setError(serviceErrorMessage(response.error));
    } catch {
      setError(popupErrorMessage("STORAGE_ERROR"));
    }
    return false;
  };

  const createProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await run({ type: "CREATE_PROFILE", name: profileName })) setProfileName("");
  };

  const renameProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected && !locked) await run({ type: "RENAME_PROFILE", profileId: selected.id, name: renameInput });
  };

  const deleteProfile = async () => {
    if (!selected || locked || (state?.configuration.profiles.length ?? 0) <= 1) return;
    if (!adapter.confirm(copy.options.profiles.deleteConfirmation(selected.name, selected.domains.length))) return;
    await run({ type: "DELETE_PROFILE", profileId: selected.id });
  };

  const selectProfile = async (profileId: string) => {
    setConsolidation(undefined);
    await run({ type: "SELECT_PROFILE", profileId });
  };

  const addHost = async (event: Pick<React.FormEvent, "preventDefault"> | undefined, confirmConsolidation = false) => {
    event?.preventDefault();
    if (locked || (!selected && !consolidation)) return;
    const profileId = confirmConsolidation ? consolidation?.profileId : selected?.id;
    const input = confirmConsolidation ? consolidation?.input : hostInput;
    if (!profileId || !input) return;
    const succeeded = await run({
      type: "ADD_BLOCKED_HOST",
      profileId,
      input,
      ...(confirmConsolidation ? { confirmConsolidation: true } : {})
    });
    if (succeeded) {
      setHostInput("");
      setConsolidation(undefined);
    }
  };

  const cancelConsolidation = () => {
    setConsolidation(undefined);
    hostInputRef.current?.focus();
  };

  const selectBackupFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelectedBackup(undefined);
    setError(undefined);
    if (!file) return;
    try {
      const content = await decodeBackupFile(file);
      const parsed = parseConfigurationBackup(content);
      setSelectedBackup({ content, summary: summarizeConfigurationBackup(parsed) });
    } catch (fileError) {
      setError(backupErrorMessage(fileError));
    }
  };

  const exportConfiguration = async () => {
    setExporting(true);
    setError(undefined);
    try {
      const response = await adapter.runtime.sendMessage({ type: "EXPORT_CONFIGURATION" });
      if (response.ok && "fileName" in response.data) adapter.download(response.data.fileName, response.data.content);
      else if (!response.ok) setError(serviceErrorMessage(response.error));
      else setError(copy.options.errors.export);
    } catch {
      setError(copy.options.errors.export);
    } finally {
      setExporting(false);
    }
  };

  const refreshAfterImportRejection = async (message: string) => {
    try {
      const response = await adapter.runtime.sendMessage({ type: "GET_STATE" });
      if (response.ok && "configuration" in response.data) setStateAndProfileName(response.data);
    } catch {
      // Keep the actionable import error when refreshing the state is unavailable.
    }
    setError(message);
  };

  const replaceConfiguration = async () => {
    if (!selectedBackup || state?.activeSession) return;
    if (!adapter.confirm(copy.options.backup.replaceConfirmation)) return;

    setImporting(true);
    setError(undefined);
    try {
      const currentResponse = await adapter.runtime.sendMessage({ type: "GET_STATE" });
      if (!currentResponse.ok || !("configuration" in currentResponse.data)) {
        setError(!currentResponse.ok ? serviceErrorMessage(currentResponse.error) : copy.options.errors.import);
        return;
      }
      setStateAndProfileName(currentResponse.data);
      if (currentResponse.data.activeSession) {
        setError(copy.options.errors.importSessionActive);
        return;
      }

      const preventiveNow = Date.now();
      const preventive = serializeConfigurationBackup(currentResponse.data.configuration, preventiveNow);
      adapter.download(preImportBackupFileName(new Date(preventiveNow).toISOString()), preventive.content);

      const response = await adapter.runtime.sendMessage({
        type: "IMPORT_CONFIGURATION",
        content: selectedBackup.content,
        expectedCurrentConfiguration: currentResponse.data.configuration
      });
      if (response.ok && "configuration" in response.data) {
        setStateAndProfileName(response.data);
        setSelectedBackup(undefined);
        setConsolidation(undefined);
        if (backupInputRef.current) backupInputRef.current.value = "";
        setError(undefined);
      } else if (!response.ok && (response.error === "CONFIGURATION_CHANGED" || response.error === "IMPORT_SESSION_ACTIVE")) {
        await refreshAfterImportRejection(serviceErrorMessage(response.error));
      } else if (!response.ok) setError(serviceErrorMessage(response.error));
    } catch {
      setError(copy.options.errors.import);
    } finally {
      setImporting(false);
    }
  };

  return (
    <main className="options" aria-label={copy.options.sectionLabel}>
      <header className="options-header">
        <div>
          <p className="eyebrow">{copy.brand}</p>
          <h1>{copy.options.title}</h1>
          <p className="intro">{copy.options.intro}</p>
        </div>
        <span className="leaf" aria-hidden="true" />
      </header>

      <div className="settings-grid">
        <aside className="profile-navigation" aria-label={copy.options.profiles.navigationLabel}>
          <p className="section-kicker">{copy.options.profiles.listHeading}</p>
          <div className="profile-list">
            {state?.configuration.profiles.map((profile) => (
              <button
                key={profile.id}
                className="profile-option"
                type="button"
                aria-current={profile.id === selected?.id ? "true" : undefined}
                onClick={() => void selectProfile(profile.id)}
              >
                <span>{profile.name}</span>
                <small>{copy.options.profiles.count(profile.domains.length)}</small>
              </button>
            ))}
          </div>
          <form className="profile-create" onSubmit={(event) => void createProfile(event)}>
            <label htmlFor="new-profile">{copy.options.profiles.newProfileLabel}</label>
            <input
              id="new-profile"
              value={profileName}
              placeholder={copy.options.profiles.newProfilePlaceholder}
              onChange={(event) => setProfileName(event.target.value)}
            />
            <button type="submit">{copy.options.profiles.create}</button>
          </form>
        </aside>

        <section className="profile-editor" aria-label={copy.options.profiles.selected}>
          {selected ? (
            <>
              <header className="editor-header">
                <p className="section-kicker">{copy.options.profiles.selected}</p>
                <h2>{selected.name}</h2>
                <p className="profile-count">{copy.options.profiles.count(selected.domains.length)}</p>
              </header>

              <form className="rename-form" onSubmit={(event) => void renameProfile(event)}>
                <label htmlFor="rename">{copy.options.profiles.nameLabel}</label>
                <div className="field-line">
                  <input id="rename" value={renameInput} disabled={locked} onChange={(event) => setRenameInput(event.target.value)} />
                  <button type="submit" disabled={locked}>{copy.options.profiles.saveName}</button>
                </div>
              </form>

              <section className="hosts-editor" aria-labelledby="hosts-heading">
                <h3 id="hosts-heading">{copy.options.hosts.heading}</h3>
                <form className="host-form" onSubmit={(event) => void addHost(event)}>
                  <label htmlFor="host-input">{copy.options.hosts.label}</label>
                  <p id="host-help" className="field-help">{copy.options.hosts.help}</p>
                  <div className="field-line">
                    <input
                      ref={hostInputRef}
                      id="host-input"
                      value={hostInput}
                      disabled={locked}
                      placeholder={copy.options.hosts.placeholder}
                      aria-describedby="host-help"
                      onChange={(event) => setHostInput(event.target.value)}
                    />
                    <button type="submit" disabled={locked}>{copy.options.hosts.add}</button>
                  </div>
                </form>
                {consolidation && (
                  <div className="consolidation" role="alertdialog" aria-label={copy.options.hosts.consolidationLabel}>
                    <p>{copy.options.hosts.consolidation(consolidation.hosts.join(", "))}</p>
                    <div className="action-row">
                      <button type="button" onClick={() => void addHost(undefined, true)}>
                        {copy.options.hosts.confirmConsolidation}
                      </button>
                      <button className="secondary" type="button" onClick={cancelConsolidation}>{copy.options.hosts.cancel}</button>
                    </div>
                  </div>
                )}
                {selected.domains.length ? (
                  <ul className="rules">
                    {selected.domains.map((host) => (
                      <li key={host.canonicalHost}>
                        <span title={host.canonicalHost}>{host.displayHost}</span>
                        <button
                          type="button"
                          disabled={locked}
                          aria-label={copy.options.hosts.remove(host.displayHost)}
                          onClick={() => void run({ type: "REMOVE_BLOCKED_HOST", profileId: selected.id, canonicalHost: host.canonicalHost })}
                        >
                          {copy.options.hosts.remove(host.displayHost)}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="empty-note">{copy.options.hosts.empty}</p>}
              </section>

              <div className="profile-actions">
                <button className="danger-link" type="button" disabled={locked || (state?.configuration.profiles.length ?? 0) <= 1} onClick={() => void deleteProfile()}>
                  {copy.options.profiles.delete}
                </button>
                {(state?.configuration.profiles.length ?? 0) <= 1 && <p className="field-help">{copy.options.profiles.lastProfileNote}</p>}
              </div>
              {locked && <p className="readonly-status" role="status">{copy.options.profiles.sessionReadOnly}</p>}
            </>
          ) : <p className="loading" role="status">{copy.loading}</p>}
        </section>
      </div>

      <section className="backup-card" aria-label={copy.options.backup.sectionLabel}>
        <h2>{copy.options.backup.sectionLabel}</h2>
        <p className="field-help">{copy.options.backup.description}</p>
        <button type="button" disabled={exporting} onClick={() => void exportConfiguration()}>
          {exporting ? copy.options.backup.exporting : copy.options.backup.export}
        </button>
        <label htmlFor="backup-file">{copy.options.backup.selectLabel}</label>
        <input
          ref={backupInputRef}
          id="backup-file"
          type="file"
          accept=".json,application/json"
          disabled={Boolean(state?.activeSession) || importing}
          onChange={(event) => void selectBackupFile(event)}
        />
        {state?.activeSession && <p className="field-help" role="status">{copy.options.backup.activeNote}</p>}
        {selectedBackup && (
          <div className="backup-summary" aria-label={copy.options.backup.summaryLabel}>
            <p className="summary-title">{copy.options.backup.selected}</p>
            <dl>
              <div><dt>{copy.options.backup.exportedAt}</dt><dd>{selectedBackup.summary.exportedAt}</dd></div>
              <div><dt>{copy.options.backup.profiles}</dt><dd>{selectedBackup.summary.profileCount}</dd></div>
              <div><dt>{copy.options.backup.rules}</dt><dd>{selectedBackup.summary.ruleCount}</dd></div>
              <div><dt>{copy.options.backup.selectedProfile}</dt><dd>{selectedBackup.summary.selectedProfileName}</dd></div>
              <div><dt>{copy.options.backup.duration}</dt><dd>{copy.options.backup.durationValue(selectedBackup.summary.durationMinutes)}</dd></div>
            </dl>
            <button type="button" disabled={importing || Boolean(state?.activeSession)} onClick={() => void replaceConfiguration()}>
              {importing ? copy.options.backup.replacing : copy.options.backup.replace}
            </button>
          </div>
        )}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<Options />);
