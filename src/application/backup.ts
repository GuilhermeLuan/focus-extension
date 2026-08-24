import { normalizeBlockedHost } from "../domain/hostname";
import type {
  BlockedHost,
  BlockingProfile,
  StoredConfiguration
} from "../domain/types";

export const BACKUP_KIND = "focus-lock-backup" as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;
export const MAX_BACKUP_BYTES = 1_048_576;

export type FocusLockBackupV1 = {
  kind: typeof BACKUP_KIND;
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  configuration: StoredConfiguration;
};

export type BackupFile = {
  fileName: string;
  content: string;
};

export type BackupSummary = {
  exportedAt: string;
  profileCount: number;
  ruleCount: number;
  selectedProfileName: string;
  durationMinutes: number;
};

export type BackupErrorCode =
  | "BACKUP_TOO_LARGE"
  | "INVALID_BACKUP"
  | "UNSUPPORTED_BACKUP_VERSION";

/** A content error which can be mapped to a background protocol error. */
export class BackupValidationError extends Error {
  public constructor(public readonly code: BackupErrorCode) {
    super(code);
    this.name = "BackupValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 180 && value % 5 === 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function cloneHost(host: BlockedHost): BlockedHost {
  return {
    canonicalHost: host.canonicalHost,
    displayHost: host.displayHost,
    kind: host.kind
  };
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

function canonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validName(name: unknown): name is string {
  if (typeof name !== "string" || name.trim() !== name) return false;
  const length = [...name].length;
  return length >= 1 && length <= 40;
}

function validHost(value: unknown): value is BlockedHost {
  if (!isRecord(value) || !hasExactKeys(value, ["canonicalHost", "displayHost", "kind"])) return false;
  if (typeof value.canonicalHost !== "string" || typeof value.displayHost !== "string") return false;
  if (value.canonicalHost.length === 0 || value.displayHost.length === 0) return false;

  const normalized = normalizeBlockedHost(value.canonicalHost);
  const normalizedDisplay = normalizeBlockedHost(value.displayHost);
  return (
    normalized !== null &&
    normalized.canonicalHost === value.canonicalHost &&
    normalized.kind === value.kind &&
    normalizedDisplay !== null &&
    normalizedDisplay.canonicalHost === value.canonicalHost &&
    normalizedDisplay.kind === value.kind &&
    normalizedDisplay.displayHost === value.displayHost
  );
}

function validProfile(value: unknown): value is BlockingProfile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "domains", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !validName(value.name) ||
    !Array.isArray(value.domains) ||
    !isValidTimestamp(value.createdAt) ||
    !isValidTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !value.domains.every(validHost)
  ) {
    return false;
  }

  const hosts = value.domains.map((host) => host.canonicalHost);
  return new Set(hosts).size === hosts.length;
}

function validConfiguration(value: unknown): value is StoredConfiguration {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "lastSelectedProfileId", "lastDurationMinutes", "profiles"]) ||
    value.schemaVersion !== 1 ||
    typeof value.lastSelectedProfileId !== "string" ||
    value.lastSelectedProfileId.trim().length === 0 ||
    !isValidDuration(value.lastDurationMinutes) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0 ||
    !value.profiles.every(validProfile)
  ) {
    return false;
  }

  const profileIds = value.profiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) return false;
  const profileNames = value.profiles.map((profile) => profile.name.normalize("NFKC").toLowerCase());
  if (new Set(profileNames).size !== profileNames.length) return false;
  return profileIds.includes(value.lastSelectedProfileId);
}

function invalid(): never {
  throw new BackupValidationError("INVALID_BACKUP");
}

function parseEnvelope(value: unknown): FocusLockBackupV1 {
  if (!isRecord(value)) return invalid();
  if (value.kind === BACKUP_KIND && Object.prototype.hasOwnProperty.call(value, "schemaVersion") && value.schemaVersion !== 1) {
    throw new BackupValidationError("UNSUPPORTED_BACKUP_VERSION");
  }
  if (
    !hasExactKeys(value, ["kind", "schemaVersion", "exportedAt", "configuration"]) ||
    value.kind !== BACKUP_KIND ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !canonicalIsoDate(value.exportedAt) ||
    !validConfiguration(value.configuration)
  ) {
    return invalid();
  }

  return {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    configuration: cloneConfiguration(value.configuration)
  };
}

/** Parse and strictly validate one UTF-8-decoded backup file. */
export function parseConfigurationBackup(content: string): FocusLockBackupV1 {
  if (typeof content !== "string") throw new BackupValidationError("INVALID_BACKUP");
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > MAX_BACKUP_BYTES) throw new BackupValidationError("BACKUP_TOO_LARGE");
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new BackupValidationError("INVALID_BACKUP");
  }
  return parseEnvelope(value);
}

/** Read a selected file at the page boundary, enforcing size before decoding. */
export async function decodeBackupFile(file: Pick<File, "size" | "arrayBuffer">): Promise<string> {
  if (file.size > MAX_BACKUP_BYTES) throw new BackupValidationError("BACKUP_TOO_LARGE");
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BackupValidationError("INVALID_BACKUP");
  }
}

export function createBackupEnvelope(
  configuration: StoredConfiguration,
  now = Date.now()
): FocusLockBackupV1 {
  return {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    configuration: cloneConfiguration(configuration)
  };
}

export function backupFileName(exportedAt: string): string {
  return `focus-lock-backup-${exportedAt.slice(0, 10)}.json`;
}

export function preImportBackupFileName(exportedAt: string): string {
  return `focus-lock-pre-import-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

/** Deterministically serialize a V1 envelope and derive its UTC filename. */
export function serializeConfigurationBackup(
  configuration: StoredConfiguration,
  now = Date.now()
): BackupFile {
  const envelope = createBackupEnvelope(configuration, now);
  return {
    fileName: backupFileName(envelope.exportedAt),
    content: `${JSON.stringify(envelope, null, 2)}\n`
  };
}

export function summarizeConfigurationBackup(backup: FocusLockBackupV1): BackupSummary {
  const selected = backup.configuration.profiles.find(
    (profile) => profile.id === backup.configuration.lastSelectedProfileId
  );
  return {
    exportedAt: backup.exportedAt,
    profileCount: backup.configuration.profiles.length,
    ruleCount: backup.configuration.profiles.reduce((total, profile) => total + profile.domains.length, 0),
    selectedProfileName: selected?.name ?? "",
    durationMinutes: backup.configuration.lastDurationMinutes
  };
}

// Concise aliases are useful at the seams consumed by tests and entrypoints.
export const parseBackup = parseConfigurationBackup;
export const serializeBackup = serializeConfigurationBackup;
export const summarizeBackup = summarizeConfigurationBackup;
export const readBackupFile = decodeBackupFile;
