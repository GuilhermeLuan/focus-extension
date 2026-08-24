// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSession, BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
import { BlockedPage, type BlockedPageAdapter } from "./main";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 7, 24, 10, 15, 31, 250).getTime();

function stateWithSession(id = "session-1"): ExtensionState {
  const activeSession: ActiveSession = {
    schemaVersion: 1,
    id,
    startedAt: NOW - 2 * 60_000,
    cancelAllowedUntil: NOW - 60_000,
    endsAt: NOW + 2 * 60_000 + 750,
    durationMinutes: 50,
    profileSnapshot: {
      id: "focus",
      name: "Foco profundo",
      domains: []
    }
  };
  return {
    configuration: {
      schemaVersion: 1,
      lastSelectedProfileId: "focus",
      lastDurationMinutes: 50,
      profiles: []
    },
    activeSession
  };
}

function releasedState(): ExtensionState {
  return {
    configuration: {
      schemaVersion: 1,
      lastSelectedProfileId: "focus",
      lastDurationMinutes: 50,
      profiles: []
    }
  };
}

function renderBlocked(
  response: StateResponse | (() => StateResponse),
  search = "?hostname=example.com&sessionId=session-1&destination=https%3A%2F%2Fexample.com%2Fnext",
  clock: () => number = () => NOW
) {
  window.history.replaceState({}, "", `/blocked.html${search}`);
  const listeners = new Set<(changes: Record<string, unknown>) => void>();
  const requests: BackgroundRequest[] = [];
  const navigation = { assign: vi.fn() };
  const adapter: BlockedPageAdapter = {
    runtime: {
      sendMessage: vi.fn(async (request) => {
        requests.push(request);
        return typeof response === "function" ? response() : response;
      })
    },
    storage: {
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener)
      }
    },
    navigation
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<BlockedPage adapter={adapter} clock={clock} />));
  return { adapter, container, navigation, requests, listeners, root };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("BlockedPage seam", () => {
  let mounted: { root: Root } | undefined;

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = undefined;
  });

  it("keeps the captured session blocked and presents its snapshot with stable timing", async () => {
    const rendered = renderBlocked({ ok: true, data: stateWithSession() });
    mounted = rendered;
    await settle();

    expect(rendered.requests).toEqual([{ type: "GET_STATE" }]);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("example.com");
    expect(rendered.container.textContent).toContain("Você escolheu manter este momento para o que importa.");
    expect(rendered.container.textContent).toContain("Foco profundo");
    expect(rendered.container.textContent).toContain("Termina às 10:17");
    expect(rendered.container.textContent).toContain("2m 01s");
    expect(rendered.container.querySelector(".remaining")?.closest("[aria-live]")).toBeNull();
    expect(rendered.container.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("releases for an absent or different captured session without leaking another snapshot", async () => {
    const state = stateWithSession("another-session");
    const rendered = renderBlocked({ ok: true, data: state });
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("O caminho está livre novamente.");
    expect(rendered.container.textContent).not.toContain("Foco profundo");
    expect(rendered.container.textContent).not.toContain("Termina às");
    expect(rendered.container.querySelector("button")?.textContent).toBe("Voltar para example.com");

    const absent = renderBlocked({ ok: true, data: releasedState() }, "?hostname=example.com&sessionId=session-1");
    act(() => mounted?.root.unmount());
    mounted = absent;
    await settle();
    expect(absent.container.textContent).toContain("O caminho está livre novamente.");
    expect(absent.container.querySelector("button")).toBeNull();
  });

  it("only navigates after explicit activation of a validated HTTP(S) destination", async () => {
    const rendered = renderBlocked({ ok: true, data: releasedState() });
    mounted = rendered;
    await settle();

    expect(rendered.navigation.assign).not.toHaveBeenCalled();
    rendered.container.querySelector<HTMLButtonElement>("button")?.click();
    expect(rendered.navigation.assign).toHaveBeenCalledWith("https://example.com/next");

    const invalid = renderBlocked(
      { ok: true, data: releasedState() },
      "?hostname=example.com&sessionId=session-1&destination=javascript%3Aalert(1)"
    );
    act(() => mounted?.root.unmount());
    mounted = invalid;
    await settle();
    expect(invalid.container.querySelector("button")).toBeNull();
    expect(invalid.container.textContent).toContain("Feche esta aba ou digite outro endereço.");
  });

  it("refreshes on storage changes and announces only the blocked-to-released transition", async () => {
    let response: StateResponse = { ok: true, data: stateWithSession() };
    const rendered = renderBlocked(() => response);
    mounted = rendered;
    await settle();
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("");

    response = { ok: true, data: releasedState() };
    await act(async () => {
      rendered.listeners.forEach((listener) => listener({ activeSession: { oldValue: {}, newValue: undefined } }));
      await Promise.resolve();
    });
    expect(rendered.requests).toHaveLength(2);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain("O caminho está livre novamente.");
    expect(rendered.container.querySelector('[role="status"]')?.textContent).not.toContain("2m");
  });

  it("stays conservatively blocked with a calm unavailable message when state loading fails", async () => {
    const rendered = renderBlocked({ ok: false, error: "STORAGE_ERROR" });
    mounted = rendered;
    await settle();

    expect(rendered.container.textContent).toContain("A navegação permanece bloqueada por enquanto.");
    expect(rendered.container.querySelector("button")).toBeNull();
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
