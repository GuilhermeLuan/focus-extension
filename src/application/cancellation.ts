export type CancelSessionPresentation =
  | { canCancel: true; label: "Cancelar sessão" }
  | { canCancel: false };

export function getCancelSessionPresentation(
  session: Pick<{ startedAt: number; cancelAllowedUntil: number }, "startedAt" | "cancelAllowedUntil">,
  now: number
): CancelSessionPresentation {
  return now < session.cancelAllowedUntil
    ? { canCancel: true, label: "Cancelar sessão" }
    : { canCancel: false };
}

export const isSessionCancelable = (
  session: Pick<{ cancelAllowedUntil: number }, "cancelAllowedUntil">,
  now: number
): boolean => now < session.cancelAllowedUntil;
