// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSession, BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { Popup, type PopupAdapter } from "./Popup";

// React 19 uses this flag to enable its async act() implementation in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 7, 24, 10, 15, 0, 0).getTime();

function createState(): ExtensionState {
  return {
    configuration: {
      schemaVersion: 1,
      lastSelectedProfileId: "focus",
      lastDurationMinutes: 50,
      profiles: [
        {
          id: "focus",
          name: "Foco profundo",
          domains: [
            { canonicalHost: "example.com", displayHost: "example.com", kind: "domain" },
            { canonicalHost: "news.example.com", displayHost: "news.example.com", kind: "domain" }
          ],
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

type ResponseFor = (request: BackgroundRequest, state: ExtensionState) => Promise<StateResponse> | StateResponse | undefined;

function renderPopup(state = createState(), responseFor?: ResponseFor, clock: () => number = () => NOW) {
  const requests: BackgroundRequest[] = [];
  const listeners = new Set<(changes: Record<string, unknown>) => void>();
  const adapter: PopupAdapter = {
    runtime: {
      sendMessage: vi.fn(async (request: BackgroundRequest): Promise<StateResponse> => {
        requests.push(request);
        if (request.type === "SELECT_PROFILE") {
          state.configuration.lastSelectedProfileId = request.profileId;
        }
        const customResponse = responseFor?.(request, state);
        if (customResponse) return await customResponse;
        return { ok: true, data: state };
      }),
      openOptionsPage: vi.fn(async () => undefined)
    },
    tabs: {
      query: vi.fn(async () => [{ url: "https://current.example" }])
    },
    storage: {
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener)
      }
    },
    close: vi.fn(),
    confirm: vi.fn(() => true)
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Popup adapter={adapter} clock={clock} />);
  });

  return { adapter, container, requests, root, listeners };
}

function createActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    schemaVersion: 1,
    id: "session-1",
    startedAt: NOW,
    cancelAllowedUntil: NOW + 60_000,
    endsAt: NOW + 50 * 60_000,
    durationMinutes: 50,
    profileSnapshot: {
      id: "focus",
      name: "Foco profundo",
      domains: createState().configuration.profiles[0].domains
    },
    ...overrides
  };
}

function createActiveState(session = createActiveSession()): ExtensionState {
  return { ...createState(), activeSession: session };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(name));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
  return found;
}

function select(container: HTMLElement, name: string): HTMLSelectElement {
  const found = [...container.querySelectorAll("select")].find(
    (candidate) => candidate.getAttribute("aria-label") === name
  );
  if (!(found instanceof HTMLSelectElement)) throw new Error(`Select not found: ${name}`);
  return found;
}

function tabbableNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLSelectElement | HTMLButtonElement>("select, button")]
    .filter((control) => !control.disabled)
    .map((control) => control instanceof HTMLSelectElement
      ? control.getAttribute("aria-label") ?? ""
      : control.textContent?.trim() ?? "");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Popup idle seam", () => {
  let mounted: { root: Root } | undefined;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = undefined;
  });

  it("shows the idle summary with a local end time and pluralized site count", async () => {
    const rendered = renderPopup();
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("50 min");
    expect(rendered.container.textContent).toContain("Termina às 11:05");
    expect(rendered.container.textContent).toContain("Foco profundo");
    expect(rendered.container.textContent).toContain("2 sites");
    expect(button(rendered.container, "Bloquear este site")).toBeTruthy();
    expect(button(rendered.container, "Revisar e começar")).toBeTruthy();
    expect(button(rendered.container, "Cuidar dos perfis")).toBeTruthy();
    expect(tabbableNames(rendered.container)).toEqual([
      "Perfil",
      "Duração",
      "Bloquear este site",
      "Revisar e começar",
      "Cuidar dos perfis"
    ]);
  });

  it("emits profile, current-site, and settings commands while keeping confirmation deliberate", async () => {
    const rendered = renderPopup();
    mounted = rendered;
    await settle();

    const profile = select(rendered.container, "Perfil");
    await act(async () => {
      profile.value = "reading";
      profile.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "SELECT_PROFILE", profileId: "reading" });

    await act(async () => {
      button(rendered.container, "Bloquear este site").click();
      await Promise.resolve();
    });
    expect(rendered.adapter.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(rendered.requests).toContainEqual({ type: "BLOCK_CURRENT_SITE", url: "https://current.example" });

    await act(async () => {
      button(rendered.container, "Cuidar dos perfis").click();
      await Promise.resolve();
    });
    expect(rendered.adapter.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(rendered.adapter.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      button(rendered.container, "Revisar e começar").click();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Revisão da sessão");
    expect(rendered.requests.some((request) => request.type === "START_SESSION")).toBe(false);
  });

  it("recalculates the dominant end time when duration changes", async () => {
    const rendered = renderPopup();
    mounted = rendered;
    await settle();

    const duration = select(rendered.container, "Duração");
    await act(async () => {
      duration.value = "65";
      duration.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(rendered.container.textContent).toContain("65 min");
    expect(rendered.container.textContent).toContain("Termina às 11:20");
  });
});

describe("Popup confirmation and active-session seam", () => {
  let mounted: { root: Root } | undefined;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = undefined;
    vi.useRealTimers();
  });

  it("orders the confirmation summary and snapshots its end time when opened", async () => {
    let now = NOW;
    const rendered = renderPopup(createState(), undefined, () => now);
    mounted = rendered;
    await settle();

    await act(async () => {
      now = NOW + 37_000;
      button(rendered.container, "Revisar e começar").click();
      await Promise.resolve();
    });

    const confirmation = rendered.container.querySelector(".confirmation");
    expect(confirmation).toBeTruthy();
    expect(confirmation?.textContent).toContain("Revisão da sessão");
    expect(confirmation?.textContent).toContain("Foco profundo");
    expect(confirmation?.textContent).toContain("2 sites");
    expect(confirmation?.textContent).toContain("50 minutos");
    expect(confirmation?.textContent).toContain("Termina às 11:05");
    expect(confirmation?.textContent).toContain("60 segundos");
    expect(tabbableNames(rendered.container)).toEqual([
      "Mantenha pressionado por 2 segundos",
      "Voltar"
    ]);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("Revisão da sessão");
  });

  it("requires a continuous two-second primary-pointer hold and sends one start command", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const pending = new Promise<StateResponse>(() => undefined);
    const rendered = renderPopup(createState(), (request) => {
      if (request.type === "START_SESSION") return pending;
      return undefined;
    }, () => now);
    mounted = rendered;
    await settle();

    await act(async () => {
      button(rendered.container, "Revisar e começar").click();
      await Promise.resolve();
    });
    const hold = button(rendered.container, "Mantenha pressionado por 2 segundos");
    hold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    now = NOW + 1_999;
    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });
    expect(rendered.requests.filter((request) => request.type === "START_SESSION")).toHaveLength(0);
    expect(hold.disabled).toBe(false);

    now = NOW + 2_000;
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(rendered.requests.filter((request) => request.type === "START_SESSION")).toEqual([{
      type: "START_SESSION",
      profileId: "focus",
      durationMinutes: 50
    }]);
    expect(button(rendered.container, "Iniciando…").disabled).toBe(true);

    hold.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    hold.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(rendered.requests.filter((request) => request.type === "START_SESSION")).toHaveLength(1);
  });

  it("keeps a cancellable active session compact and formats the cancellation countdown", async () => {
    vi.useFakeTimers();
    let now = NOW + 59_999;
    const session = createActiveSession({
      cancelAllowedUntil: NOW + 60_000,
      endsAt: NOW + 50 * 60_000
    });
    const rendered = renderPopup(createActiveState(session), undefined, () => now);
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("Sessão ativa");
    expect(rendered.container.textContent).toContain("49m 01s");
    expect(rendered.container.textContent).toContain("Termina às 11:05");
    expect(rendered.container.textContent).toContain("Foco profundo");
    expect(rendered.container.textContent).toContain("2 sites");
    expect(rendered.container.textContent).toContain("Você ainda pode cancelar");
    expect(rendered.container.textContent).toContain("Cancelar sessão · 1s");
    expect(rendered.container.textContent).not.toContain("example.com");
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe(
      "Sessão iniciada. Você ainda pode cancelar"
    );
  });

  it("cancels before the strict deadline and announces the semantic transition", async () => {
    let now = NOW + 59_000;
    const idle = createState();
    const state = createActiveState(createActiveSession({ cancelAllowedUntil: NOW + 60_000 }));
    const rendered = renderPopup(state, (request) => {
      if (request.type === "CANCEL_SESSION") return { ok: true, data: idle };
      return undefined;
    }, () => now);
    mounted = rendered;
    await settle();

    await act(async () => {
      button(rendered.container, "Cancelar sessão · 1s").click();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "CANCEL_SESSION" });
    expect(rendered.container.textContent).toContain("Pronto para focar");
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("Sessão cancelada");
  });

  it("removes cancellation at the exact boundary and announces protection", async () => {
    vi.useFakeTimers();
    let now = NOW + 59_000;
    const session = createActiveSession({ cancelAllowedUntil: NOW + 60_000 });
    const rendered = renderPopup(createActiveState(session), undefined, () => now);
    mounted = rendered;
    await settle();

    now = NOW + 60_000;
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Sessão protegida");
    expect(rendered.container.textContent).toContain("não pode mais ser cancelado");
    expect(rendered.container.textContent).not.toContain("Cancelar sessão");
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("Sessão protegida");
    expect(tabbableNames(rendered.container)).toEqual([]);
  });

  it("turns a concurrent CANCEL_WINDOW_CLOSED response into protected state without a stale action", async () => {
    const state = createActiveState(createActiveSession());
    const rendered = renderPopup(state, (request) => {
      if (request.type === "CANCEL_SESSION") return { ok: false, error: "CANCEL_WINDOW_CLOSED" };
      return undefined;
    });
    mounted = rendered;
    await settle();

    await act(async () => {
      button(rendered.container, "Cancelar sessão · 60s").click();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Sessão protegida");
    expect(rendered.container.textContent).toContain("A janela de cancelamento terminou.");
    expect(rendered.container.textContent).not.toContain("Cancelar sessão");
    expect(button(rendered.container, "Atualizar estado")).toBeTruthy();
  });
});

