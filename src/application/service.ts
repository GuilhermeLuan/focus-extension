import {
  analyzeBlockedHostInsertion,
  isProtectedHostInput,
  normalizeBlockedHost,
  type BlockedHostInsertion
} from "../domain/hostname";
import {
  BackupValidationError,
  parseConfigurationBackup,
  serializeConfigurationBackup
} from "./backup";
import type { ExistingTabsAdapter } from "./existing-tabs";
import {
  type ActiveSession,
  type BackgroundError,
  type BackgroundRequest,
  type BackgroundResponse,
  type BlockingProfile,
  type ExportConfigurationData,
  type ExtensionState,
  type StoredConfiguration
} from "../domain/types";
import {
  StateStore,
  type Clock
} from "./storage";

export type CompletionNotificationOptions = {
  title: "Pomodoro concluído";
  message: string;
};

export type CompletionNotifier = {
  show(id: string, options: CompletionNotificationOptions): Promise<void>;
};

export type ServiceOptions = {
  now?: Clock;
  createId?: () => string;
  alarms?: AlarmScheduler;
  isAllowedIncognitoAccess?: () => Promise<boolean>;
  indicator?: ActionIndicator;
  existingTabs?: ExistingTabsAdapter;
  notifier?: CompletionNotifier;
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

const noExistingTabs: ExistingTabsAdapter = {
  async scan() {}
};

const noNotifier: CompletionNotifier = {
  async show() {
    throw new Error("completion notifier unavailable");
  }
};

export const COMPLETION_NOTIFICATION_TITLE = "Pomodoro concluído" as const;

export function completionNotificationId(sessionId: string): string {
  return `pomodoro-completed:${sessionId}`;
}

const backgroundRequestTypes = new Set<BackgroundRequest["type"]>([
  "GET_STATE",
  "EXPORT_CONFIGURATION",
  "IMPORT_CONFIGURATION",
  "CREATE_PROFILE",
  "SELECT_PROFILE",
  "RENAME_PROFILE",
  "DELETE_PROFILE",
  "ADD_BLOCKED_HOST",
  "REMOVE_BLOCKED_HOST",
  "BLOCK_CURRENT_SITE",
  "START_SESSION",
  "CANCEL_SESSION",
  "SET_HOSTNAME"
]);

function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && backgroundRequestTypes.has(type as BackgroundRequest["type"]);
}

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

function deeplyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deeplyEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && deeplyEqual(leftRecord[key], rightRecord[key])
    )
  );
}

