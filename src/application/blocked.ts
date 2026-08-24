export type BlockedPageModel = { status: "blocked" } | { status: "released" };

export function createBlockedPageModel(
  capturedSessionId: string | undefined,
  activeSession: { id: string } | undefined
): BlockedPageModel {
  return capturedSessionId && activeSession?.id === capturedSessionId
    ? { status: "blocked" }
    : { status: "released" };
}

export function getSafeDestination(destination: string | undefined): string | undefined {
  if (!destination) return undefined;
  try {
    const parsed = new URL(destination);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? destination : undefined;
  } catch {
    return undefined;
  }
}
