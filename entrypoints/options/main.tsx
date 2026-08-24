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
import type {
  BackgroundRequest,
  BackgroundResponse,
  ExportConfigurationData,
  ExtensionState,
  StateResponse
} from "../../src/domain/types";
import "./style.css";

type ConsolidationPrompt = {
  profileId: string;
  input: string;
  hosts: string[];
};

const send = (request: BackgroundRequest): Promise<StateResponse> =>
  browser.runtime.sendMessage(request) as Promise<StateResponse>;

const sendExport = (request: { type: "EXPORT_CONFIGURATION" }): Promise<BackgroundResponse<ExportConfigurationData>> =>
  browser.runtime.sendMessage(request) as Promise<BackgroundResponse<ExportConfigurationData>>;

type SelectedBackup = {
  content: string;
  summary: BackupSummary;
};

function backupErrorMessage(error: unknown): string {
  if (error instanceof BackupValidationError) {
    if (error.code === "BACKUP_TOO_LARGE") return "O backup excede o limite de 1 MiB.";
    if (error.code === "UNSUPPORTED_BACKUP_VERSION") return "A versão deste backup não é compatível.";
    return "O arquivo não é um backup Focus Lock válido.";
  }
  return "Não foi possível ler o arquivo de backup.";
}

function serviceErrorMessage(error: string): string {
  if (error === "CONFIGURATION_CHANGED") return "A configuração mudou. Verifique o arquivo e tente novamente.";
  if (error === "IMPORT_SESSION_ACTIVE") return "Encerre a sessão atual antes de substituir a configuração.";
  return error;
}

