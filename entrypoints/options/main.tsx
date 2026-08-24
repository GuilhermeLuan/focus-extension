import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import "./style.css";

type ConsolidationPrompt = {
  profileId: string;
  input: string;
  hosts: string[];
};

const send = (request: BackgroundRequest): Promise<StateResponse> =>
  browser.runtime.sendMessage(request) as Promise<StateResponse>;

function Options() {
  const [state, setState] = useState<ExtensionState | undefined>();
  const [profileName, setProfileName] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [renameInput, setRenameInput] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [consolidation, setConsolidation] = useState<ConsolidationPrompt>();

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
      {error && <p className="error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
