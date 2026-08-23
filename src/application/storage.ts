export type StorageArea = {
  get(keys?: string[] | string | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[] | string): Promise<void>;
};

import {
  defaultConfiguration,
  type ActiveSession,
  type ExtensionState,
  type StoredConfiguration
} from "../domain/types";

export type Clock = () => number;

export class StateStore {
  public constructor(
    private readonly storage: StorageArea,
    private readonly now: Clock = () => Date.now()
  ) {}

  public async read(currentTime = this.now()): Promise<ExtensionState> {
    const raw = await this.storage.get(["configuration", "activeSession"]);
    let configuration = raw.configuration as StoredConfiguration | undefined;
    if (!configuration) {
      configuration = defaultConfiguration();
      await this.storage.set({ configuration });
    }

    const activeSession = raw.activeSession as ActiveSession | undefined;
    if (activeSession && activeSession.endsAt <= currentTime) {
      await this.storage.remove("activeSession");
      return { configuration };
    }

    return activeSession ? { configuration, activeSession } : { configuration };
  }

  public async saveConfiguration(configuration: StoredConfiguration): Promise<void> {
    await this.storage.set({ configuration });
  }

  public async saveSession(activeSession: ActiveSession): Promise<void> {
    await this.storage.set({ activeSession });
  }

  public async clearSession(): Promise<void> {
    await this.storage.remove("activeSession");
  }
}
