import { matchesBlockedHost } from "../domain/hostname";
import type { ActiveSession } from "../domain/types";

export type NavigationRequest = {
  url: string;
  type: string;
};

export type NavigationDecision =
  | { type: "allow" }
  | { type: "redirect"; redirectUrl: string };

export function decideNavigation(
  request: NavigationRequest,
  session: ActiveSession | undefined,
  blockedPageUrl: string
): NavigationDecision {
  if (request.type !== "main_frame" || !session) return { type: "allow" };

  try {
    const destination = new URL(request.url);
    if (destination.protocol !== "http:" && destination.protocol !== "https:") {
      return { type: "allow" };
    }
    if (!session.profileSnapshot.domains.some((blockedHost) => matchesBlockedHost(destination.hostname, blockedHost))) {
      return { type: "allow" };
    }

    const redirect = new URL(blockedPageUrl);
    redirect.search = "";
    redirect.searchParams.set("hostname", destination.hostname);
    redirect.searchParams.set("sessionId", session.id);
    redirect.searchParams.set("destination", request.url);
    return { type: "redirect", redirectUrl: redirect.toString() };
  } catch {
    return { type: "allow" };
  }
}

export class NavigationGuard {
  public constructor(
    private readonly readState: () => Promise<{ activeSession?: ActiveSession }>,
    private readonly blockedPageUrl: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  public async decide(request: NavigationRequest): Promise<NavigationDecision> {
    try {
      const state = await this.readState();
      const activeSession = state.activeSession && state.activeSession.endsAt > this.now()
        ? state.activeSession
        : undefined;
      return decideNavigation(request, activeSession, this.blockedPageUrl);
    } catch {
      return { type: "allow" };
    }
  }
}
