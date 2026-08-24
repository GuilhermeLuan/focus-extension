import {
  analyzeBlockedHostInsertion,
  isProtectedHostInput,
  normalizeBlockedHost,
  type BlockedHostInsertion
} from "../domain/hostname";
import {
  type ActiveSession,
  type BackgroundError,
  type BackgroundRequest,
  type BackgroundResponse,
  type BlockingProfile,
  type ExtensionState,
  type StoredConfiguration
} from "../domain/types";
import { StateStore, type Clock } from "./storage";

export type ServiceOptions = {
  now?: Clock;
  createId?: () => string;
  alarms?: AlarmScheduler;
  isAllowedIncognitoAccess?: () => Promise<boolean>;
  indicator?: ActionIndicator;
};

export type AlarmScheduler = {
  create(name: string, alarm: { when: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
};

export type ActionIndicator = {
  setActive(): Promise<void> | void;
  setInactive(): Promise<void> | void;
};

const EXPIRATION_ALARM = "pomodoro-expiration";

const noAlarms: AlarmScheduler = {
  async create() {},
  async clear() {
    return false;
  }
};

const noIndicator: ActionIndicator = {
  async setActive() {},
  async setInactive() {}
};

function cloneProfile(profile: BlockingProfile): BlockingProfile {
  return {
    ...profile,
    domains: profile.domains.map((domain) => ({ ...domain }))
  };
}

function cloneConfiguration(configuration: StoredConfiguration): StoredConfiguration {
  return {
    ...configuration,
    profiles: configuration.profiles.map(cloneProfile)
  };
}

function nameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function validProfileName(name: string): boolean {
  const trimmed = name.trim();
  const characterCount = [...trimmed].length;
  return characterCount >= 1 && characterCount <= 40;
}

function profileIsLocked(state: ExtensionState, profileId: string): boolean {
  return state.activeSession?.profileSnapshot.id === profileId;
}

export class BackgroundService {
  private readonly now: Clock;
  private readonly createId: () => string;
  private readonly alarms: AlarmScheduler;
  private readonly isAllowedIncognitoAccess: () => Promise<boolean>;
  private readonly indicator: ActionIndicator;
  private requestQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: StateStore,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.alarms = options.alarms ?? noAlarms;
    this.isAllowedIncognitoAccess = options.isAllowedIncognitoAccess ?? (async () => true);
    this.indicator = options.indicator ?? noIndicator;
  }

  public handle(request: BackgroundRequest): Promise<BackgroundResponse<ExtensionState>> {
    const response = this.requestQueue.then(() => this.handleRequest(request));
    this.requestQueue = response.then(
      () => undefined,
      () => undefined
    );
    return response;
  }

  private async handleRequest(request: BackgroundRequest): Promise<BackgroundResponse<ExtensionState>> {
    try {
      if (request.type === "GET_STATE") {
        const state = await this.store.read(this.now());
        await this.reconcileSessionResources(state);
        return { ok: true, data: state };
      }
      if (request.type === "CREATE_PROFILE") return await this.createProfile(request.name);
      if (request.type === "SELECT_PROFILE") return await this.selectProfile(request.profileId);
      if (request.type === "RENAME_PROFILE") return await this.renameProfile(request.profileId, request.name);
      if (request.type === "DELETE_PROFILE") return await this.deleteProfile(request.profileId);
      if (request.type === "ADD_BLOCKED_HOST") {
        return await this.addBlockedHost(request.profileId, request.input, request.confirmConsolidation === true);
      }
      if (request.type === "REMOVE_BLOCKED_HOST") {
        return await this.removeBlockedHost(request.profileId, request.canonicalHost);
      }
      if (request.type === "BLOCK_CURRENT_SITE") return await this.blockCurrentSite(request.url);
      if (request.type === "SET_HOSTNAME") return await this.setHostnameCompatibility(request.hostname);
      if (request.type === "START_SESSION") {
        return await this.startSession(request.profileId, request.durationMinutes);
      }
      if (request.type === "CANCEL_SESSION") return await this.cancelSession();
      return { ok: false, error: "STORAGE_ERROR" };
    } catch {
      return { ok: false, error: "STORAGE_ERROR" };
    }
  }

  public handleAlarm(name: string): Promise<void> {
    const response = this.requestQueue.then(() => this.reconcileAlarm(name));
    this.requestQueue = response.then(
      () => undefined,
      () => undefined
    );
    return response;
  }

  private async reconcileAlarm(name: string): Promise<void> {
    if (name !== EXPIRATION_ALARM) return;
    try {
      const state = await this.store.read(this.now());
      await this.reconcileSessionResources(state);
    } catch {
      // A later state read can retry reconciliation without blocking navigation.
    }
  }

  private async currentState(): Promise<ExtensionState> {
    return this.store.read(this.now());
  }

  private async reconcileSessionResources(state: ExtensionState): Promise<void> {
    const alarmEffect = (async () => {
      if (state.activeSession) {
        await this.alarms.create(EXPIRATION_ALARM, { when: state.activeSession.endsAt });
      } else {
        await this.alarms.clear(EXPIRATION_ALARM);
      }
    })();
    const indicatorEffect = (async () => {
      if (state.activeSession) await this.indicator.setActive();
      else await this.indicator.setInactive();
    })();

    // Storage is authoritative. Auxiliary browser APIs are derived state and
    // are retried by the next GET_STATE, startup reconciliation, or alarm.
    await Promise.allSettled([alarmEffect, indicatorEffect]);
  }

  private profileOrError(
    configuration: StoredConfiguration,
    profileId: string
  ): BlockingProfile | BackgroundError {
    return configuration.profiles.find((profile) => profile.id === profileId) ?? "PROFILE_NOT_FOUND";
  }

  private async persistConfiguration(
    state: ExtensionState,
    configuration: StoredConfiguration
  ): Promise<BackgroundResponse<ExtensionState>> {
    await this.store.saveConfiguration(configuration);
    return { ok: true, data: { ...state, configuration } };
  }

  private async createProfile(name: string): Promise<BackgroundResponse<ExtensionState>> {
    if (!validProfileName(name)) return { ok: false, error: "INVALID_PROFILE_NAME" };
    const state = await this.currentState();
    const trimmed = name.trim();
    if (state.configuration.profiles.some((profile) => nameKey(profile.name) === nameKey(trimmed))) {
      return { ok: false, error: "DUPLICATE_PROFILE_NAME" };
    }
    const timestamp = this.now();
    const profile: BlockingProfile = {
      id: this.createId(),
      name: trimmed,
      domains: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const configuration = cloneConfiguration(state.configuration);
    configuration.profiles.push(profile);
    return this.persistConfiguration(state, configuration);
  }

  private async selectProfile(profileId: string): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    if (this.profileOrError(state.configuration, profileId) === "PROFILE_NOT_FOUND") {
      return { ok: false, error: "PROFILE_NOT_FOUND" };
    }
    const configuration = cloneConfiguration(state.configuration);
    configuration.lastSelectedProfileId = profileId;
    return this.persistConfiguration(state, configuration);
  }

  private async renameProfile(
    profileId: string,
    name: string
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (!validProfileName(name)) return { ok: false, error: "INVALID_PROFILE_NAME" };
    const state = await this.currentState();
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (profileIsLocked(state, profileId)) return { ok: false, error: "PROFILE_IN_SESSION" };
    const trimmed = name.trim();
    if (
      state.configuration.profiles.some(
        (candidate) => candidate.id !== profileId && nameKey(candidate.name) === nameKey(trimmed)
      )
    ) {
      return { ok: false, error: "DUPLICATE_PROFILE_NAME" };
    }
    const configuration = cloneConfiguration(state.configuration);
    const next = configuration.profiles.find((candidate) => candidate.id === profileId)!;
    next.name = trimmed;
    next.updatedAt = this.now();
    return this.persistConfiguration(state, configuration);
  }

  private async deleteProfile(profileId: string): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (state.configuration.profiles.length === 1) return { ok: false, error: "LAST_PROFILE" };
    if (profileIsLocked(state, profileId)) return { ok: false, error: "PROFILE_IN_SESSION" };

    const configuration = cloneConfiguration(state.configuration);
    configuration.profiles = configuration.profiles.filter((candidate) => candidate.id !== profileId);
    if (configuration.lastSelectedProfileId === profileId) {
      const replacement = configuration.profiles.reduce((latest, candidate) =>
        candidate.updatedAt > latest.updatedAt ? candidate : latest
      );
      configuration.lastSelectedProfileId = replacement.id;
    }
    return this.persistConfiguration(state, configuration);
  }

  private async addBlockedHost(
    profileId: string,
    input: string,
    confirmConsolidation: boolean
  ): Promise<BackgroundResponse<ExtensionState>> {
    const normalized = normalizeBlockedHost(input);
    if (!normalized) {
      return { ok: false, error: isProtectedHostInput(input) ? "PROTECTED_HOSTNAME" : "INVALID_HOSTNAME" };
    }
    return this.addNormalizedHost(profileId, normalized, confirmConsolidation);
  }

  private async addNormalizedHost(
    profileId: string,
    normalized: NonNullable<ReturnType<typeof normalizeBlockedHost>>,
    confirmConsolidation: boolean
  ): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (profileIsLocked(state, profileId)) return { ok: false, error: "PROFILE_IN_SESSION" };

    const analysis: BlockedHostInsertion = analyzeBlockedHostInsertion(
      normalized,
      profile.domains,
      confirmConsolidation
    );
    if (analysis.type === "invalid") return { ok: false, error: analysis.error };
    if (analysis.type === "covered") {
      return { ok: false, error: "HOST_ALREADY_COVERED", existingHost: analysis.existing };
    }
    if (analysis.type === "confirm") {
      return {
        ok: false,
        error: "CONFIRM_CONSOLIDATION",
        consolidation: { candidate: analysis.candidate, removedHosts: analysis.removedHosts }
      };
    }

    const configuration = cloneConfiguration(state.configuration);
    const nextProfile = configuration.profiles.find((candidate) => candidate.id === profileId)!;
    const removed = new Set(analysis.removedHosts.map((host) => host.canonicalHost));
    nextProfile.domains = [
      ...nextProfile.domains.filter((host) => !removed.has(host.canonicalHost)),
      { ...analysis.candidate }
    ];
    nextProfile.updatedAt = this.now();
    return this.persistConfiguration(state, configuration);
  }

  private async removeBlockedHost(
    profileId: string,
    canonicalHost: string
  ): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (profileIsLocked(state, profileId)) return { ok: false, error: "PROFILE_IN_SESSION" };

    const normalized = canonicalHost.trim().toLowerCase().replace(/\.$/, "");
    const configuration = cloneConfiguration(state.configuration);
    const nextProfile = configuration.profiles.find((candidate) => candidate.id === profileId)!;
    nextProfile.domains = nextProfile.domains.filter((host) => host.canonicalHost !== normalized);
    if (nextProfile.domains.length !== profile.domains.length) {
      nextProfile.updatedAt = this.now();
      return this.persistConfiguration(state, configuration);
    }
    return { ok: true, data: state };
  }

  private async blockCurrentSite(url: string): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    if (state.activeSession) return { ok: false, error: "SESSION_ALREADY_ACTIVE" };
    const profileId = state.configuration.lastSelectedProfileId;
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    const normalized = normalizeBlockedHost(url);
    if (!normalized) {
      return { ok: false, error: isProtectedHostInput(url) ? "PROTECTED_HOSTNAME" : "URL_UNAVAILABLE" };
    }
    return this.addNormalizedHost(profile.id, normalized, false);
  }

  private async setHostnameCompatibility(input: string): Promise<BackgroundResponse<ExtensionState>> {
    if (!input.trim()) return { ok: false, error: "HOSTNAME_REQUIRED" };
    const normalized = normalizeBlockedHost(input);
    if (!normalized || normalized.kind !== "domain") return { ok: false, error: "INVALID_HOSTNAME" };
    const state = await this.currentState();
    return this.addNormalizedHost(state.configuration.lastSelectedProfileId, normalized, true);
  }

  private async startSession(
    requestedProfileId: string,
    requestedDurationMinutes: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.currentState();
    if (state.activeSession) return { ok: false, error: "SESSION_ALREADY_ACTIVE" };

    if (typeof requestedProfileId !== "string" || !requestedProfileId.trim()) {
      return { ok: false, error: "PROFILE_REQUIRED" };
    }
    const profile = this.profileOrError(state.configuration, requestedProfileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (!profile.domains.length) return { ok: false, error: "PROFILE_EMPTY" };

    const durationMinutes = requestedDurationMinutes;
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 5 ||
      durationMinutes > 180 ||
      durationMinutes % 5 !== 0
    ) {
      return { ok: false, error: "INVALID_DURATION" };
    }
    if (!(await this.isAllowedIncognitoAccess())) {
      return { ok: false, error: "PRIVATE_PERMISSION_REQUIRED" };
    }

    const startedAt = this.now();
    const activeSession: ActiveSession = {
      schemaVersion: 1,
      id: this.createId(),
      startedAt,
      cancelAllowedUntil: startedAt + 60_000,
      endsAt: startedAt + durationMinutes * 60_000,
      durationMinutes,
      profileSnapshot: {
        id: profile.id,
        name: profile.name,
        domains: profile.domains.map((domain) => ({ ...domain }))
      }
    };
    await this.store.saveSession(activeSession);
    const configuration = cloneConfiguration(state.configuration);
    configuration.lastSelectedProfileId = profile.id;
    configuration.lastDurationMinutes = durationMinutes;
    await this.store.saveConfiguration(configuration);
    const nextState = { configuration, activeSession };
    await this.reconcileSessionResources(nextState);
    return { ok: true, data: nextState };
  }

  private async cancelSession(): Promise<BackgroundResponse<ExtensionState>> {
    const currentTime = this.now();
    const state = await this.store.read(currentTime);
    const activeSession = state.activeSession;
    if (!activeSession) return { ok: false, error: "NO_ACTIVE_SESSION" };
    if (currentTime >= activeSession.cancelAllowedUntil) {
      return { ok: false, error: "CANCEL_WINDOW_CLOSED" };
    }

    await this.store.clearSession();
    const nextState = { configuration: state.configuration };
    await this.reconcileSessionResources(nextState);
    return { ok: true, data: nextState };
  }
}
