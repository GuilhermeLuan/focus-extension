import { describe, expect, it, vi } from "vitest";
import { defaultConfiguration, type ActiveSession, type StoredConfiguration } from "../domain/types";
import { registerBackgroundLifecycle } from "./lifecycle";
import { BackgroundService, type AlarmScheduler, type ActionIndicator } from "./service";
import { StateStore, type StorageArea } from "./storage";

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea & {
  values: Record<string, unknown>;
  writes: Record<string, unknown>[];
  reads: number;
} {
  const values = { ...initial };
  const writes: Record<string, unknown>[] = [];
  return {
    values,
    writes,
    reads: 0,
    async get() {
      this.reads += 1;
      return { ...values };
    },
    async set(next) {
      writes.push(next);
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }
  };
}

function session(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    schemaVersion: 1,
    id: "recovered-session",
    startedAt: 10_000,
    cancelAllowedUntil: 70_000,
    endsAt: 310_000,
    durationMinutes: 5,
    profileSnapshot: {
      id: "focus",
      name: "Foco",
      domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }]
    },
    ...overrides
  };
}

function stateWithSession(activeSession: ActiveSession): Record<string, unknown> {
  const configuration = defaultConfiguration(1);
  configuration.profiles[0].domains = [
    { canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }
  ];
  return { configuration, activeSession } satisfies {
    configuration: StoredConfiguration;
    activeSession: ActiveSession;
  };
}

function resources() {
  return {
    alarms: {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true)
    } satisfies AlarmScheduler,
    indicator: {
      setActive: vi.fn(async () => undefined),
      setInactive: vi.fn(async () => undefined)
    } satisfies ActionIndicator
  };
}

describe("BackgroundService restart recovery", () => {
  it("reconciles a future session without rewriting its persisted fields", async () => {
    const persisted = session();
    const storage = memoryStorage(stateWithSession(persisted));
    const { alarms, indicator } = resources();
    const service = new BackgroundService(new StateStore(storage, () => 20_000), {
      now: () => 20_000,
      alarms,
      indicator
    });

    await service.reconcile();

    expect(storage.values.activeSession).toEqual(persisted);
    expect(storage.writes).toEqual([]);
    expect(alarms.create).toHaveBeenCalledWith("pomodoro-expiration", { when: persisted.endsAt });
    expect(indicator.setActive).toHaveBeenCalledOnce();
  });

  it("uses the original cancellation deadline after a restart", async () => {
    for (const [now, expected] of [
      [69_999, { ok: true }],
      [70_000, { ok: false, error: "CANCEL_WINDOW_CLOSED" }]
    ] as const) {
      const persisted = session();
      const storage = memoryStorage(stateWithSession(persisted));
      const service = new BackgroundService(new StateStore(storage, () => now), { now: () => now });

      const result = await service.handle({ type: "CANCEL_SESSION" });
      expect(result).toMatchObject(expected);
      if (expected.ok) {
        expect(storage.values.activeSession).toBeUndefined();
      } else {
        expect(storage.values.activeSession).toEqual(persisted);
      }
    }
  });

  it("expires and removes a session before a subsequent start command", async () => {
    const persisted = session({ id: "expired", endsAt: 20_000 });
    const storage = memoryStorage(stateWithSession(persisted));
    const notifier = { show: vi.fn(async () => undefined) };
    const service = new BackgroundService(new StateStore(storage, () => 20_000), {
      now: () => 20_000,
      createId: () => "new-session",
      notifier
    });

    const response = await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 });

    expect(response).toMatchObject({ ok: true, data: { activeSession: { id: "new-session" } } });
    expect(storage.values.activeSession).toMatchObject({ id: "new-session" });
    expect(notifier.show).toHaveBeenCalledWith("pomodoro-completed:expired", expect.any(Object));
  });

  it("clears derived resources for an idle state without creating a completion record", async () => {
    const storage = memoryStorage({ configuration: defaultConfiguration(1) });
    const { alarms, indicator } = resources();
    const service = new BackgroundService(new StateStore(storage, () => 2_000), {
      now: () => 2_000,
      alarms,
      indicator
    });

    await service.reconcile();

    expect(storage.values.pendingCompletionNotification).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("pomodoro-expiration");
    expect(indicator.setInactive).toHaveBeenCalledOnce();
  });

  it("retries a failed alarm on a later valid message while keeping the session", async () => {
    const persisted = session();
    const storage = memoryStorage(stateWithSession(persisted));
    const { alarms, indicator } = resources();
    alarms.create.mockRejectedValueOnce(new Error("alarm unavailable"));
    const service = new BackgroundService(new StateStore(storage, () => 20_000), {
      now: () => 20_000,
      alarms,
      indicator
    });

    await service.reconcile();
    expect(storage.values.activeSession).toEqual(persisted);
    expect(indicator.setActive).toHaveBeenCalledOnce();

    const response = await service.handle({ type: "SELECT_PROFILE", profileId: "focus" });

    expect(response).toMatchObject({ ok: true });
    expect(alarms.create).toHaveBeenCalledTimes(2);
    expect(alarms.create).toHaveBeenLastCalledWith("pomodoro-expiration", { when: persisted.endsAt });
    expect(storage.values.activeSession).toEqual(persisted);
  });

  it("captures the reconciliation clock once for a valid command", async () => {
    const storage = memoryStorage({ configuration: defaultConfiguration(1) });
    const now = vi.fn(() => 2_000);
    const service = new BackgroundService(new StateStore(storage, now), { now });

    await service.handle({ type: "SELECT_PROFILE", profileId: "focus" });

    expect(now).toHaveBeenCalledOnce();
  });

  it("serializes lifecycle, message, and alarm triggers against one persisted session", async () => {
    const persisted = session();
    const storage = memoryStorage(stateWithSession(persisted));
    const { alarms } = resources();
    const service = new BackgroundService(new StateStore(storage, () => 20_000), {
      now: () => 20_000,
      alarms
    });

    await Promise.all([
      service.reconcile(),
      service.handle({ type: "GET_STATE" }),
      service.handleAlarm("pomodoro-expiration")
    ]);

    expect(storage.values.activeSession).toEqual(persisted);
    expect(alarms.create).toHaveBeenCalledTimes(3);
  });

  it("ignores an unknown alarm and message without reading or touching resources", async () => {
    const storage = memoryStorage({ configuration: defaultConfiguration(1) });
    const { alarms, indicator } = resources();
    const service = new BackgroundService(new StateStore(storage, () => 2_000), {
      now: () => 2_000,
      alarms,
      indicator
    });

    await service.handleAlarm("unknown");
    const response = await service.handle({ type: "UNKNOWN" } as never);

    expect(response).toEqual({ ok: false, error: "STORAGE_ERROR" });
    expect(storage.reads).toBe(0);
    expect(alarms.create).not.toHaveBeenCalled();
    expect(alarms.clear).not.toHaveBeenCalled();
    expect(indicator.setActive).not.toHaveBeenCalled();
    expect(indicator.setInactive).not.toHaveBeenCalled();
  });
});

describe("background lifecycle wiring", () => {
  it("uses one public reconciliation callback for bootstrap and both lifecycle events", async () => {
    const onStartup: Array<() => void> = [];
    const onInstalled: Array<() => void> = [];
    const runtime = {
      onStartup: { addListener: (listener: () => void) => onStartup.push(listener) },
      onInstalled: { addListener: (listener: () => void) => onInstalled.push(listener) }
    };
    const reconcile = vi.fn(async () => undefined);

    registerBackgroundLifecycle(runtime, reconcile);
    onStartup[0]();
    onInstalled[0]();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledTimes(3);
  });
});