export class BackgroundService {
  private readonly now: Clock;
  private readonly createId: () => string;
  private readonly alarms: AlarmScheduler;
  private readonly isAllowedIncognitoAccess: () => Promise<boolean>;
  private readonly indicator: ActionIndicator;
  private readonly existingTabs: ExistingTabsAdapter;
  private readonly notifier: CompletionNotifier;
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
    this.existingTabs = options.existingTabs ?? noExistingTabs;
    this.notifier = options.notifier ?? noNotifier;
  }

  public handle(request: { type: "EXPORT_CONFIGURATION" }): Promise<BackgroundResponse<ExportConfigurationData>>;
  public handle(request: Exclude<BackgroundRequest, { type: "EXPORT_CONFIGURATION" }>): Promise<BackgroundResponse<ExtensionState>>;
  public handle(
    request: BackgroundRequest
  ): Promise<BackgroundResponse<ExtensionState> | BackgroundResponse<ExportConfigurationData>>;
  public handle(
    request: BackgroundRequest
  ): Promise<BackgroundResponse<ExtensionState> | BackgroundResponse<ExportConfigurationData>> {
    return this.enqueue(() => this.handleRequest(request));
  }

  /**
   * Reconcile persisted state and its derived browser resources in the same
   * queue used by messages and alarms. Lifecycle handlers deliberately receive
   * a void promise: auxiliary browser failures are retried by the next valid
   * trigger and must not become unhandled listener rejections.
   */
  public reconcile(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.readAndReconcile();
      } catch {
        // Storage can be unavailable while the browser is starting. A later
        // lifecycle event, alarm, or valid request retries the read.
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const response = this.requestQueue.then(task);
    this.requestQueue = response.then(
      () => undefined,
      () => undefined
    );
    return response;
  }

  private async handleRequest(
    request: BackgroundRequest
  ): Promise<BackgroundResponse<ExtensionState> | BackgroundResponse<ExportConfigurationData>> {
    try {
      // Unknown messages must preserve the old error behavior without any
      // storage or browser side effects.
      if (!isBackgroundRequest(request)) return { ok: false, error: "STORAGE_ERROR" };

      const { state, currentTime } = await this.readAndReconcile();
      if (request.type === "GET_STATE") return { ok: true, data: state };
      if (request.type === "EXPORT_CONFIGURATION") return await this.exportConfiguration(state, currentTime);
      if (request.type === "IMPORT_CONFIGURATION") {
        return await this.importConfiguration(request.content, request.expectedCurrentConfiguration, state);
      }
      if (request.type === "CREATE_PROFILE") return await this.createProfile(request.name, state, currentTime);
      if (request.type === "SELECT_PROFILE") return await this.selectProfile(request.profileId, state);
      if (request.type === "RENAME_PROFILE") return await this.renameProfile(request.profileId, request.name, state, currentTime);
      if (request.type === "DELETE_PROFILE") return await this.deleteProfile(request.profileId, state);
      if (request.type === "ADD_BLOCKED_HOST") {
        return await this.addBlockedHost(
          request.profileId,
          request.input,
          request.confirmConsolidation === true,
          state,
          currentTime
        );
      }
      if (request.type === "REMOVE_BLOCKED_HOST") {
        return await this.removeBlockedHost(request.profileId, request.canonicalHost, state, currentTime);
      }
      if (request.type === "BLOCK_CURRENT_SITE") return await this.blockCurrentSite(request.url, state, currentTime);
      if (request.type === "SET_HOSTNAME") return await this.setHostnameCompatibility(request.hostname, state, currentTime);
      if (request.type === "START_SESSION") {
        return await this.startSession(request.profileId, request.durationMinutes, state, currentTime);
      }
      if (request.type === "CANCEL_SESSION") return await this.cancelSession(state, currentTime);
      return { ok: false, error: "STORAGE_ERROR" };
    } catch {
      return { ok: false, error: "STORAGE_ERROR" };
    }
  }

  private async exportConfiguration(
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExportConfigurationData>> {
    return { ok: true, data: serializeConfigurationBackup(state.configuration, currentTime) };
  }

  private async readAndReconcile(): Promise<{ state: ExtensionState; currentTime: number }> {
    const currentTime = this.now();
    const state = await this.store.read(currentTime);
    await this.reconcileState(state);
    return { state, currentTime };
  }

  private async importConfiguration(
    content: string,
    expectedCurrentConfiguration: StoredConfiguration,
    state: ExtensionState
  ): Promise<BackgroundResponse<ExtensionState>> {
    let imported: StoredConfiguration;
    try {
      imported = parseConfigurationBackup(content).configuration;
    } catch (error) {
      if (error instanceof BackupValidationError) return { ok: false, error: error.code };
      throw error;
    }

    if (state.activeSession) return { ok: false, error: "IMPORT_SESSION_ACTIVE" };
    if (!deeplyEqual(state.configuration, expectedCurrentConfiguration)) {
      return { ok: false, error: "CONFIGURATION_CHANGED" };
    }

    await this.store.saveConfiguration(imported);
    return { ok: true, data: { configuration: imported } };
  }

  public handleAlarm(name: string): Promise<void> {
    return this.enqueue(() => this.reconcileAlarm(name));
  }

  private async reconcileAlarm(name: string): Promise<void> {
    if (name !== EXPIRATION_ALARM) return;
    try {
      await this.readAndReconcile();
    } catch {
      // A later state read can retry reconciliation without blocking navigation.
    }
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

  private async reconcileState(state: ExtensionState): Promise<void> {
    await this.reconcileSessionResources(state);
    await this.deliverPendingCompletionNotification();
  }

  private async deliverPendingCompletionNotification(): Promise<void> {
    const pending = await this.store.readPendingCompletionNotifications();
    for (const notification of pending) {
      const id = completionNotificationId(notification.sessionId);
      try {
        await this.notifier.show(id, {
          title: COMPLETION_NOTIFICATION_TITLE,
          message: "Seu período de foco terminou."
        });
        await this.store.removePendingCompletionNotification(notification.sessionId);
      } catch {
        // Keep the completion record for the next reconciliation when either
        // notification creation or its acknowledgement cannot be completed.
      }
    }
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

  private async createProfile(
    name: string,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (!validProfileName(name)) return { ok: false, error: "INVALID_PROFILE_NAME" };
    const trimmed = name.trim();
    if (state.configuration.profiles.some((profile) => nameKey(profile.name) === nameKey(trimmed))) {
      return { ok: false, error: "DUPLICATE_PROFILE_NAME" };
    }
    const profile: BlockingProfile = {
      id: this.createId(),
      name: trimmed,
      domains: [],
      createdAt: currentTime,
      updatedAt: currentTime
    };
    const configuration = cloneConfiguration(state.configuration);
    configuration.profiles.push(profile);
    return this.persistConfiguration(state, configuration);
  }

  private async selectProfile(
    profileId: string,
    state: ExtensionState
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (this.profileOrError(state.configuration, profileId) === "PROFILE_NOT_FOUND") {
      return { ok: false, error: "PROFILE_NOT_FOUND" };
    }
    const configuration = cloneConfiguration(state.configuration);
    configuration.lastSelectedProfileId = profileId;
    return this.persistConfiguration(state, configuration);
  }

  private async renameProfile(
    profileId: string,
    name: string,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (!validProfileName(name)) return { ok: false, error: "INVALID_PROFILE_NAME" };
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
    next.updatedAt = currentTime;
    return this.persistConfiguration(state, configuration);
  }

  private async deleteProfile(
    profileId: string,
    state: ExtensionState
  ): Promise<BackgroundResponse<ExtensionState>> {
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
    confirmConsolidation: boolean,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    const normalized = normalizeBlockedHost(input);
    if (!normalized) {
      return { ok: false, error: isProtectedHostInput(input) ? "PROTECTED_HOSTNAME" : "INVALID_HOSTNAME" };
    }
    return this.addNormalizedHost(profileId, normalized, confirmConsolidation, state, currentTime);
  }

  private async addNormalizedHost(
    profileId: string,
    normalized: NonNullable<ReturnType<typeof normalizeBlockedHost>>,
    confirmConsolidation: boolean,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
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
    nextProfile.updatedAt = currentTime;
    return this.persistConfiguration(state, configuration);
  }

  private async removeBlockedHost(
    profileId: string,
    canonicalHost: string,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    if (profileIsLocked(state, profileId)) return { ok: false, error: "PROFILE_IN_SESSION" };

    const normalized = canonicalHost.trim().toLowerCase().replace(/\.$/, "");
    const configuration = cloneConfiguration(state.configuration);
    const nextProfile = configuration.profiles.find((candidate) => candidate.id === profileId)!;
    nextProfile.domains = nextProfile.domains.filter((host) => host.canonicalHost !== normalized);
    if (nextProfile.domains.length !== profile.domains.length) {
      nextProfile.updatedAt = currentTime;
      return this.persistConfiguration(state, configuration);
    }
    return { ok: true, data: state };
  }

  private async blockCurrentSite(
    url: string,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (state.activeSession) return { ok: false, error: "SESSION_ALREADY_ACTIVE" };
    const profileId = state.configuration.lastSelectedProfileId;
    const profile = this.profileOrError(state.configuration, profileId);
    if (typeof profile === "string") return { ok: false, error: profile };
    const normalized = normalizeBlockedHost(url);
    if (!normalized) {
      return { ok: false, error: isProtectedHostInput(url) ? "PROTECTED_HOSTNAME" : "URL_UNAVAILABLE" };
    }
    return this.addNormalizedHost(profile.id, normalized, false, state, currentTime);
  }

  private async setHostnameCompatibility(
    input: string,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    if (!input.trim()) return { ok: false, error: "HOSTNAME_REQUIRED" };
    const normalized = normalizeBlockedHost(input);
    if (!normalized || normalized.kind !== "domain") return { ok: false, error: "INVALID_HOSTNAME" };
    return this.addNormalizedHost(state.configuration.lastSelectedProfileId, normalized, true, state, currentTime);
  }

  private async startSession(
    requestedProfileId: string,
    requestedDurationMinutes: number,
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
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

    const startedAt = currentTime;
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
    try {
      await this.existingTabs.scan(activeSession);
    } catch {
      // Existing tabs are best-effort. The persisted session remains authoritative.
    }
    return { ok: true, data: nextState };
  }

  private async cancelSession(
    state: ExtensionState,
    currentTime: number
  ): Promise<BackgroundResponse<ExtensionState>> {
    const activeSession = state.activeSession;
    if (!activeSession) {
      return { ok: false, error: "NO_ACTIVE_SESSION" };
    }
    if (currentTime >= activeSession.cancelAllowedUntil) {
      return { ok: false, error: "CANCEL_WINDOW_CLOSED" };
    }

    await this.store.clearSession();
    const nextState = { configuration: state.configuration };
    await this.reconcileSessionResources(nextState);
    return { ok: true, data: nextState };
  }
}
