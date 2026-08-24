// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { Options, type OptionsAdapter } from "./main";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 7, 24, 10, 15).getTime();

function stateWithProfiles(): ExtensionState {
  return {
    configuration: {
      schemaVersion: 1,
      lastSelectedProfileId: "focus",
      lastDurationMinutes: 50,
      profiles: [
        {
          id: "focus",
          name: "Foco profundo",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }],
          createdAt: NOW,
          updatedAt: NOW
        },
        {
          id: "reading",
          name: "Leitura",
          domains: [],
          createdAt: NOW,
          updatedAt: NOW
        }
      ]
    }
  };
}

function input(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === labelText);
  const element = label?.htmlFor ? container.querySelector<HTMLInputElement>(`#${label.htmlFor}`) : null;
  if (!element) throw new Error(`Input not found: ${label}`);
  return element;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.textContent?.trim().startsWith(name)
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

function profileButton(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.querySelector("span")?.textContent === name
  );
  if (!found) throw new Error(`Profile button not found: ${name}`);
  return found;
}

function setInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderOptions(initial = stateWithProfiles(), responseFor?: (request: BackgroundRequest, state: ExtensionState) => StateResponse | undefined) {
  let state = structuredClone(initial);
  const requests: BackgroundRequest[] = [];
  const listeners = new Set<(changes: Record<string, unknown>) => void>();
  const adapter: OptionsAdapter = {
    runtime: {
      sendMessage: vi.fn(async (request: BackgroundRequest) => {
        requests.push(request);
        const custom = responseFor?.(request, state);
        if (custom) return custom;
        if (request.type === "EXPORT_CONFIGURATION") {
          return { ok: true as const, data: { fileName: "focus-lock-backup.json", content: "{}" } };
        }
        if (request.type === "SELECT_PROFILE") state.configuration.lastSelectedProfileId = request.profileId;
        if (request.type === "CREATE_PROFILE") {
          state.configuration.profiles.push({
            id: "new-profile",
            name: request.name.trim(),
            domains: [],
            createdAt: NOW,
            updatedAt: NOW
          });
        }
        if (request.type === "RENAME_PROFILE") {
          state.configuration.profiles.find((profile) => profile.id === request.profileId)!.name = request.name;
        }
        if (request.type === "ADD_BLOCKED_HOST") {
          state.configuration.profiles.find((profile) => profile.id === request.profileId)!.domains.push({
            canonicalHost: request.input,
            displayHost: request.input,
            kind: "domain"
          });
        }
        if (request.type === "REMOVE_BLOCKED_HOST") {
          const profile = state.configuration.profiles.find((candidate) => candidate.id === request.profileId)!;
          profile.domains = profile.domains.filter((host) => host.canonicalHost !== request.canonicalHost);
        }
        if (request.type === "DELETE_PROFILE") {
          state.configuration.profiles = state.configuration.profiles.filter((profile) => profile.id !== request.profileId);
          state.configuration.lastSelectedProfileId = state.configuration.profiles[0].id;
        }
        return { ok: true as const, data: structuredClone(state) };
      })
    },
    storage: {
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener)
      }
    },
    download: vi.fn(),
    confirm: vi.fn(() => true)
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Options adapter={adapter} />));
  return { adapter, container, requests, root };
}

afterEach(() => document.body.replaceChildren());

