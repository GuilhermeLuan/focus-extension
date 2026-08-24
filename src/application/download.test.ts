import { describe, expect, it, vi } from "vitest";
import { downloadJsonFile } from "../../entrypoints/options/download";

describe("downloadJsonFile", () => {
  it("creates a local JSON link and revokes it after clicking", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const createElement = vi.fn(() => ({
      href: "",
      download: "",
      style: {},
      click,
      remove
    }));
    const originalDocument = globalThis.document;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement, body: { appendChild } } });
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    try {
      downloadJsonFile("focus-lock-backup-2026-01-01.json", "{}\n");
      const link = createElement.mock.results[0]?.value;
      expect(link).toMatchObject({ href: "blob:test", download: "focus-lock-backup-2026-01-01.json" });
      expect(appendChild).toHaveBeenCalledWith(link);
      expect(click).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
