import { normalizeHostname } from "../domain/hostname";
import {
  type ActiveSession,
  type BackgroundRequest,
  type BackgroundResponse,
  type ExtensionState
} from "../domain/types";
import { StateStore, type Clock } from "./storage";

export type ServiceOptions = {
  now?: Clock;
  createId?: () => string;
  alarms?: AlarmScheduler;
};

export type AlarmScheduler = {
  create(name: string, alarm: { when: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
};

const noAlarms: AlarmScheduler = {
  async create() {},
  async clear() {
    return false;
  }
};

export class BackgroundService {
  private readonly now: Clock;
  private readonly createId: () => string;
  private readonly alarms: AlarmScheduler;
  private requestQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: StateStore,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.alarms = options.alarms ?? noAlarms;
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
      if (request.type === "GET_STATE") return { ok: true, data: await this.store.read(this.now()) };
      if (request.type === "SET_HOSTNAME") return await this.setHostname(request.hostname);
      if (request.type === "START_SESSION") return await this.startSession();
      return { ok: false, error: "STORAGE_ERROR" };
    } catch {
      return { ok: false, error: "STORAGE_ERROR" };
    }
  }

  public async handleAlarm(name: string): Promise<void> {
    if (name !== "pomodoro-expiration") return;
    try {
      const state = await this.store.read(this.now());
      if (!state.activeSession) await this.alarms.clear(name);
    } catch {
      // A later state read can retry reconciliation without blocking navigation.
    }
  }

  private async setHostname(input: string): Promise<BackgroundResponse<ExtensionState>> {
    if (!input.trim()) return { ok: false, error: "HOSTNAME_REQUIRED" };
    const hostname = normalizeHostname(input);
    if (!hostname) return { ok: false, error: "INVALID_HOSTNAME" };
    const state = await this.store.read(this.now());
    const configuration = {
      ...state.configuration,
      profile: { ...state.configuration.profile, hostname }
    };
    await this.store.saveConfiguration(configuration);
    return { ok: true, data: { ...state, configuration } };
  }

  private async startSession(): Promise<BackgroundResponse<ExtensionState>> {
    const state = await this.store.read(this.now());
    if (state.activeSession) return { ok: false, error: "SESSION_ALREADY_ACTIVE" };
    const hostname = state.configuration.profile.hostname;
    if (!hostname) return { ok: false, error: "HOSTNAME_REQUIRED" };

    const startedAt = this.now();
    const activeSession: ActiveSession = {
      schemaVersion: 1,
      id: this.createId(),
      startedAt,
      endsAt: startedAt + 50 * 60_000,
      durationMinutes: 50,
      profileSnapshot: {
        id: "focus",
        name: "Foco",
        hostname
      }
    };
    await this.store.saveSession(activeSession);
    await this.alarms.create("pomodoro-expiration", { when: activeSession.endsAt });
    return { ok: true, data: { ...state, activeSession } };
  }
}
