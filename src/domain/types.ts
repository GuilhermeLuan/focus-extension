export type BlockedHostKind = "domain" | "ipv4" | "ipv6" | "localhost";

export type BlockedHost = {
  canonicalHost: string;
  displayHost: string;
  kind: BlockedHostKind;
};

export type BlockingProfile = {
  id: string;
  name: string;
  domains: BlockedHost[];
  createdAt: number;
  updatedAt: number;
};

export type StoredConfiguration = {
  schemaVersion: 1;
  lastSelectedProfileId: string;
  lastDurationMinutes: number;
  profiles: BlockingProfile[];
};

export type ActiveSession = {
  schemaVersion: 1;
  id: string;
  startedAt: number;
  cancelAllowedUntil: number;
  endsAt: number;
  durationMinutes: number;
  profileSnapshot: {
    id: string;
    name: string;
    domains: BlockedHost[];
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

export type ExportConfigurationRequest = { type: "EXPORT_CONFIGURATION" };

export type ImportConfigurationRequest = {
  type: "IMPORT_CONFIGURATION";
  content: string;
  expectedCurrentConfiguration: StoredConfiguration;
};

export type BackgroundRequest =
  | { type: "GET_STATE" }
  | ExportConfigurationRequest
  | ImportConfigurationRequest
  | { type: "CREATE_PROFILE"; name: string }
  | { type: "SELECT_PROFILE"; profileId: string }
  | { type: "RENAME_PROFILE"; profileId: string; name: string }
  | { type: "DELETE_PROFILE"; profileId: string }
  | {
      type: "ADD_BLOCKED_HOST";
      profileId: string;
      input: string;
      confirmConsolidation?: boolean;
    }
  | { type: "REMOVE_BLOCKED_HOST"; profileId: string; canonicalHost: string }
  | { type: "BLOCK_CURRENT_SITE"; url: string }
  | { type: "START_SESSION"; profileId: string; durationMinutes: number }
  | { type: "CANCEL_SESSION" }
  // Kept as a compatibility shim for the #1 popup. New screens do not send it.
  | { type: "SET_HOSTNAME"; hostname: string };

export type StartSessionError =
  | "PROFILE_REQUIRED"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_EMPTY"
  | "INVALID_DURATION"
  | "SESSION_ALREADY_ACTIVE"
  | "PRIVATE_PERMISSION_REQUIRED"
  | "STORAGE_ERROR";

export type CancelSessionError = "NO_ACTIVE_SESSION" | "CANCEL_WINDOW_CLOSED" | "STORAGE_ERROR";

export type ImportConfigurationError =
  | "IMPORT_SESSION_ACTIVE"
  | "BACKUP_TOO_LARGE"
  | "INVALID_BACKUP"
  | "UNSUPPORTED_BACKUP_VERSION"
  | "CONFIGURATION_CHANGED"
  | "STORAGE_ERROR";

export type ExportConfigurationData = {
  fileName: string;
  content: string;
};

export type BackgroundError =
  | "INVALID_PROFILE_NAME"
  | "DUPLICATE_PROFILE_NAME"
  | "PROFILE_NOT_FOUND"
  | "LAST_PROFILE"
  | "PROFILE_IN_SESSION"
  | "INVALID_HOSTNAME"
  | "HOSTNAME_REQUIRED"
  | "PROTECTED_HOSTNAME"
  | "HOST_ALREADY_COVERED"
  | "CONFIRM_CONSOLIDATION"
  | "URL_UNAVAILABLE"
  | StartSessionError
  | CancelSessionError
  | ImportConfigurationError;

export type ConsolidationDetails = {
  candidate: BlockedHost;
  removedHosts: BlockedHost[];
};

export type BackgroundResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: BackgroundError;
      existingHost?: BlockedHost;
      consolidation?: ConsolidationDetails;
    };

export type StateResponse = BackgroundResponse<ExtensionState>;

export const defaultConfiguration = (now = Date.now()): StoredConfiguration => ({
  schemaVersion: 1,
  lastSelectedProfileId: "focus",
  lastDurationMinutes: 50,
  profiles: [
    {
      id: "focus",
      name: "Foco",
      domains: [],
      createdAt: now,
      updatedAt: now
    }
  ]
});
