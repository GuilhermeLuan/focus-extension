import { describe, expect, it } from "vitest";
import { getCancelSessionPresentation } from "./cancellation";

describe("cancel session presentation", () => {
  const session = { startedAt: 1_000, cancelAllowedUntil: 61_000 };

  it("keeps cancellation available strictly before the boundary", () => {
    expect(getCancelSessionPresentation(session, 60_999)).toEqual({
      canCancel: true,
      label: "Cancelar sessão"
    });
  });

  it("hides cancellation at the boundary and afterwards", () => {
    expect(getCancelSessionPresentation(session, 61_000)).toEqual({ canCancel: false });
    expect(getCancelSessionPresentation(session, 61_001)).toEqual({ canCancel: false });
  });
});
