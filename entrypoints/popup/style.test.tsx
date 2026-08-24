import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../src/presentation/tokens.css", import.meta.url), "utf8");

function tokenValue(name: string, block: string): string {
  const value = block.match(new RegExp(`${name.replaceAll("-", "\\-")}\\s*:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) throw new Error(`Missing token ${name}`);
  return value;
}

function hexRgb(value: string): [number, number, number] {
  const match = value.match(/^#([\da-f]{6})$/i);
  if (!match) throw new Error(`Expected opaque six-digit token, got ${value}`);
  return [0, 1, 2].map((offset) => Number.parseInt(match[1].slice(offset * 2, offset * 2 + 2), 16) / 255) as [number, number, number];
}

function luminance(value: string): number {
  return hexRgb(value).reduce((total, channel, index) => {
    const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("popup layout and presentation tokens", () => {
  it("locks the extension viewport and prevents scroll in every popup container", () => {
    expect(style).toMatch(/html,\s*\nbody,\s*\n#root\s*\{[^}]*width:\s*370px;[^}]*height:\s*520px;/s);
    expect(style).toMatch(/html,\s*\nbody\s*\{[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/\.popup\s*\{[^}]*height:\s*520px;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/\.active,\s*\n\.confirmation\s*\{[^}]*overflow:\s*hidden;/s);
  });

  it("keeps the active timer tabular and width-stable", () => {
    expect(style).toMatch(/\.remaining\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*min-width:\s*8ch;/s);
    expect(style).toMatch(/\.summary-end\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s);
  });

  it("compacts secondary active-session copy when an error recovery panel is present", () => {
    expect(style).toMatch(
      /\.active\.has-error \.active-kicker,[\s\S]*?\.active\.has-error \.active-read-only,[\s\S]*?\.active\.has-error \.protected-note\s*\{[^}]*display:\s*none;/
    );
  });

  it("defines semantic light/dark tokens with WCAG AA text, control, and focus contrast", () => {
    const light = tokens.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
    const dark = tokens.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/)?.[1];
    if (!light || !dark) throw new Error("Missing light or dark token theme");

    for (const theme of [light, dark]) {
      const surface = tokenValue("--color-surface", theme);
      const raised = tokenValue("--color-surface-raised", theme);
      const text = tokenValue("--color-text", theme);
      const muted = tokenValue("--color-text-muted", theme);
      const action = tokenValue("--color-action", theme);
      const border = tokenValue("--color-border", theme);
      const focus = tokenValue("--color-focus", theme);
      const danger = tokenValue("--color-danger", theme);
      const dangerContrast = tokenValue("--color-danger-contrast", theme);
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(action, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(border, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(border, raised)).toBeGreaterThanOrEqual(3);
      expect(contrast(focus, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(focus, raised)).toBeGreaterThanOrEqual(3);
      expect(contrast(dangerContrast, danger)).toBeGreaterThanOrEqual(4.5);
    }
    expect(style).toMatch(/button:focus-visible,[\s\S]*?select:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--color-focus\);/);
    expect(tokens).toMatch(/--focus-width:\s*3px;/);
  });

  it("removes hold easing when reduced motion is requested", () => {
    expect(style).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.hold-progress\s*\{[^}]*transition:\s*none;/);
    expect(tokens).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--motion-decorative:\s*0ms;/);
  });
});
