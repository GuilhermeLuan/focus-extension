export type StoredConfiguration = {
  schemaVersion: 1;
  profile: {
    id: "focus";
    name: "Foco";
    hostname: string | null;
  };
};

export type ActiveSession = {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  endsAt: number;
  durationMinutes: 50;
  profileSnapshot: {
    id: "focus";
    name: "Foco";
    hostname: string;
  };
};

export type ExtensionStorage = {
  configuration: StoredConfiguration;
  activeSession?: ActiveSession;
};

export type ExtensionState = {
  configuration: StoredConfiguration;
  activeSession?: ActiveSession;
};

export type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "SET_HOSTNAME"; hostname: string }
  | { type: "START_SESSION" };

export type BackgroundError =
  | "INVALID_HOSTNAME"
  | "HOSTNAME_REQUIRED"
  | "SESSION_ALREADY_ACTIVE"
  | "STORAGE_ERROR";

export type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: BackgroundError };

export type StateResponse = BackgroundResponse<ExtensionState>;

export const defaultConfiguration = (): StoredConfiguration => ({
  schemaVersion: 1,
  profile: { id: "focus", name: "Foco", hostname: null }
});
