import {
  defaultConfiguration,
  type ActiveSession,
  type BlockedHost,
  type BlockingProfile,
  type ExtensionState,
  type StoredConfiguration
} from "../domain/types";
import { normalizeBlockedHost } from "../domain/hostname";

export type StorageArea = {
  get(keys?: string[] | string | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[] | string): Promise<void>;
};

export type Clock = () => number;

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 180 && value % 5 === 0;
}

type LegacyConfiguration = {
  schemaVersion?: unknown;
  profile?: { id?: unknown; name?: unknown; hostname?: unknown };
};

type LegacySession = {
  schemaVersion?: unknown;
  id?: unknown;
  startedAt?: unknown;
  endsAt?: unknown;
  cancelAllowedUntil?: unknown;
  durationMinutes?: unknown;
  profileSnapshot?: { id?: unknown; name?: unknown; hostname?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneHost(host: BlockedHost): BlockedHost {
  return { ...host };
}

function cloneConfiguration(configuration: StoredConfiguration): StoredConfiguration {
  return {
    schemaVersion: 1,
    lastSelectedProfileId: configuration.lastSelectedProfileId,
    lastDurationMinutes: configuration.lastDurationMinutes,
    profiles: configuration.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      domains: profile.domains.map(cloneHost),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    }))
  };
}

function isBlockedHost(value: unknown): value is BlockedHost {
  if (!isRecord(value)) return false;
  return (
    typeof value.canonicalHost === "string" &&
    typeof value.displayHost === "string" &&
    (value.kind === "domain" || value.kind === "ipv4" || value.kind === "ipv6" || value.kind === "localhost")
  );
}

function isProfile(value: unknown): value is BlockingProfile {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.domains) &&
    value.domains.every(isBlockedHost) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isConfiguration(value: unknown): value is StoredConfiguration {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.lastSelectedProfileId === "string" &&
    isValidDuration(value.lastDurationMinutes) &&
    Array.isArray(value.profiles) &&
    value.profiles.length > 0 &&
    value.profiles.every(isProfile)
  );
}

function isSession(value: unknown): value is ActiveSession {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  const snapshot = value.profileSnapshot;
  return (
    typeof value.id === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.endsAt === "number" &&
    isValidDuration(value.durationMinutes) &&
    isRecord(snapshot) &&
    typeof snapshot.id === "string" &&
    typeof snapshot.name === "string" &&
    Array.isArray(snapshot.domains) &&
    snapshot.domains.every(isBlockedHost)
  );
}

function canonicalizeSession(session: ActiveSession): { session: ActiveSession; changed: boolean } {
  const cancelAllowedUntil = session.startedAt + 60_000;
  return {
    session: { ...session, cancelAllowedUntil },
    changed: session.cancelAllowedUntil !== cancelAllowedUntil
  };
}

function cloneSession(session: ActiveSession): ActiveSession {
  return {
    schemaVersion: 1,
    id: session.id,
    startedAt: session.startedAt,
    cancelAllowedUntil: session.cancelAllowedUntil,
    endsAt: session.endsAt,
    durationMinutes: session.durationMinutes,
    profileSnapshot: {
      id: session.profileSnapshot.id,
      name: session.profileSnapshot.name,
      domains: session.profileSnapshot.domains.map(cloneHost)
    }
  };
}

function migrateLegacyConfiguration(raw: LegacyConfiguration, now: number): StoredConfiguration | null {
  if (!isRecord(raw.profile)) return null;
  const legacy = raw.profile;
  const id = typeof legacy.id === "string" && legacy.id ? legacy.id : "focus";
  const name = typeof legacy.name === "string" && legacy.name.trim() ? legacy.name.trim() : "Foco";
  const hostname = typeof legacy.hostname === "string" ? normalizeBlockedHost(legacy.hostname) : null;
  const profile: BlockingProfile = {
    id,
    name,
    domains: hostname ? [hostname] : [],
    createdAt: now,
    updatedAt: now
  };
  return {
    schemaVersion: 1,
    lastSelectedProfileId: id,
    lastDurationMinutes: 50,
    profiles: [profile]
  };
}

function migrateLegacySession(raw: LegacySession): ActiveSession | null {
  const snapshot = raw.profileSnapshot;
  if (
    typeof raw.id !== "string" ||
    typeof raw.startedAt !== "number" ||
    typeof raw.endsAt !== "number" ||
    !isRecord(snapshot) ||
    typeof snapshot.id !== "string" ||
    typeof snapshot.name !== "string" ||
    typeof snapshot.hostname !== "string"
  ) {
    return null;
  }
  const hostname = normalizeBlockedHost(snapshot.hostname);
  if (!hostname) return null;
  return {
    schemaVersion: 1,
    id: raw.id,
    startedAt: raw.startedAt,
    cancelAllowedUntil: raw.startedAt + 60_000,
    endsAt: raw.endsAt,
    durationMinutes: 50,
    profileSnapshot: {
      id: snapshot.id,
      name: snapshot.name,
      domains: [hostname]
    }
  };
}

export class StateStore {
  public constructor(
    private readonly storage: StorageArea,
    private readonly now: Clock = () => Date.now()
  ) {}

  public async read(currentTime = this.now()): Promise<ExtensionState> {
    const raw = await this.storage.get(["configuration", "activeSession"]);
    const rawConfiguration = raw.configuration;
    let configuration: StoredConfiguration;
    let migrated = false;

    if (isConfiguration(rawConfiguration)) {
      configuration = cloneConfiguration(rawConfiguration);
    } else if (rawConfiguration === undefined) {
      configuration = defaultConfiguration(currentTime);
      migrated = true;
    } else {
      configuration = migrateLegacyConfiguration(rawConfiguration as LegacyConfiguration, currentTime) ?? (() => {
        throw new Error("Invalid configuration");
      })();
      migrated = true;
    }

    const rawSession = raw.activeSession;
    let activeSession: ActiveSession | undefined;
    if (rawSession === undefined) {
      activeSession = undefined;
    } else if (isSession(rawSession)) {
      const canonical = canonicalizeSession(rawSession);
      activeSession = cloneSession(canonical.session);
      migrated ||= canonical.changed;
    } else {
      activeSession = migrateLegacySession(rawSession as LegacySession) ?? undefined;
      migrated = true;
    }

    if (migrated) {
      // Configuration and a legacy snapshot are migrated together, preventing
      // observers from seeing a new config paired with an old session shape.
      await this.storage.set({
        configuration,
        ...(activeSession ? { activeSession } : {})
      });
    }

    if (activeSession && activeSession.endsAt <= currentTime) {
      await this.storage.remove("activeSession");
      return { configuration };
    }

    return activeSession ? { configuration, activeSession } : { configuration };
  }

  public async saveConfiguration(configuration: StoredConfiguration): Promise<void> {
    await this.storage.set({ configuration: cloneConfiguration(configuration) });
  }

  public async saveSession(activeSession: ActiveSession): Promise<void> {
    await this.storage.set({ activeSession: cloneSession(canonicalizeSession(activeSession).session) });
  }

  public async clearSession(): Promise<void> {
    await this.storage.remove("activeSession");
  }
}
