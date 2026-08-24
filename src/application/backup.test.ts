import { describe, expect, it, vi } from "vitest";
import { defaultConfiguration } from "../domain/types";
import { normalizeBlockedHost } from "../domain/hostname";
import {
  BACKUP_KIND,
  BackupValidationError,
  MAX_BACKUP_BYTES,
  createBackupEnvelope,
  decodeBackupFile,
  parseConfigurationBackup,
  preImportBackupFileName,
  serializeConfigurationBackup,
  summarizeConfigurationBackup
} from "./backup";

describe("configuration backups", () => {
  it("serializes a deterministic V1 envelope without a session", () => {
    const configuration = defaultConfiguration(1_700_000_000_000);
    const expected = `{
  "kind": "focus-lock-backup",
  "schemaVersion": 1,
  "exportedAt": "2023-11-14T22:13:20.000Z",
  "configuration": {
    "schemaVersion": 1,
    "lastSelectedProfileId": "focus",
    "lastDurationMinutes": 50,
    "profiles": [
      {
        "id": "focus",
        "name": "Foco",
        "domains": [],
        "createdAt": 1700000000000,
        "updatedAt": 1700000000000
      }
    ]
  }
}\n`;

    const first = serializeConfigurationBackup(configuration, 1_700_000_000_000);
    const second = serializeConfigurationBackup(configuration, 1_700_000_000_000);

    expect(first).toEqual({ fileName: "focus-lock-backup-2023-11-14.json", content: expected });
    expect(second).toEqual(first);
    expect(first.content).not.toContain("activeSession");
    expect(preImportBackupFileName("2026-08-24T01:02:03.004Z")).toBe(
      "focus-lock-pre-import-2026-08-24T01-02-03-004Z.json"
    );
  });

  it("round-trips configuration and provides the visible summary", () => {
    const configuration = defaultConfiguration(1000);
    configuration.lastDurationMinutes = 25;
    configuration.profiles[0].domains.push({ canonicalHost: "example.com", displayHost: "example.com", kind: "domain" });
    const serialized = serializeConfigurationBackup(configuration, 2000);
    const parsed = parseConfigurationBackup(serialized.content);

    expect(parsed.configuration).toEqual(configuration);
    expect(parsed.configuration).not.toBe(configuration);
    expect(parsed.configuration.profiles).not.toBe(configuration.profiles);
    expect(summarizeConfigurationBackup(parsed)).toEqual({
      exportedAt: "1970-01-01T00:00:02.000Z",
      profileCount: 1,
      ruleCount: 1,
      selectedProfileName: "Foco",
      durationMinutes: 25
    });
  });

  it("round-trips a Unicode display host while validating its ASCII canonical host", () => {
    const host = normalizeBlockedHost("例え.テスト");
    expect(host).not.toBeNull();
    const configuration = defaultConfiguration(1000);
    configuration.profiles[0].domains = [host!];

    const parsed = parseConfigurationBackup(serializeConfigurationBackup(configuration, 2000).content);

    expect(parsed.configuration).toEqual(configuration);
  });

  it("enforces the inclusive UTF-8 size limit", () => {
    const prefix = JSON.stringify({ kind: BACKUP_KIND, schemaVersion: 1 });
    const exactlyAtLimit = "x".repeat(MAX_BACKUP_BYTES);
    const oneByteOver = `${"x".repeat(MAX_BACKUP_BYTES - new TextEncoder().encode(prefix).byteLength + 1)}${prefix}`;
    expect(() => parseConfigurationBackup(exactlyAtLimit)).toThrowError(
      new BackupValidationError("INVALID_BACKUP")
    );
    expect(() => parseConfigurationBackup(oneByteOver)).toThrowError(
      new BackupValidationError("BACKUP_TOO_LARGE")
    );
  });

  it("rejects malformed UTF-8 at the file boundary before parsing", async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]).buffer;
    await expect(decodeBackupFile({ size: 2, arrayBuffer: async () => invalidUtf8 })).rejects.toThrowError(
      new BackupValidationError("INVALID_BACKUP")
    );
    const arrayBuffer = vi.fn(async () => invalidUtf8);
    await expect(decodeBackupFile({ size: MAX_BACKUP_BYTES + 1, arrayBuffer })).rejects.toThrowError(
      new BackupValidationError("BACKUP_TOO_LARGE")
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, unsupported versions, and invalid invariants", () => {
    const configuration = defaultConfiguration(1);
    const valid = createBackupEnvelope(configuration, 2);
    const withUnknown = { ...valid, activeSession: {} };
    expect(() => parseConfigurationBackup(JSON.stringify(withUnknown))).toThrowError(
      new BackupValidationError("INVALID_BACKUP")
    );
    expect(() => parseConfigurationBackup(JSON.stringify({ ...valid, schemaVersion: 2 }))).toThrowError(
      new BackupValidationError("UNSUPPORTED_BACKUP_VERSION")
    );
    expect(() => parseConfigurationBackup(JSON.stringify({ ...valid, exportedAt: "2026-01-01" }))).toThrowError(
      new BackupValidationError("INVALID_BACKUP")
    );
    expect(() => parseConfigurationBackup(JSON.stringify({ ...valid, configuration: { ...configuration, profiles: [] } }))).toThrowError(
      new BackupValidationError("INVALID_BACKUP")
    );

    const invalidConfigurations = [
      { ...configuration, lastDurationMinutes: 22 },
      { ...configuration, lastSelectedProfileId: "missing" },
      {
        ...configuration,
        profiles: [
          configuration.profiles[0],
          { ...configuration.profiles[0], id: "other", name: "Ｆｏｃｏ" }
        ]
      },
      {
        ...configuration,
        profiles: [{ ...configuration.profiles[0], updatedAt: 0 }]
      },
      {
        ...configuration,
        profiles: [{ ...configuration.profiles[0], unexpected: true }]
      },
      {
        ...configuration,
        profiles: [{
          ...configuration.profiles[0],
          domains: [{ canonicalHost: "www.example.com", displayHost: "www.example.com", kind: "domain" }]
        }]
      }
    ];
    for (const invalidConfiguration of invalidConfigurations) {
      expect(() => parseConfigurationBackup(JSON.stringify({ ...valid, configuration: invalidConfiguration }))).toThrowError(
        new BackupValidationError("INVALID_BACKUP")
      );
    }
  });
});
