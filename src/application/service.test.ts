import { describe, expect, it, vi } from "vitest";
import { StateStore, type StorageArea } from "./storage";
import { BackgroundService } from "./service";

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea {
  const values = { ...initial };
  return {
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
}

describe("BackgroundService hostname configuration", () => {
  it("normalizes and persists a valid hostname", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage()));

    const result = await service.handle({ type: "SET_HOSTNAME", hostname: " WWW.YouTube.com. " });
    const state = await service.handle({ type: "GET_STATE" });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(state).toEqual({
      ok: true,
      data: expect.objectContaining({
        configuration: expect.objectContaining({
          profile: expect.objectContaining({ hostname: "youtube.com" })
        })
      })
    });
  });

  it("rejects an IPv4 address as a hostname", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage()));

    const result = await service.handle({ type: "SET_HOSTNAME", hostname: "127.0.0.1" });

    expect(result).toEqual({ ok: false, error: "INVALID_HOSTNAME" });
  });

  it("starts a 50-minute session with a hostname snapshot", async () => {
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const service = new BackgroundService(new StateStore(memoryStorage()), {
      now: () => 10_000,
      createId: () => "session-1",
      alarms
    });
    await service.handle({ type: "SET_HOSTNAME", hostname: "youtube.com" });

    const result = await service.handle({ type: "START_SESSION" });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        activeSession: {
          schemaVersion: 1,
          id: "session-1",
          startedAt: 10_000,
          endsAt: 3_010_000,
          durationMinutes: 50,
          profileSnapshot: { id: "focus", name: "Foco", hostname: "youtube.com" }
        }
      })
    });
    expect(alarms.create).toHaveBeenCalledWith("pomodoro-expiration", { when: 3_010_000 });
  });

  it("rejects starting without a saved hostname", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage()), {
      now: () => 10_000,
      createId: () => "session-1"
    });

    const result = await service.handle({ type: "START_SESSION" });

    expect(result).toEqual({ ok: false, error: "HOSTNAME_REQUIRED" });
  });

  it("rejects a second start while the existing session is active", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "SET_HOSTNAME", hostname: "youtube.com" });
    await service.handle({ type: "START_SESSION" });

    const result = await service.handle({ type: "START_SESSION" });

    expect(result).toEqual({ ok: false, error: "SESSION_ALREADY_ACTIVE" });
  });

  it("allows only one of two concurrent start requests", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage()), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "SET_HOSTNAME", hostname: "youtube.com" });

    const results = await Promise.all([
      service.handle({ type: "START_SESSION" }),
      service.handle({ type: "START_SESSION" })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "SESSION_ALREADY_ACTIVE" }
    ]);
  });

  it("uses the injected clock when reconciling a session through GET_STATE", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage()), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "SET_HOSTNAME", hostname: "youtube.com" });
    await service.handle({ type: "START_SESSION" });

    const result = await service.handle({ type: "GET_STATE" });

    expect(result.ok && result.data.activeSession?.id).toBe("session-1");
  });
});
