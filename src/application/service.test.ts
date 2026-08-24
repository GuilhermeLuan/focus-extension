import { describe, expect, it, vi } from "vitest";
import { defaultConfiguration, type StoredConfiguration } from "../domain/types";
import { serializeConfigurationBackup } from "./backup";
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
  it("exports the reconciled configuration even while a session is active", async () => {
    const configuration = defaultConfiguration(1000);
    const storage = memoryStorage({
      configuration,
      activeSession: {
        schemaVersion: 1,
        id: "session",
        startedAt: 1000,
        cancelAllowedUntil: 61_000,
        endsAt: 301_000,
        durationMinutes: 5,
        profileSnapshot: { id: "focus", name: "Foco", domains: [] }
      }
    });
    const service = new BackgroundService(new StateStore(storage, () => 2000), { now: () => 2000 });

    const response = await service.handle({ type: "EXPORT_CONFIGURATION" });

    expect(response).toEqual({
      ok: true,
      data: serializeConfigurationBackup(configuration, 2000)
    });
    expect(response.ok && response.data.content).not.toContain("activeSession");
    expect(storage.writes).toHaveLength(0);
  });

  it("imports valid configuration with one write and returns no session", async () => {
    const current = defaultConfiguration(1000);
    const imported: StoredConfiguration = {
      ...current,
      lastDurationMinutes: 25,
      profiles: [{ ...current.profiles[0], name: "Importado", updatedAt: 2000 }]
    };
    const storage = memoryStorage({ configuration: current });
    const service = new BackgroundService(new StateStore(storage, () => 2000), { now: () => 2000 });
    const content = serializeConfigurationBackup(imported, 2000).content;

    const response = await service.handle({
      type: "IMPORT_CONFIGURATION",
      content,
      expectedCurrentConfiguration: current
    });

    expect(response).toEqual({ ok: true, data: { configuration: imported } });
    expect(storage.values.configuration).toEqual(imported);
    expect(storage.writes).toHaveLength(1);
  });

  it("rejects imports during a session, invalid content, or a concurrent configuration change without writing", async () => {
    const current = defaultConfiguration(1000);
    const imported = { ...current, lastDurationMinutes: 25 };
    const content = serializeConfigurationBackup(imported, 2000).content;
    const activeStorage = memoryStorage({
      configuration: current,
      activeSession: {
        schemaVersion: 1,
        id: "session",
        startedAt: 1000,
        cancelAllowedUntil: 61_000,
        endsAt: 301_000,
        durationMinutes: 5,
        profileSnapshot: { id: "focus", name: "Foco", domains: [] }
      }
    });
    const activeService = new BackgroundService(new StateStore(activeStorage, () => 2000), { now: () => 2000 });
    expect(await activeService.handle({ type: "IMPORT_CONFIGURATION", content, expectedCurrentConfiguration: current })).toEqual({
      ok: false,
      error: "IMPORT_SESSION_ACTIVE"
    });
    expect(activeStorage.writes).toHaveLength(0);

    const invalidStorage = memoryStorage({ configuration: current });
    const invalidService = new BackgroundService(new StateStore(invalidStorage, () => 2000), { now: () => 2000 });
    expect(await invalidService.handle({ type: "IMPORT_CONFIGURATION", content: "{}", expectedCurrentConfiguration: current })).toEqual({
      ok: false,
      error: "INVALID_BACKUP"
    });
    expect(invalidStorage.writes).toHaveLength(0);

    const changedStorage = memoryStorage({ configuration: { ...current, lastDurationMinutes: 30 } });
    const changedService = new BackgroundService(new StateStore(changedStorage, () => 2000), { now: () => 2000 });
    expect(await changedService.handle({ type: "IMPORT_CONFIGURATION", content, expectedCurrentConfiguration: current })).toEqual({
      ok: false,
      error: "CONFIGURATION_CHANGED"
    });
    expect(changedStorage.writes).toHaveLength(0);
  });

  it("preserves the current configuration when the single import write fails", async () => {
    const current = defaultConfiguration(1000);
    const imported = { ...current, lastDurationMinutes: 25 };
    const values: Record<string, unknown> = { configuration: current };
    const storage: StorageArea = {
      async get() {
        return { ...values };
      },
      async set() {
        throw new Error("storage unavailable");
      },
      async remove() {}
    };
    const service = new BackgroundService(new StateStore(storage, () => 2000), { now: () => 2000 });

    const response = await service.handle({
      type: "IMPORT_CONFIGURATION",
      content: serializeConfigurationBackup(imported, 2000).content,
      expectedCurrentConfiguration: current
    });

    expect(response).toEqual({ ok: false, error: "STORAGE_ERROR" });
    expect(values.configuration).toEqual(current);
  });

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
    expect(await service.handle({ type: "START_SESSION", profileId: "session-1", durationMinutes: 50 })).toMatchObject({ ok: true });
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
    expect(await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })).toEqual({ ok: false, error: "PROFILE_EMPTY" });
    expect(storage.values.activeSession).toBeUndefined();
  });

  it("serializes concurrent starts so only one session can be created", async () => {
    const service = new BackgroundService(new StateStore(memoryStorage(), () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "youtube.com" });
    const results = await Promise.all([
      service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 }),
      service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "SESSION_ALREADY_ACTIVE" }]);
  });

  it("accepts explicit durations from 5 through 180 minutes and rejects invalid steps without writing", async () => {
    for (const durationMinutes of [5, 50, 180]) {
      const storage = memoryStorage();
      const service = new BackgroundService(new StateStore(storage, () => 10_000), {
        now: () => 10_000,
        createId: () => `session-${durationMinutes}`
      });
      await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });

      const response = await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes });

      expect(response).toMatchObject({ ok: true, data: { activeSession: { durationMinutes } } });
    }

    for (const durationMinutes of [0, 4, 181, 50.5, 55.1]) {
      const storage = memoryStorage();
      const service = new BackgroundService(new StateStore(storage, () => 10_000), {
        now: () => 10_000
      });
      await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
      const writesBefore = storage.writes.length;

      const response = await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes });

      expect(response).toEqual({ ok: false, error: "INVALID_DURATION" });
      expect(storage.values.activeSession).toBeUndefined();
      expect(storage.writes).toHaveLength(writesBefore);
    }
  });

  it("requires an existing non-empty profile id and accepts a populated profile", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1"
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });

    expect(await service.handle({ type: "START_SESSION", profileId: "", durationMinutes: 50 })).toEqual({
      ok: false,
      error: "PROFILE_REQUIRED"
    });
    expect(await service.handle({ type: "START_SESSION", profileId: "missing", durationMinutes: 50 })).toEqual({
      ok: false,
      error: "PROFILE_NOT_FOUND"
    });
    expect(await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })).toMatchObject({
      ok: true,
      data: { activeSession: { profileSnapshot: { id: "focus" } } }
    });
  });

  it("does not infer missing start fields from saved preferences", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });

    expect(await service.handle({
      type: "START_SESSION",
      profileId: undefined as unknown as string,
      durationMinutes: 50
    })).toEqual({ ok: false, error: "PROFILE_REQUIRED" });
    expect(await service.handle({
      type: "START_SESSION",
      profileId: "focus",
      durationMinutes: undefined as unknown as number
    })).toEqual({ ok: false, error: "INVALID_DURATION" });
    expect(storage.values.activeSession).toBeUndefined();
  });

  it("rejects a profile without hostnames before writing a session", async () => {
    const storage = memoryStorage();
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000
    });
    await service.handle({ type: "GET_STATE" });
    const writesBefore = storage.writes.length;

    expect(await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })).toEqual({
      ok: false,
      error: "PROFILE_EMPTY"
    });
    expect(storage.values.activeSession).toBeUndefined();
    expect(storage.writes).toHaveLength(writesBefore);
  });

  it("checks private-window permission before writing and maps unexpected failures", async () => {
    const deniedStorage = memoryStorage();
    const deniedService = new BackgroundService(new StateStore(deniedStorage, () => 10_000), {
      now: () => 10_000,
      isAllowedIncognitoAccess: async () => false
    });
    await deniedService.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
    const deniedWritesBefore = deniedStorage.writes.length;
    expect(await deniedService.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })).toEqual({
      ok: false,
      error: "PRIVATE_PERMISSION_REQUIRED"
    });
    expect(deniedStorage.values.activeSession).toBeUndefined();
    expect(deniedStorage.writes).toHaveLength(deniedWritesBefore);

    const rejectedStorage = memoryStorage();
    const rejectedService = new BackgroundService(new StateStore(rejectedStorage, () => 10_000), {
      now: () => 10_000,
      isAllowedIncognitoAccess: async () => {
        throw new Error("permission lookup failed");
      }
    });
    await rejectedService.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
    expect(await rejectedService.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 50 })).toEqual({
      ok: false,
      error: "STORAGE_ERROR"
    });
    expect(rejectedStorage.values.activeSession).toBeUndefined();
  });

  it("persists fixed-time session metadata, an independent snapshot, and both start preferences", async () => {
    const storage = memoryStorage();
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const service = new BackgroundService(new StateStore(storage, () => 123_000), {
      now: () => 123_000,
      createId: () => "fixed-session",
      alarms,
      isAllowedIncognitoAccess: async () => true
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });

    const response = await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 25 });

    expect(response).toMatchObject({
      ok: true,
      data: {
        configuration: { lastSelectedProfileId: "focus", lastDurationMinutes: 25 },
        activeSession: {
          schemaVersion: 1,
          id: "fixed-session",
          startedAt: 123_000,
          cancelAllowedUntil: 183_000,
          endsAt: 1_623_000,
          durationMinutes: 25,
          profileSnapshot: {
            id: "focus",
            name: "Foco",
            domains: [{ canonicalHost: "example.com" }]
          }
        }
      }
    });
    expect(storage.values.configuration).toMatchObject({ lastSelectedProfileId: "focus", lastDurationMinutes: 25 });
    expect(storage.values.activeSession).toMatchObject({ endsAt: 1_623_000, durationMinutes: 25 });
    expect(alarms.create).toHaveBeenCalledWith("pomodoro-expiration", { when: 1_623_000 });

    const storedConfiguration = storage.values.configuration as any;
    const storedSession = storage.values.activeSession as any;
    expect(storedSession.profileSnapshot.domains).not.toBe(storedConfiguration.profiles[0].domains);
    storedConfiguration.profiles[0].domains.push({ canonicalHost: "other.com", displayHost: "other.com", kind: "domain" });
    expect(storedSession.profileSnapshot.domains).toHaveLength(1);
  });

  it("serializes explicit starts across profiles and creates one effective expiration alarm", async () => {
    const storage = memoryStorage();
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "winner",
      alarms
    });
    await service.handle({ type: "CREATE_PROFILE", name: "Trabalho" });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "focus.example" });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "winner", input: "work.example" });

    const results = await Promise.all([
      service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 }),
      service.handle({ type: "START_SESSION", profileId: "winner", durationMinutes: 180 })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "SESSION_ALREADY_ACTIVE" }]);
    expect(storage.values.activeSession).toMatchObject({ durationMinutes: 5, profileSnapshot: { id: "focus" } });
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it("accepts cancellation immediately before the deadline and restores the inactive action", async () => {
    const storage = memoryStorage();
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const indicator = { setActive: vi.fn(async () => undefined), setInactive: vi.fn(async () => undefined) };
    let now = 10_000;
    const service = new BackgroundService(new StateStore(storage, () => now), {
      now: () => now,
      createId: () => "session-1",
      alarms,
      indicator
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
    expect(await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 })).toMatchObject({
      ok: true,
      data: { activeSession: { cancelAllowedUntil: 70_000 } }
    });
    const configurationBeforeCancellation = structuredClone(storage.values.configuration);
    now = 69_999;

    const response = await service.handle({ type: "CANCEL_SESSION" });

    expect(response).toMatchObject({ ok: true, data: { configuration: { lastDurationMinutes: 5 } } });
    expect(response.ok && response.data.activeSession).toBeUndefined();
    expect(storage.values.activeSession).toBeUndefined();
    expect(storage.values.configuration).toEqual(configurationBeforeCancellation);
    expect(alarms.clear).toHaveBeenCalledWith("pomodoro-expiration");
    expect(alarms.clear).toHaveBeenCalledTimes(1);
    expect(indicator.setActive).toHaveBeenCalledTimes(1);
    expect(indicator.setInactive).toHaveBeenCalledTimes(1);
  });

  it("rejects cancellation at and after the deadline without removal or effects", async () => {
    for (const currentTime of [70_000, 70_001]) {
      const storage = memoryStorage();
      const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
      const indicator = { setActive: vi.fn(async () => undefined), setInactive: vi.fn(async () => undefined) };
      let now = 10_000;
      const service = new BackgroundService(new StateStore(storage, () => now), {
        now: () => now,
        createId: () => "session-1",
        alarms,
        indicator
      });
      await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
      await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 });
      now = currentTime;
      const writesBefore = storage.writes.length;

      expect(await service.handle({ type: "CANCEL_SESSION" })).toEqual({ ok: false, error: "CANCEL_WINDOW_CLOSED" });
      expect(storage.values.activeSession).toBeDefined();
      expect(storage.writes).toHaveLength(writesBefore);
      expect(alarms.clear).not.toHaveBeenCalled();
      expect(indicator.setInactive).not.toHaveBeenCalled();
    }
  });

  it("serializes two cancellations so only one removes the session", async () => {
    const storage = memoryStorage();
    const alarms = { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) };
    const indicator = { setActive: vi.fn(async () => undefined), setInactive: vi.fn(async () => undefined) };
    const service = new BackgroundService(new StateStore(storage, () => 10_000), {
      now: () => 10_000,
      createId: () => "session-1",
      alarms,
      indicator
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
    await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 });

    const results = await Promise.all([
      service.handle({ type: "CANCEL_SESSION" }),
      service.handle({ type: "CANCEL_SESSION" })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "NO_ACTIVE_SESSION" }]);
    expect(alarms.clear).toHaveBeenCalledTimes(1);
    expect(indicator.setInactive).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation successful and retries derived resources after auxiliary API failures", async () => {
    const storage = memoryStorage();
    const alarms = {
      create: vi.fn(async () => undefined),
      clear: vi.fn().mockRejectedValueOnce(new Error("alarms unavailable")).mockResolvedValue(true)
    };
    const indicator = {
      setActive: vi.fn(async () => undefined),
      setInactive: vi.fn().mockRejectedValueOnce(new Error("action unavailable")).mockResolvedValue(undefined)
    };
    let now = 10_000;
    const service = new BackgroundService(new StateStore(storage, () => now), {
      now: () => now,
      createId: () => "session-1",
      alarms,
      indicator
    });
    await service.handle({ type: "ADD_BLOCKED_HOST", profileId: "focus", input: "example.com" });
    await service.handle({ type: "START_SESSION", profileId: "focus", durationMinutes: 5 });
    now = 69_999;

    expect(await service.handle({ type: "CANCEL_SESSION" })).toMatchObject({ ok: true });
    expect(storage.values.activeSession).toBeUndefined();
    expect(await service.handle({ type: "GET_STATE" })).toMatchObject({ ok: true, data: { configuration: {} } });
    expect(alarms.clear).toHaveBeenCalledTimes(2);
    expect(indicator.setInactive).toHaveBeenCalledTimes(2);
  });
});
