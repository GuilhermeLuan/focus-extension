export function normalizeHostname(input: string): string | null {
  const candidate = input.trim().toLowerCase();
  const withoutTrailingDot = candidate.endsWith(".")
    ? candidate.slice(0, -1)
    : candidate;
  const normalized = withoutTrailingDot.startsWith("www.")
    ? withoutTrailingDot.slice(4)
    : withoutTrailingDot;

  if (!normalized || normalized.split(".").length < 2 || normalized.split(".").some((label) => !label)) {
    return null;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || normalized.includes("[")) {
    return null;
  }

  try {
    const parsed = new URL(`https://${normalized}`);
    if (parsed.hostname !== normalized) return null;
  } catch {
    return null;
  }

  return normalized;
}

export function matchesHostname(requestHostname: string, configuredHostname: string): boolean {
  const request = requestHostname.trim().toLowerCase().replace(/\.$/, "");
  const configured = configuredHostname.trim().toLowerCase().replace(/\.$/, "");
  return request === configured || request.endsWith(`.${configured}`);
}
