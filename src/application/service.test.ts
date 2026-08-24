import { describe, expect, it, vi } from "vitest";
import { StateStore, type StorageArea } from "./storage";
import { BackgroundService } from "./service";

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea & { values: Record<string, unknown>; writes: Record<string, unknown>[] } {
  const values = { ...initial };
  const writes: Record<string, unknown>[] = [];
  return {
    values,
    writes,
    async get() {
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

describe("BackgroundService profiles and blocked hosts", () => {
  it("creates, selects, renames, and rejects duplicate profile names", async () => {
    const storage = memoryStorage();
    let now = 1000;
    const service = new BackgroundService(new StateStore(storage, () => now), {
      now: () => now,
      createId: () => "study"
    });

    expect((await service.handle({ type: "CREATE_PROFILE", name: "  Estudo  " })).ok).toBe(true);
    expect(await service.handle({ type: "CREATE_PROFILE", name: "ｅｓｔｕｄｏ" })).toEqual({ ok: false, error: "DUPLICATE_PROFILE_NAME" });
    expect(await service.handle({ type: "CREATE_PROFILE", name: "   " })).toEqual({ ok: false, error: "INVALID_PROFILE_NAME" });
    expect(await service.handle({ type: "CREATE_PROFILE", name: "x".repeat(41) })).toEqual({ ok: false, error: "INVALID_PROFILE_NAME" });
    expect(await service.handle({ type: "SELECT_PROFILE", profileId: "study" })).toMatchObject({ ok: true });
    expect(await service.handle({ type: "RENAME_PROFILE", profileId: "study", name: "Leitura" })).toMatchObject({ ok: true });

    now = 2000;
    expect(await service.handle({ type: "CREATE_PROFILE", name: "Outro" })).toMatchObject({ ok: true });
    expect(await service.handle({ type: "RENAME_PROFILE", profileId: "missing", name: "x" })).toEqual({ ok: false, error: "PROFILE_NOT_FOUND" });
  });

  it("prevents deleting the last profile and selects the most recently updated replacement", async () => {
    let now = 1000;
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => now), {
      now: () => now,
      createId: (() => {
        let index = 0;
        return () => ["one", "two"][index++] ?? "three";
      })()
    });
    expect(await service.handle({ type: "DELETE_PROFILE", profileId: "focus" })).toEqual({ ok: false, error: "LAST_PROFILE" });
    await service.handle({ type: "CREATE_PROFILE", name: "One" });
    now = 2000;
    await service.handle({ type: "CREATE_PROFILE", name: "Two" });
    await service.handle({ type: "RENAME_PROFILE", profileId: "one", name: "One updated" });
    await service.handle({ type: "SELECT_PROFILE", profileId: "two" });
    expect(await service.handle({ type: "DELETE_PROFILE", profileId: "two" })).toMatchObject({ ok: true });
    const state = await service.handle({ type: "GET_STATE" });
    expect(state.ok && state.data.configuration.lastSelectedProfileId).toBe("one");
  });

  it("adds canonical hosts, reports coverage, and consolidates in one write", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 1000), {
      now: () => 1000
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "m.youtube.com" });
    const beforeConfirmWrites = storage.writes.length;
    expect(await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "youtube.com" })).toMatchObject({
      ok: false,
      error: "CONFIRM_CONSOLIDATION",
      consolidation: { removedHosts: [{ canonicalHost: "m.youtube.com" }] }
    });
    expect(storage.writes.length).toBe(beforeConfirmWrites);
    expect(await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "youtube.com", confirmConsolidation: true })).toMatchObject({ ok: true });
    const state = await service.handle({ type: "GET_STATE" });
    expect(state.ok && state.data.configuration.profiles[0].domains.map((host) => host.canonicalHost)).toEqual(["youtube.com"]);
    expect(await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "m.youtube.com" })).toMatchObject({
      ok: false,
      error: "HOST_ALREADY_COVERED",
      existingHost: { canonicalHost: "youtube.com" }
    });
    expect(await service.handle({ type: "REMOVE_BLOCKED_HOST", profileId: "focus", canonicalHost: "youtube.com" })).toMatchObject({ ok: true });
    const stateAfterRemoval = await service.handle({ type: "GET_STATE" });
    expect(stateAfterRemoval.ok && stateAfterRemoval.data.configuration.profiles[0].domains).toEqual([]);
  });

  it("uses the selected profile for BLOCK_CURRENT_SITE and keeps the session snapshot independent", async () => {
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1",
      alarms
    });
    await service.handle({ type: "CREATE_PROFILE", name: "Trabalho" });
    await service.handle({ type: "SELECT_PROFILE", profileId: "session-1" });
    expect(await service.handle({ type: "BLOCK_CURRENT_SITE", url: "https://WWW.Example.com/path" })).toMatchObject({ ok: true });
    expect(await service.handle({ type: "START_SESSION" })).toMatchObject({ ok: true });
    expect(alarms.create).toHaveBeenCalledWith("pomodoro-expiration", { when: 3_010_000 });
    expect(await service.handle({ type: "RENAME_PROFILE", profileId: "session-1", name: "Locked" })).toEqual({ ok: false, error: "PROFILE_IN_SESSION" });
    expect(await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "session-1", input: "other.com" })).toEqual({ ok: false, error: "PROFILE_IN_SESSION" });
    expect(await service.handle({ type: "REMOVE_BLOCKED_HOST", profileId: "session-1", canonicalHost: "example.com" })).toEqual({ ok: false, error: "PROFILE_IN_SESSION" });
    expect(await service.handle({ type: "DELETE_PROFILE", profileId: "session-1" })).toEqual({ ok: false, error: "PROFILE_IN_SESSION" });
    expect(await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "other.com" })).toMatchObject({ ok: true });
    const state = await service.handle({ type: "GET_STATE" });
    expect(state.ok && state.data.activeSession?.profileSnapshot.domains).toEqual([
      { canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }
    ]);
  });

  it("rejects starting an empty profile and does not write a session", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    expect(await service.handle({ type: "START_SESSION" })).toEqual({ ok: false, error: "PROFILE_EMPTY" });
    expect(storage.values.activeSession).toBeUndefined();
  });

  it("serializes concurrent starts so only one session can be created", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage(), () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "youtube.com" });
    const results = await Promise.all([service.handle({ type: "START_SESSION" }), service.handle({ type: "START_SESSION" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "SESSION_ALREADY_ACTIVE" }]);
  });
});
