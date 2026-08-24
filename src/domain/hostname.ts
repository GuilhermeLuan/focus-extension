import { parse as parseTld } from "tldts";
import type { BlockedHost, BlockedHostKind } from "./types";

/** Hosts that must remain reachable for Firefox account and add-on operation. */
export const PROTECTED_HOSTS = [
  "accounts-static.cdn.mozilla.net",
  "accounts.firefox.com",
  "addons.cdn.mozilla.net",
  "addons.mozilla.org",
  "api.accounts.firefox.com",
  "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com"
] as const;

const PROTECTED_HOST_SET = new Set<string>(PROTECTED_HOSTS);

function isExplicitScheme(input: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

function isProtectedHost(host: string): boolean {
  if (PROTECTED_HOST_SET.has(host)) return true;
  return PROTECTED_HOSTS.some(
    (protectedHost) => host.endsWith(`.${protectedHost}`) || protectedHost.endsWith(`.${host}`)
  );
}

function toDisplayHost(input: string, canonicalHost: string): string {
  const noScheme = input.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  const authority = noScheme.split(/[/?#]/, 1)[0] ?? "";
  const withoutCredentials = authority.slice(authority.lastIndexOf("@") + 1);
  const withoutPort = withoutCredentials.startsWith("[")
    ? withoutCredentials.slice(0, withoutCredentials.indexOf("]") + 1)
    : withoutCredentials.replace(/:\d+$/, "");
  const display = withoutPort
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .replace(/^www\./i, "")
    .toLocaleLowerCase();

  // The user-facing form may be Unicode (IDNA) but must represent exactly the
  // same parsed host. URL is the authority for the comparison.
  try {
    const parsed = new URL(`https://${withoutPort}`);
    const parsedHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (parsedHost === canonicalHost || parsedHost === withoutPort.toLowerCase().replace(/^\[|\]$/g, "")) {
      return display || canonicalHost;
    }
  } catch {
    // The caller already validated the input; falling back is defensive only.
  }
  return canonicalHost;
}

function parseInput(input: string): { url: URL; rawHost: string } | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (isExplicitScheme(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;

  let candidate = trimmed;
  // A bare IPv6 literal needs brackets when it is turned into a URL.
  if (!isExplicitScheme(candidate) && candidate.includes(":") && !candidate.startsWith("[")) {
    candidate = `[${candidate}]`;
  }
  try {
    const url = new URL(isExplicitScheme(candidate) ? candidate : `https://${candidate}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const rawHost = url.hostname.replace(/^\[|\]$/g, "");
    if (!rawHost) return null;
    return { url, rawHost };
  } catch {
    return null;
  }
}

function classifyHost(canonicalHost: string): BlockedHostKind | null {
  if (canonicalHost === "localhost") return "localhost";
  const parsed = parseTld(canonicalHost);
  const isIp = parsed.isIp || (canonicalHost.includes(":") && parseTld(`[${canonicalHost}]`).isIp);
  if (isIp) {
    return canonicalHost.includes(":") ? "ipv6" : "ipv4";
  }
  const labels = canonicalHost.split(".");
  if (
    canonicalHost.length > 253 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    return null;
  }
  if (!parsed.domain) return null;
  return "domain";
}

/** Distinguish a Firefox protected host from other malformed input at API boundaries. */
export function isProtectedHostInput(input: string): boolean {
  const parsedInput = parseInput(input);
  if (!parsedInput) return false;
  let canonicalHost = parsedInput.rawHost.toLowerCase().replace(/\.$/, "");
  if (canonicalHost.startsWith("www.")) canonicalHost = canonicalHost.slice(4);
  return isProtectedHost(canonicalHost);
}

/**
 * Normalize a hostname or complete HTTP(S) URL into the persisted rule form.
 * Invalid or protected inputs return null and never throw.
 */
export function normalizeBlockedHost(input: string): BlockedHost | null {
  const parsedInput = parseInput(input);
  if (!parsedInput) return null;

  let canonicalHost = parsedInput.rawHost.toLowerCase().replace(/\.$/, "");
  if (canonicalHost.startsWith("www.")) canonicalHost = canonicalHost.slice(4);
  if (!canonicalHost) return null;

  const kind = classifyHost(canonicalHost);
  if (!kind || isProtectedHost(canonicalHost)) return null;

  return {
    canonicalHost,
    displayHost: toDisplayHost(input.trim(), canonicalHost),
    kind
  };
}

/** Compatibility alias retained for the basic Pomodoro API. */
export function normalizeHostname(input: string): string | null {
  const normalized = normalizeBlockedHost(input);
  return normalized?.kind === "domain" ? normalized.canonicalHost : null;
}

function canonicalRequestHost(input: string): { host: string; kind: BlockedHostKind } | null {
  const normalized = normalizeBlockedHost(input);
  return normalized ? { host: normalized.canonicalHost, kind: normalized.kind } : null;
}

/** Match domain rules by label suffix and IP/localhost rules by exact equality. */
export function matchesBlockedHost(requestHost: string, configuredHost: BlockedHost | string): boolean {
  const request = canonicalRequestHost(requestHost);
  if (!request) return false;
  const configured = typeof configuredHost === "string" ? normalizeBlockedHost(configuredHost) : configuredHost;
  if (!configured || configured.kind !== request.kind) return false;
  if (configured.kind !== "domain") return request.host === configured.canonicalHost;
  return (
    request.host === configured.canonicalHost ||
    request.host.endsWith(`.${configured.canonicalHost}`)
  );
}

/** Compatibility alias retained for the basic Pomodoro API. */
export function matchesHostname(requestHostname: string, configuredHostname: string): boolean {
  const configured = normalizeBlockedHost(configuredHostname);
  return configured ? matchesBlockedHost(requestHostname, configured) : false;
}

export type BlockedHostInsertion =
  | { type: "invalid"; error: "INVALID_HOSTNAME" | "PROTECTED_HOSTNAME" }
  | { type: "covered"; candidate: BlockedHost; existing: BlockedHost }
  | { type: "confirm"; candidate: BlockedHost; removedHosts: BlockedHost[] }
  | { type: "add"; candidate: BlockedHost; removedHosts: BlockedHost[] };

function covers(existing: BlockedHost, candidate: BlockedHost): boolean {
  if (existing.kind !== candidate.kind) return false;
  if (existing.kind !== "domain") return existing.canonicalHost === candidate.canonicalHost;
  return (
    candidate.canonicalHost === existing.canonicalHost ||
    candidate.canonicalHost.endsWith(`.${existing.canonicalHost}`)
  );
}

/** Analyze a candidate without mutating the profile or storage. */
export function analyzeBlockedHostInsertion(
  input: string | BlockedHost,
  existingHosts: readonly BlockedHost[],
  confirmConsolidation = false
): BlockedHostInsertion {
  const candidate = typeof input === "string" ? normalizeBlockedHost(input) : input;
  if (!candidate) {
    return {
      type: "invalid",
      error: typeof input === "string" && isProtectedHostInput(input) ? "PROTECTED_HOSTNAME" : "INVALID_HOSTNAME"
    };
  }

  const existing = existingHosts.find((host) => covers(host, candidate));
  if (existing) return { type: "covered", candidate, existing };

  const removedHosts = existingHosts.filter((host) => covers(candidate, host));
  if (!removedHosts.length) return { type: "add", candidate, removedHosts: [] };
  if (!confirmConsolidation) return { type: "confirm", candidate, removedHosts };
  return { type: "add", candidate, removedHosts };
}

// Short aliases make the pure seam convenient to consume from tests and UI.
export const analyzeHostInsertion = analyzeBlockedHostInsertion;
export const analyzeBlockedHost = analyzeBlockedHostInsertion;
