import { describe, expect, it, vi } from "vitest";
import { BackgroundService } from "./service";
import { StateStore, type StorageArea } from "./storage";
import type { ActiveSession, StoredConfiguration } from "../domain/types";

function storageWithSession(session: ActiveSession) {
  const values: Record<string, unknown> = {
    configuration: {
      schemaVersion: 1,
      lastSelectedProfileId: "focus",
      lastDurationMinutes: 50,
      profiles: [{
        id: "focus",
        name: "Foco",
        domains: [{ canonicalHost: "youtube.com", displayHost: "youtube.com", kind: "domain" }],
        createdAt: 1,
        updatedAt: 1
      }]
    } satisfies StoredConfiguration,
    activeSession: session
  };
  const storage: StorageArea & { values: Record<string, unknown> } = {
    values,
    async get() {
      return { ...values };
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }
  };
  return storage;
}

const expiredSession: ActiveSession = {
  schemaVersion: 1,
  id: "session-1",
  startedAt: 1_000,
  cancelAllowedUntil: 61_000,
  endsAt: 5_000,
  durationMinutes: 50,
  profileSnapshot: {
    id: "focus",
    name: "Foco",
    domains: [{ canonicalHost: "youtube.com", displayHost: "youtube.com", kind: "domain" }]
  }
};

describe("session expiration", () => {
  it("removes an expired session before GET_STATE responds", async () => {
    const storage = storageWithSession(expiredSession);
    const indicator = { setActive: vi.fn(), setInactive: vi.fn() };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      indicator
    });

    const result = await service.handle({ type: "GET_STATE" });

    expect(result).toEqual({
      ok: true,
      data: {
        configuration: storage.values.configuration
      }
    });
    expect(storage.values.activeSession).toBeUndefined();
    expect(indicator.setInactive).toHaveBeenCalledOnce();
  });

  it("reconciles and clears the expiration alarm after it fires", async () => {
    const storage = storageWithSession(expiredSession);
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      alarms
    });

    await service.handleAlarm("pomodoro-expiration");

    expect(storage.values.activeSession).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("pomodoro-expiration");
  });

  it("notifies a natural completion only after the session is removed", async () => {
    const storage = storageWithSession(expiredSession);
    const notifier = {
      show: vi.fn(async () => {
        expect(storage.values.activeSession).toBeUndefined();
      })
    };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      notifier
    });

    await service.handle({ type: "GET_STATE" });

    expect(storage.values.activeSession).toBeUndefined();
    expect(notifier.show).toHaveBeenCalledWith("pomodoro-completed:session-1", {
      title: "Pomodoro concluído",
      message: "Seu período de foco terminou."
    });
    expect(storage.values.pendingCompletionNotification).toBeUndefined();
  });

  it("keeps a failed completion pending and retries with the same notification id", async () => {
    const storage = storageWithSession(expiredSession);
    const notifier = {
      show: vi.fn()
        .mockRejectedValueOnce(new Error("notifications unavailable"))
        .mockResolvedValue(undefined)
    };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      notifier
    });

    await service.handle({ type: "GET_STATE" });
    expect(storage.values.activeSession).toBeUndefined();
    expect(storage.values.pendingCompletionNotification).toEqual({
      schemaVersion: 1,
      sessionId: "session-1",
      completedAt: 5_000
    });

    await service.handle({ type: "GET_STATE" });
    expect(notifier.show).toHaveBeenNthCalledWith(2, "pomodoro-completed:session-1", {
      title: "Pomodoro concluído",
      message: "Seu período de foco terminou."
    });
    expect(notifier.show).toHaveBeenCalledTimes(2);
    expect(storage.values.pendingCompletionNotification).toBeUndefined();

    await service.handle({ type: "GET_STATE" });
    expect(notifier.show).toHaveBeenCalledTimes(2);
  });

  it("resumes a pending completion after a background restart without an active session", async () => {
    const storage = storageWithSession(expiredSession);
    const firstNotifier = { show: vi.fn().mockRejectedValue(new Error("offline")) };
    const firstService = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      notifier: firstNotifier
    });
    await firstService.handle({ type: "GET_STATE" });

    const notifier = { show: vi.fn(async () => undefined) };
    const serviceAfterRestart = new BackgroundService(new StateStore(storage, () => 6_000), {
      now: () => 6_000,
      notifier
    });
    await serviceAfterRestart.handle({ type: "GET_STATE" });

    expect(notifier.show).toHaveBeenCalledWith("pomodoro-completed:session-1", expect.any(Object));
    expect(storage.values.activeSession).toBeUndefined();
    expect(storage.values.pendingCompletionNotification).toBeUndefined();
  });

  it("does not notify an early or unknown alarm", async () => {
    const futureSession = { ...expiredSession, endsAt: 50_000 };
    const storage = storageWithSession(futureSession);
    const notifier = { show: vi.fn(async () => undefined) };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      notifier
    });

    await service.handleAlarm("unrelated-alarm");
    await service.handleAlarm("pomodoro-expiration");

    expect(storage.values.activeSession).toBeDefined();
    expect(notifier.show).not.toHaveBeenCalled();
  });

  it("does not create a completion notification for manual cancellation", async () => {
    const session = { ...expiredSession, endsAt: 50_000 };
    const storage = storageWithSession(session);
    const notifier = { show: vi.fn(async () => undefined) };
    const service = new BackgroundService(new StateStore(storage, () => 5_000), {
      now: () => 5_000,
      notifier
    });

    await service.handle({ type: "CANCEL_SESSION" });

    expect(storage.values.activeSession).toBeUndefined();
    expect(storage.values.pendingCompletionNotification).toBeUndefined();
    expect(notifier.show).not.toHaveBeenCalled();
  });
});
