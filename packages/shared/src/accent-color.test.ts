import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESET_IDS,
  ACCENT_PRESETS,
  contrastRatio,
  deriveDarkAccent,
  normalizeAccentColor,
  normalizeAccentPresetId,
  resolveAccentColor,
} from "./accent-color.js";

describe("accent colour", () => {
  it("normalizes presets and custom hex, rejecting everything else", () => {
    expect(normalizeAccentColor("blue")).toBe("blue");
    expect(normalizeAccentColor(" Teal ")).toBe("teal");
    expect(normalizeAccentColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizeAccentColor("#abc")).toBeUndefined();
    expect(normalizeAccentColor("red")).toBeUndefined();
    expect(normalizeAccentColor("url(x)")).toBeUndefined();
    expect(normalizeAccentColor(undefined)).toBeUndefined();
    expect(normalizeAccentColor(12)).toBeUndefined();
  });

  it("accepts only preset ids for per-project colours", () => {
    expect(normalizeAccentPresetId("rose")).toBe("rose");
    expect(normalizeAccentPresetId("#aabbcc")).toBeUndefined();
  });

  it("falls back to blue when absent or invalid", () => {
    expect(resolveAccentColor(undefined)).toEqual(resolveAccentColor("blue"));
    expect(resolveAccentColor("nope").light).toBe(ACCENT_PRESETS.blue.light);
  });

  it("resolves preset light/dark values", () => {
    const resolved = resolveAccentColor("graphite");
    expect(resolved.light).toBe("#3c3f44");
    expect(resolved.dark).toBe("#c9cbd0");
  });

  it("keeps a readable on-colour for every preset in both themes", () => {
    for (const id of ACCENT_PRESET_IDS) {
      const resolved = resolveAccentColor(id);
      expect(contrastRatio(resolved.light, resolved.onLight)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(resolved.dark, resolved.onDark)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives a dark variant that reads on the dark surface", () => {
    for (const hex of ["#000000", "#102a66", "#6d4ad8", "#ff0000", "#ffffff"]) {
      const resolved = resolveAccentColor(hex);
      expect(resolved.light).toBe(hex);
      expect(contrastRatio(resolved.dark, "#181818")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(resolved.dark, resolved.onDark)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, resolved.onLight)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves an already light custom colour unchanged in dark", () => {
    expect(deriveDarkAccent("#c9cbd0")).toBe("#c9cbd0");
  });
});