describe("Popup recovery seam", () => {
  let mounted: { root: Root } | undefined;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = undefined;
    vi.useRealTimers();
  });

  it("offers a standalone retry panel when the initial state load fails", async () => {
    let first = true;
    const state = createState();
    const rendered = renderPopup(state, (request) => {
      if (request.type === "GET_STATE" && first) {
        first = false;
        return { ok: false, error: "STORAGE_ERROR" };
      }
      return undefined;
    });
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("Não foi possível carregar o Focus Lock.");
    expect(tabbableNames(rendered.container)).toEqual(["Tentar novamente"]);
    await act(async () => {
      button(rendered.container, "Tentar novamente").click();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Pronto para focar");
  });

  it("maps profile/configuration start errors to profile care without changing the error code", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const rendered = renderPopup(createState(), (request) => {
      if (request.type === "START_SESSION") return { ok: false, error: "PROFILE_EMPTY" };
      return undefined;
    }, () => now);
    mounted = rendered;
    await settle();
    await act(async () => {
      button(rendered.container, "Revisar e começar").click();
      await Promise.resolve();
    });
    const hold = button(rendered.container, "Mantenha pressionado por 2 segundos");
    hold.focus();
    hold.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    now = NOW + 2_000;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.requests).toContainEqual({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 });
    expect(rendered.container.textContent).toContain("Adicione pelo menos uma regra antes de iniciar.");
    expect(button(rendered.container, "Cuidar dos perfis")).toBeTruthy();
    await act(async () => {
      button(rendered.container, "Cuidar dos perfis").click();
      await Promise.resolve();
    });
    expect(rendered.adapter.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it("requires a fresh hold after a retryable start error", async () => {
    vi.useFakeTimers();
    let now = NOW;
    let startAttempts = 0;
    const rendered = renderPopup(createState(), (request) => {
      if (request.type !== "START_SESSION") return undefined;
      startAttempts += 1;
      return { ok: false, error: "STORAGE_ERROR" };
    }, () => now);
    mounted = rendered;
    await settle();
    await act(async () => {
      button(rendered.container, "Revisar e começar").click();
      await Promise.resolve();
    });

    const hold = button(rendered.container, "Mantenha pressionado por 2 segundos");
    hold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    now += 2_000;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startAttempts).toBe(1);

    await act(async () => {
      button(rendered.container, "Tentar novamente").click();
      await Promise.resolve();
    });
    expect(startAttempts).toBe(1);
    expect(button(rendered.container, "Mantenha pressionado por 2 segundos")).toBeTruthy();
  });

  it("offers a state refresh for a closed cancellation window", async () => {
    const state = createActiveState(createActiveSession());
    const rendered = renderPopup(state, (request) => {
      if (request.type === "CANCEL_SESSION") return { ok: false, error: "CANCEL_WINDOW_CLOSED" };
      return undefined;
    });
    mounted = rendered;
    await settle();
    await act(async () => {
      button(rendered.container, "Cancelar sessão · 60s").click();
      await Promise.resolve();
    });
    expect(tabbableNames(rendered.container)).toEqual(["Atualizar estado"]);
    await act(async () => {
      button(rendered.container, "Atualizar estado").click();
      await Promise.resolve();
    });
    expect(rendered.requests.filter((request) => request.type === "GET_STATE")).toHaveLength(2);
  });
});
