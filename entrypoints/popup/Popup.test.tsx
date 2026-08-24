// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRequest, ExtensionState, StateResponse } from "../../src/domain/types";
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

function renderPopup(state = createState()) {
  const requests: BackgroundRequest[] = [];
  const listeners = new Set<(changes: Record<string, unknown>) => void>();
  const adapter: PopupAdapter = {
    runtime: {
      sendMessage: vi.fn(async (request: BackgroundRequest): Promise<StateResponse> => {
        requests.push(request);
        if (request.type === "SELECT_PROFILE") {
          state.configuration.lastSelectedProfileId = request.profileId;
        }
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
    root.render(<Popup adapter={adapter} clock={() => NOW} />);
  });

  return { adapter, container, requests, root, listeners };
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
  });

  it("emits profile, current-site, and settings commands while keeping confirmation deliberate", async () => {
    const rendered = renderPopup();
    mounted = rendered;
    await settle();

    const profile = rendered.container.querySelector<HTMLSelectElement>("#profile");
    if (!profile) throw new Error("Profile select not found");
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
    expect(rendered.container.textContent).toContain("Confira antes de iniciar");
    expect(rendered.requests.some((request) => request.type === "START_SESSION")).toBe(false);
  });

  it("recalculates the dominant end time when duration changes", async () => {
    const rendered = renderPopup();
    mounted = rendered;
    await settle();

    const duration = rendered.container.querySelector<HTMLSelectElement>("#duration");
    if (!duration) throw new Error("Duration select not found");
    await act(async () => {
      duration.value = "65";
      duration.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(rendered.container.textContent).toContain("65 min");
    expect(rendered.container.textContent).toContain("Termina às 11:20");
  });
});
