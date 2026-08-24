import { describe, expect, it } from "vitest";
import { StateStore, type StorageArea } from "./storage";

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

describe("StateStore", () => {
  it("installs the empty Foco profile with a selected id and timestamps", async () => {
    const storage = memoryStorage();
    const store = new StateStore(storage, () => 1000);

    const state = await store.read();

    expect(state).toEqual({
      configuration: {
        schemaVersion: 1,
        lastSelectedProfileId: "focus",
        lastDurationMinutes: 50,
        profiles: [{
          id: "focus",
          name: "Foco",
          domains: [],
          createdAt: 1000,
          updatedAt: 1000
        }]
      }
    });
    expect(storage.values.configuration).toEqual(state.configuration);
  });

  it("migrates a legacy profile and session atomically and remains idempotent", async () => {
    const storage = memoryStorage({
      configuration: {
        schemaVersion: 1,
        profile: { id: "legacy", name: " Estudo ", hostname: "WWW.YouTube.com." }
      },
      activeSession: {
        schemaVersion: 1,
        id: "session-legacy",
        startedAt: 1000,
        endsAt: 5000,
        durationMinutes: 50,
        profileSnapshot: { id: "legacy", name: "Estudo", hostname: "youtube.com" }
      }
    });
    const store = new StateStore(storage, () => 2000);

    const state = await store.read();
    expect(state.configuration.profiles[0]).toMatchObject({
      id: "legacy",
      name: "Estudo",
      domains: [{ canonicalHost: "youtube.com", kind: "domain" }]
    });
    expect(state.activeSession?.profileSnapshot.domains).toEqual([
      { canonicalHost: "youtube.com", displayHost: "youtube.com", kind: "domain" }
    ]);
    expect(state.activeSession?.cancelAllowedUntil).toBe(61_000);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]).toHaveProperty("activeSession");

    await store.read();
    expect(storage.writes).toHaveLength(1);
  });

  it("round-trips valid configurable durations for configuration and sessions", async () => {
    const storage = memoryStorage({
      configuration: {
        schemaVersion: 1,
        lastSelectedProfileId: "focus",
        lastDurationMinutes: 25,
        profiles: [{
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }],
          createdAt: 1,
          updatedAt: 1
        }]
      },
      activeSession: {
        schemaVersion: 1,
        id: "session",
        startedAt: 1_000,
        cancelAllowedUntil: 61_000,
        endsAt: 1_501_000,
        durationMinutes: 25,
        profileSnapshot: {
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }]
        }
      }
    });

    const state = await new StateStore(storage, () => 2_000).read();

    expect(state.configuration.lastDurationMinutes).toBe(25);
    expect(state.activeSession?.durationMinutes).toBe(25);
    expect(storage.writes).toHaveLength(0);
  });

  it("migrates a V1 session to a fixed cancellation deadline once", async () => {
    const storage = memoryStorage({
      configuration: {
        schemaVersion: 1,
        lastSelectedProfileId: "focus",
        lastDurationMinutes: 50,
        profiles: [{
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }],
          createdAt: 1,
          updatedAt: 1
        }]
      },
      activeSession: {
        schemaVersion: 1,
        id: "old-session",
        startedAt: 10_000,
        endsAt: 3_010_000,
        durationMinutes: 50,
        profileSnapshot: {
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }]
        }
      }
    });
    const store = new StateStore(storage, () => 20_000);

    const state = await store.read();
    expect(state.activeSession?.cancelAllowedUntil).toBe(70_000);
    expect(storage.values.activeSession).toMatchObject({ cancelAllowedUntil: 70_000 });
    expect(storage.writes).toHaveLength(1);

    await store.read();
    expect(storage.writes).toHaveLength(1);
  });

  it("corrects a non-canonical cancellation deadline without moving startedAt", async () => {
    const storage = memoryStorage({
      configuration: {
        schemaVersion: 1,
        lastSelectedProfileId: "focus",
        lastDurationMinutes: 50,
        profiles: [{
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }],
          createdAt: 1,
          updatedAt: 1
        }]
      },
      activeSession: {
        schemaVersion: 1,
        id: "session",
        startedAt: 10_000,
        cancelAllowedUntil: 999_999,
        endsAt: 3_010_000,
        durationMinutes: 50,
        profileSnapshot: {
          id: "focus",
          name: "Foco",
          domains: [{ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" }]
        }
      }
    });

    const state = await new StateStore(storage, () => 20_000).read();
    expect(state.activeSession).toMatchObject({ startedAt: 10_000, cancelAllowedUntil: 70_000 });
    expect(storage.writes).toHaveLength(1);
  });
});
