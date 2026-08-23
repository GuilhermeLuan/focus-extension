import { describe, expect, it, vi } from "vitest";
import { BackgroundService } from "./service";
import { StateStore, type StorageArea } from "./storage";
import type { ActiveSession, StoredConfiguration } from "../domain/types";

function storageWithSession(session: ActiveSession) {
  const values: Record<string, unknown> = {
    configuration: {
      schemaVersion: 1,
      profile: { id: "focus", name: "Foco", hostname: "youtube.com" }
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
  endsAt: 5_000,
  durationMinutes: 50,
  profileSnapshot: { id: "focus", name: "Foco", hostname: "youtube.com" }
};

describe("session expiration", () => {
  it("removes an expired session before GET_STATE responds", async () => {
    const storage = storageWithSession(expiredSession);
    const service = new BackgroundService(new StateStore(storage, () => 5_000), { now: () => 5_000 });

    const result = await service.handle({ type: "GET_STATE" });

    expect(result).toEqual({
      ok: true,
      data: {
        configuration: storage.values.configuration
      }
    });
    expect(storage.values.activeSession).toBeUndefined();
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
});
