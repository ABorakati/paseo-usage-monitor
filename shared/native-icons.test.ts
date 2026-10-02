import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USAGE_PRESETS } from "./presets.shared";
import { NATIVE_USAGE_FALLBACK_ICON, NATIVE_USAGE_ICONS } from "./native-icons.shared";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hrefPattern = /\s(?:href|xlink:href)\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi;

function assertLoaderSafeIcon(iconPath: string): void {
  const filePath = join(pluginRoot, iconPath);
  expect(existsSync(filePath), `${iconPath} exists`).toBe(true);
  expect(statSync(filePath).isFile(), `${iconPath} is a file`).toBe(true);
  expect(statSync(filePath).size, `${iconPath} is at most 64 KiB`).toBeLessThanOrEqual(64 * 1024);

  const svg = readFileSync(filePath, "utf8");
  expect(svg).toMatch(/^\s*<svg(?:\s|>)/i);
  expect(svg).not.toMatch(/<script(?:\s|>)/i);
  expect(svg).not.toMatch(/<foreignObject(?:\s|>)/i);
  expect(svg).not.toMatch(/<style(?:\s|>)/i);
  expect(svg).not.toMatch(/\son[a-z0-9_-]*\s*=/i);
  expect(svg).not.toMatch(/javascript\s*:/i);

  for (const match of svg.matchAll(hrefPattern)) {
    const href = match[2] ?? match[3] ?? "";
    expect(href.startsWith("#"), `${iconPath} has only local hrefs`).toBe(true);
  }
}

describe("native usage icons", () => {
  it("maps only real usage presets to loader-safe SVG files", () => {
    for (const [presetId, iconPath] of Object.entries(NATIVE_USAGE_ICONS)) {
      expect(Object.hasOwn(USAGE_PRESETS, presetId), `${presetId} is a usage preset`).toBe(true);
      assertLoaderSafeIcon(iconPath);
    }
  });

  it("provides a loader-safe fallback icon", () => {
    assertLoaderSafeIcon(NATIVE_USAGE_FALLBACK_ICON);
  });
});
