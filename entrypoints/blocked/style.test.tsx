import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("blocked page presentation", () => {
  it("uses the shared moss tokens and keeps long hostnames inside the composition", () => {
    expect(style).toContain('@import "../../src/presentation/tokens.css";');
    expect(style).toMatch(/h1\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(style).toMatch(/\.return\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(style).toMatch(/\.blocked-page\s*\{[^}]*padding:/s);
  });

  it("reserves tabular timer geometry and exposes a visible keyboard focus", () => {
    expect(style).toMatch(/\.remaining\s*\{[^}]*min-inline-size:\s*8ch;[^}]*font-variant-numeric:\s*tabular-nums;/s);
    expect(style).toMatch(/button:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--color-focus\);/s);
  });

  it("keeps the botanical decoration motion-free when reduced motion is requested", () => {
    expect(style).toMatch(/\.botanical-line\s*\{[^}]*transition:\s*[^;]+var\(--motion-decorative\)/s);
    expect(style).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.botanical-line,[\s\S]*?transition:\s*none;/s);
  });
});