describe("Options seam", () => {
  let mounted: { root: Root } | undefined;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = undefined;
  });

  it("renders the moss garden editor with profile navigation and backup region", async () => {
    const rendered = renderOptions();
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("Perfis de bloqueio");
    expect(rendered.container.textContent?.match(/1 site/g)).toHaveLength(2);
    expect(rendered.container.textContent).toContain("Backup e restauração");
    expect(rendered.container.querySelector('button[aria-current="true"]')?.textContent).toContain("Foco profundo");
    expect(input(rendered.container, "Hostname ou URL").getAttribute("aria-describedby")).toBe("host-help");
  });

  it("uses the profile list and forms while preserving background commands", async () => {
    const rendered = renderOptions();
    mounted = rendered;
    await settle();

    await act(async () => {
      profileButton(rendered.container, "Leitura").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "SELECT_PROFILE", profileId: "reading" });

    await act(async () => {
      setInput(input(rendered.container, "Nome do novo perfil"), "Escrita");
      button(rendered.container, "Criar perfil").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "CREATE_PROFILE", name: "Escrita" });

    await act(async () => {
      setInput(input(rendered.container, "Nome do perfil"), "Leitura leve");
      button(rendered.container, "Salvar nome").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "RENAME_PROFILE", profileId: "reading", name: "Leitura leve" });

    await act(async () => {
      setInput(input(rendered.container, "Hostname ou URL"), "news.example");
      button(rendered.container, "Adicionar site").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "ADD_BLOCKED_HOST", profileId: "reading", input: "news.example" });

    await act(async () => {
      button(rendered.container, "Remover news.example").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "REMOVE_BLOCKED_HOST", profileId: "reading", canonicalHost: "news.example" });
  });

  it("keeps the last profile delete action visible but disabled", async () => {
    const only = stateWithProfiles();
    only.configuration.profiles = [only.configuration.profiles[0]];
    const rendered = renderOptions(only);
    mounted = rendered;
    await settle();

    const deleteButton = button(rendered.container, "Excluir perfil");
    expect(deleteButton?.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("Mantenha pelo menos um perfil.");
  });

  it.each([
    ["HOSTNAME_REQUIRED", "Informe um hostname ou URL HTTP(S)."],
    ["INVALID_HOSTNAME", "Informe um hostname ou URL HTTP(S) válido."],
    ["PROTECTED_HOSTNAME", "Esse host é protegido pelo Firefox."],
    ["HOST_ALREADY_COVERED", "Essa regra já está coberta por outra."]
  ] as const)("maps %s to PT-BR without exposing the raw code", async (errorCode, expectedMessage) => {
    const rendered = renderOptions(stateWithProfiles(), (request) => {
      if (request.type === "ADD_BLOCKED_HOST") return { ok: false, error: errorCode };
      return undefined;
    });
    mounted = rendered;
    await settle();

    await act(async () => {
      setInput(input(rendered.container, "Hostname ou URL"), "not valid");
      button(rendered.container, "Adicionar site").click();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain(expectedMessage);
    expect(rendered.container.textContent).not.toContain(errorCode);
  });

  it("disables only the profile captured by the active session", async () => {
    const active = stateWithProfiles();
    active.activeSession = {
      schemaVersion: 1,
      id: "session-1",
      startedAt: NOW,
      cancelAllowedUntil: NOW + 60_000,
      endsAt: NOW + 3_000_000,
      durationMinutes: 50,
      profileSnapshot: { id: "focus", name: "Foco profundo", domains: active.configuration.profiles[0].domains }
    };
    const rendered = renderOptions(active);
    mounted = rendered;
    await settle();

    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain("somente para leitura");
    expect(input(rendered.container, "Nome do perfil").disabled).toBe(true);
    expect(input(rendered.container, "Hostname ou URL").disabled).toBe(true);
    expect(button(rendered.container, "Salvar nome").disabled).toBe(true);
    expect(button(rendered.container, "Adicionar site").disabled).toBe(true);
    expect(button(rendered.container, "Remover example.com").disabled).toBe(true);
    expect(button(rendered.container, "Excluir perfil").disabled).toBe(true);
    expect(input(rendered.container, "Nome do novo perfil").disabled).toBe(false);
    expect(button(rendered.container, "Criar perfil").disabled).toBe(false);
    expect(rendered.container.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.disabled).toBe(false);

    await act(async () => {
      profileButton(rendered.container, "Leitura").click();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector('[role="status"]')?.textContent ?? "").not.toContain("somente para leitura");
    expect(input(rendered.container, "Nome do perfil").disabled).toBe(false);
    expect(input(rendered.container, "Hostname ou URL").disabled).toBe(false);
  });

  it("requires consolidation confirmation and can cancel without a second command", async () => {
    const rendered = renderOptions(stateWithProfiles(), (request, current) => {
      if (request.type === "ADD_BLOCKED_HOST" && !request.confirmConsolidation) {
        return {
          ok: false,
          error: "CONFIRM_CONSOLIDATION",
          consolidation: {
            candidate: { canonicalHost: "example.com", displayHost: "example.com", kind: "domain" },
            removedHosts: current.configuration.profiles[0].domains
          }
        };
      }
      return undefined;
    });
    mounted = rendered;
    await settle();
    await act(async () => {
      setInput(input(rendered.container, "Hostname ou URL"), "www.example.com");
      button(rendered.container, "Adicionar site").click();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector('[role="alertdialog"]')?.textContent).toContain("example.com");
    expect(rendered.container.querySelector('[role="alertdialog"]')?.textContent).toContain("Consolidar e adicionar");

    await act(async () => {
      button(rendered.container, "Cancelar").click();
      await Promise.resolve();
    });
    expect(rendered.requests.filter((request) => request.type === "ADD_BLOCKED_HOST")).toHaveLength(1);
    expect(rendered.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(input(rendered.container, "Hostname ou URL"));

    await act(async () => {
      button(rendered.container, "Adicionar site").click();
      await Promise.resolve();
    });
    await act(async () => {
      button(rendered.container, "Consolidar e adicionar").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({
      type: "ADD_BLOCKED_HOST",
      profileId: "focus",
      input: "www.example.com",
      confirmConsolidation: true
    });
  });

  it("confirms profile deletion with the localized count", async () => {
    const rendered = renderOptions();
    mounted = rendered;
    await settle();

    rendered.adapter.confirm = vi.fn(() => false);
    await act(async () => {
      button(rendered.container, "Excluir perfil").click();
      await Promise.resolve();
    });
    expect(rendered.requests).not.toContainEqual({ type: "DELETE_PROFILE", profileId: "focus" });

    await act(async () => {
      rendered.adapter.confirm = vi.fn(() => true);
      button(rendered.container, "Excluir perfil").click();
      await Promise.resolve();
    });
    expect(rendered.adapter.confirm).toHaveBeenCalledWith("Excluir o perfil “Foco profundo” com 1 site? Esta ação não pode ser desfeita.");
    expect(rendered.requests).toContainEqual({ type: "DELETE_PROFILE", profileId: "focus" });
  });

  it("keeps backup export available through the injected boundary", async () => {
    const rendered = renderOptions();
    mounted = rendered;
    await settle();
    await act(async () => {
      button(rendered.container, "Exportar configuração").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "EXPORT_CONFIGURATION" });
    expect(rendered.adapter.download).toHaveBeenCalledWith("focus-lock-backup.json", "{}");
    expect(rendered.container.textContent).toContain("Exportar configuração");
  });
});