function Options() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [profileName, setProfileName] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [consolidation, setConsolidation] = useState<ConsolidationPrompt>();
  const [selectedBackup, setSelectedBackup] = useState<SelectedBackup>();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const response = await send({ type: "GET_STATE" });
    if (response.ok) {
      setState(response.data);
      const profile = response.data.configuration.profiles.find(
        (candidate) => candidate.id === response.data.configuration.lastSelectedProfileId
      );
      setRenameInput(profile?.name ?? "");
      setError(undefined);
    } else setError(response.error);
  };

  useEffect(() => {
    void refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.configuration || changes.activeSession) void refresh();
    };
    browser.storage.onChanged.addListener(onChanged as never);
    return () => browser.storage.onChanged.removeListener(onChanged as never);
  }, []);

  const selected = useMemo(
    () => state?.configuration.profiles.find((profile) => profile.id === state.configuration.lastSelectedProfileId),
    [state]
  );
  const locked = Boolean(selected && state?.activeSession?.profileSnapshot.id === selected.id);

  const run = async (request: BackgroundRequest) => {
    const response = await send(request);
    if (response.ok) {
      setState(response.data);
      setError(undefined);
      return true;
    }
    if (response.error === "CONFIRM_CONSOLIDATION" && response.consolidation) {
      setConsolidation({
        profileId: selected?.id ?? "",
        input: hostInput,
        hosts: response.consolidation.removedHosts.map((host) => host.displayHost)
      });
    } else {
      setError(response.error);
    }
    return false;
  };

  const createProfile = async () => {
    if (await run({ type: "CREATE_PROFILE", name: profileName })) setProfileName("");
  };

  const renameProfile = async () => {
    if (selected) await run({ type: "RENAME_PROFILE", profileId: selected.id, name: renameInput });
  };

  const deleteProfile = async () => {
    if (
      !selected ||
      !window.confirm(
        `Excluir o perfil “${selected.name}” com ${selected.domains.length} regra(s) de bloqueio?`
      )
    ) return;
    await run({ type: "DELETE_PROFILE", profileId: selected.id });
  };

  const selectProfile = async (profileId: string) => {
    setConsolidation(undefined);
    const response = await send({ type: "SELECT_PROFILE", profileId });
    if (response.ok) {
      setState(response.data);
      const profile = response.data.configuration.profiles.find((candidate) => candidate.id === profileId);
      setRenameInput(profile?.name ?? "");
      setError(undefined);
    } else {
      setError(response.error);
    }
  };

  const addHost = async (confirmConsolidation = false) => {
    if (!selected && !consolidation) return;
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
      const response = await sendExport({ type: "EXPORT_CONFIGURATION" });
      if (response.ok) {
        downloadJsonFile(response.data.fileName, response.data.content);
      } else {
        setError(serviceErrorMessage(response.error));
      }
    } catch {
      setError("Não foi possível exportar a configuração.");
    } finally {
      setExporting(false);
    }
  };

  const refreshAfterImportRejection = async (message: string) => {
    const response = await send({ type: "GET_STATE" });
    if (response.ok) {
      setState(response.data);
      const profile = response.data.configuration.profiles.find(
        (candidate) => candidate.id === response.data.configuration.lastSelectedProfileId
      );
      setRenameInput(profile?.name ?? "");
    }
    setError(message);
  };

  const replaceConfiguration = async () => {
    if (!selectedBackup || state?.activeSession) return;
    if (
      !window.confirm(
        "Substituirá todos os perfis e preferências locais pela configuração do backup. Deseja continuar?"
      )
    ) return;

    setImporting(true);
    setError(undefined);
    try {
      const currentResponse = await send({ type: "GET_STATE" });
      if (!currentResponse.ok) {
        setError(serviceErrorMessage(currentResponse.error));
        return;
      }
      setState(currentResponse.data);
      if (currentResponse.data.activeSession) {
        setError("Encerre a sessão atual antes de substituir a configuração.");
        return;
      }

      const preventiveNow = Date.now();
      const preventive = serializeConfigurationBackup(currentResponse.data.configuration, preventiveNow);
      downloadJsonFile(preImportBackupFileName(new Date(preventiveNow).toISOString()), preventive.content);

      const response = await send({
        type: "IMPORT_CONFIGURATION",
        content: selectedBackup.content,
        expectedCurrentConfiguration: currentResponse.data.configuration
      });
      if (response.ok) {
        setState(response.data);
        const profile = response.data.configuration.profiles.find(
          (candidate) => candidate.id === response.data.configuration.lastSelectedProfileId
        );
        setRenameInput(profile?.name ?? "");
        setSelectedBackup(undefined);
        setConsolidation(undefined);
        if (backupInputRef.current) backupInputRef.current.value = "";
        setError(undefined);
      } else if (response.error === "CONFIGURATION_CHANGED" || response.error === "IMPORT_SESSION_ACTIVE") {
        await refreshAfterImportRejection(serviceErrorMessage(response.error));
      } else {
        setError(serviceErrorMessage(response.error));
      }
    } catch {
      setError("Não foi possível concluir a restauração; a configuração não foi substituída.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <main className="options" aria-live="polite">
      <p className="eyebrow">FOCUS LOCK</p>
      <h1>Perfis de bloqueio</h1>
      <p className="intro">Escolha regras por contexto. As alterações ficam disponíveis no próximo foco.</p>

      <section className="card" aria-label="Perfis">
        <label htmlFor="profile">Perfil selecionado</label>
        <select
          id="profile"
          value={selected?.id ?? ""}
          onChange={(event) => void selectProfile(event.target.value)}
        >
          {state?.configuration.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name} ({profile.domains.length})</option>
          ))}
        </select>
        {selected && (
          <>
            <label htmlFor="rename">Nome</label>
            <div className="inline">
              <input id="rename" value={renameInput} disabled={locked} onChange={(event) => setRenameInput(event.target.value)} />
              <button type="button" disabled={locked} onClick={() => void renameProfile()}>Renomear</button>
            </div>
            <button className="danger" type="button" disabled={locked || (state?.configuration.profiles.length ?? 0) <= 1} onClick={() => void deleteProfile()}>
              Excluir perfil
            </button>
            {locked && <p className="note">Este perfil está protegido pela sessão em andamento.</p>}
          </>
        )}
        <label htmlFor="new-profile">Novo perfil</label>
        <div className="inline">
          <input id="new-profile" value={profileName} placeholder="Trabalho" onChange={(event) => setProfileName(event.target.value)} />
          <button type="button" onClick={() => void createProfile()}>Criar</button>
        </div>
      </section>

      <section className="card" aria-label="Regras de bloqueio">
        <h2>{selected?.name ?? "Regras"}</h2>
        <p className="note">Aceita hostname ou URL HTTP(S). Caminho, porta e query são ignorados.</p>
        <div className="inline">
          <input value={hostInput} disabled={locked} placeholder="youtube.com ou https://youtube.com" onChange={(event) => setHostInput(event.target.value)} />
          <button type="button" disabled={locked || !selected} onClick={() => void addHost()}>Adicionar</button>
        </div>
        {consolidation && (
          <div className="confirm" role="alert">
            <p>Esta regra absorve: {consolidation.hosts.join(", ")}.</p>
            <button type="button" onClick={() => void addHost(true)}>Confirmar consolidação</button>
            <button className="secondary" type="button" onClick={() => setConsolidation(undefined)}>Cancelar</button>
          </div>
        )}
        <ul className="rules">
          {selected?.domains.map((host) => (
            <li key={host.canonicalHost}>
              <span title={host.canonicalHost}>{host.displayHost}</span>
              <button type="button" disabled={locked} onClick={() => void run({ type: "REMOVE_BLOCKED_HOST", profileId: selected.id, canonicalHost: host.canonicalHost })}>Remover</button>
            </li>
          ))}
        </ul>
        {!selected?.domains.length && <p className="note">Nenhuma regra adicionada.</p>}
      </section>
      <section className="card backup-card" aria-label="Backup e restauração">
        <h2>Backup e restauração</h2>
        <p className="note">Exporte sua configuração ou substitua todos os perfis por um backup Focus Lock.</p>
        <button type="button" disabled={exporting} onClick={() => void exportConfiguration()}>
          {exporting ? "Exportando…" : "Exportar configuração"}
        </button>
        <label htmlFor="backup-file">Selecionar backup (.json)</label>
        <input
          ref={backupInputRef}
          id="backup-file"
          type="file"
          accept=".json,application/json"
          disabled={Boolean(state?.activeSession) || importing}
          onChange={(event) => void selectBackupFile(event)}
        />
        {state?.activeSession && <p className="note">A restauração fica indisponível durante uma sessão ativa.</p>}
        {selectedBackup && (
          <div className="backup-summary" aria-label="Resumo do backup">
            <p>Backup selecionado</p>
            <dl>
              <div><dt>Exportado em</dt><dd>{selectedBackup.summary.exportedAt}</dd></div>
              <div><dt>Perfis</dt><dd>{selectedBackup.summary.profileCount}</dd></div>
              <div><dt>Regras</dt><dd>{selectedBackup.summary.ruleCount}</dd></div>
              <div><dt>Perfil selecionado</dt><dd>{selectedBackup.summary.selectedProfileName}</dd></div>
              <div><dt>Duração padrão</dt><dd>{selectedBackup.summary.durationMinutes} minutos</dd></div>
            </dl>
            <button type="button" disabled={importing || Boolean(state?.activeSession)} onClick={() => void replaceConfiguration()}>
              {importing ? "Substituindo…" : "Substituir configuração"}
            </button>
          </div>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
