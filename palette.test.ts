import { describe, expect, test } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  childColor,
  contrastRatio,
  relativeLuminance,
  seriesColor,
  seriesPalette,
} from "./palette.shared";

/**
 * These are property tests, not a snapshot of hex strings. A snapshot would go
 * green on a palette that had quietly become unreadable, and would go red on any
 * harmless change to the generator, which is backwards on both counts.
 *
 * The floors below are the contract. Each is stated with why it is that number,
 * and each has margin over what the generator currently measures, so a real
 * regression trips the test and a rounding change does not.
 */

/**
 * WCAG 2.1 SC 1.4.11 (non-text contrast). A chart band is a graphical object
 * that carries meaning, so 3:1 is the applicable minimum — 4.5:1 is the text
 * rule and would force every band toward the extremes of the lightness range,
 * collapsing the hue separation this palette is for. The generator measures a
 * worst case of 3.67:1 across the fixtures here.
 */
const CONTRAST_FLOOR = 3;

/**
 * Hue rotates in even steps of 360/count, so adjacent entries should sit a full
 * step apart. Chroma clipping and 8-bit quantisation move a measured hue by
 * under a degree; 0.9 of the nominal step leaves room for that and still fails
 * if two bands ever land on the same side of the wheel.
 */
const HUE_GAP_FRACTION = 0.9;

/**
 * Perceptual distance in OKLab between neighbours, which is what "tellable
 * apart" actually means — a hue gap alone can still be small if sRGB has run out
 * of chroma in that region. Roughly 0.02 is one just-noticeable difference for
 * large adjacent areas.
 *
 * Two floors, because the count changes what is achievable: grouping by provider
 * gives about five series, grouping by model gives thirteen, and thirteen
 * categorical hues cannot be as separated as five. Measured worst cases are
 * 0.101 at six series and 0.041 at thirteen.
 */
const DELTA_E_FEW = 0.08;
const DELTA_E_MANY = 0.035;
const DELTA_E_FEW_LIMIT = 6;

/** A child keeps its parent's hue; only chroma clipping and 8-bit rounding move it. */
const CHILD_HUE_TOLERANCE = 5;

const LIVE_SERIES_MAX = 13;

function theme(colors: PluginTheme["colors"]): PluginTheme {
  return { colors };
}

/** Paseo's shipped default, and the accent the fallback path lands on. */
const DARK = theme({
  surface0: "#181B1A",
  surface1: "#1E2120",
  surface2: "#272A29",
  border: "#252B2A",
  foreground: "#fafafa",
  foregroundMuted: "#A1A5A4",
  accent: "#20744A",
  accentForeground: "#ffffff",
  statusSuccess: "#35c264",
  statusWarning: "#db932e",
  statusDanger: "#f7796d",
});

const LIGHT = theme({
  surface0: "#ffffff",
  surface1: "#fafafa",
  surface2: "#f4f4f5",
  border: "#e4e4e7",
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  accent: "#20744A",
  accentForeground: "#ffffff",
  statusSuccess: "#299f51",
  statusWarning: "#b37824",
  statusDanger: "#f12e2f",
});

/**
 * plugin-examples/catppuccin, a real installed theme. Its accent is a lilac
 * rather than Paseo's green and its surface2 is much lighter, which is the
 * binding case for the contrast floor.
 */
const MOCHA = theme({
  surface0: "#1e1e2e",
  surface1: "#313244",
  surface2: "#45475a",
  border: "#45475a",
  foreground: "#cdd6f4",
  foregroundMuted: "#a6adc8",
  accent: "#cba6f7",
  accentForeground: "#1e1e2e",
  statusSuccess: "#a6e3a1",
  statusWarning: "#f9e2af",
  statusDanger: "#f38ba8",
});

const FIXTURES: [string, PluginTheme][] = [
  ["dark", DARK],
  ["light", LIGHT],
  ["catppuccin mocha", MOCHA],
];

const HEX = /^#[0-9a-f]{6}$/;

function surfacesOf(host: PluginTheme): string[] {
  return [host.colors.surface0, host.colors.surface1, host.colors.surface2];
}

/**
 * The measuring instruments are derived here from Ottosson's published OKLab
 * matrices rather than borrowed from the module under test, so a mistake in the
 * generator's own colour maths cannot make these assertions pass.
 */
interface Oklab {
  lightness: number;
  greenRed: number;
  blueYellow: number;
}

function oklab(hex: string): Oklab {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  const [red = 0, green = 0, blue = 0] = channels;
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    lightness: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    greenRed: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    blueYellow: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

function hueOf(hex: string): number {
  const lab = oklab(hex);
  const degrees = (Math.atan2(lab.blueYellow, lab.greenRed) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

function hueGap(left: string, right: string): number {
  const raw = Math.abs(hueOf(left) - hueOf(right)) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function deltaEok(left: string, right: string): number {
  const one = oklab(left);
  const two = oklab(right);
  return Math.hypot(
    one.lightness - two.lightness,
    one.greenRed - two.greenRed,
    one.blueYellow - two.blueYellow,
  );
}

function adjacentPairs(palette: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 1; index < palette.length; index += 1) {
    const previous = palette[index - 1];
    const current = palette[index];
    if (previous !== undefined && current !== undefined) pairs.push([previous, current]);
  }
  return pairs;
}

function lowestSurfaceContrast(color: string, host: PluginTheme): number {
  return Math.min(...surfacesOf(host).map((surface) => contrastRatio(color, surface)));
}

const COUNTS = Array.from({ length: LIVE_SERIES_MAX - 1 }, (_, index) => index + 2);

describe("contrastRatio", () => {
  test("black against white is the WCAG maximum of 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  test("is symmetric", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is 1:1", () => {
    for (const color of ["#000000", "#ffffff", "#20744a", "#cba6f7", "#767676"]) {
      expect(contrastRatio(color, color)).toBeCloseTo(1, 10);
    }
  });

  test("matches WCAG's published boundary pairs", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#949494", "#ffffff")).toBeCloseTo(3.0, 1);
    expect(contrastRatio("#595959", "#ffffff")).toBeCloseTo(7.0, 1);
  });

  test("reads an unparseable colour as black rather than throwing", () => {
    expect(contrastRatio("accent", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("relativeLuminance", () => {
  test("spans 0 for black to 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  test("matches the sRGB luminance of mid grey", () => {
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 4);
  });

  test("weights the primaries the way WCAG does", () => {
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  test("expands short hex the way CSS does", () => {
    expect(relativeLuminance("#fff")).toBe(relativeLuminance("#ffffff"));
    expect(relativeLuminance("#f00")).toBe(relativeLuminance("#ff0000"));
  });

  test("ignores the alpha byte of an 8-digit hex", () => {
    expect(relativeLuminance("#20744a80")).toBe(relativeLuminance("#20744a"));
  });

  test("returns 0 for anything unparseable", () => {
    for (const value of ["", "accent", "not-a-colour", "#12345", "rgb(1,2,3)"]) {
      expect(relativeLuminance(value)).toBe(0);
    }
  });
});

describe("seriesPalette", () => {
  test.each(FIXTURES)("%s returns exactly the requested count", (_name, host) => {
    for (const count of COUNTS) {
      expect(seriesPalette(host, count)).toHaveLength(count);
    }
  });

  test.each(FIXTURES)("%s returns lowercase six-digit hex", (_name, host) => {
    for (const color of seriesPalette(host, LIVE_SERIES_MAX)) {
      expect(color).toMatch(HEX);
    }
  });

  test.each(FIXTURES)("%s never repeats a colour", (_name, host) => {
    for (const count of COUNTS) {
      const palette = seriesPalette(host, count);
      expect(new Set(palette).size).toBe(count);
    }
  });

  test.each(FIXTURES)("%s clears 3:1 against all three surfaces", (_name, host) => {
    for (const count of COUNTS) {
      for (const color of seriesPalette(host, count)) {
        expect(lowestSurfaceContrast(color, host)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      }
    }
  });

  test.each(FIXTURES)("%s separates neighbours by a full hue step", (_name, host) => {
    for (const count of COUNTS) {
      const floor = (360 / count) * HUE_GAP_FRACTION;
      for (const [left, right] of adjacentPairs(seriesPalette(host, count))) {
        expect(hueGap(left, right)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  test.each(FIXTURES)("%s keeps neighbours perceptually apart", (_name, host) => {
    for (const count of COUNTS) {
      const floor = count <= DELTA_E_FEW_LIMIT ? DELTA_E_FEW : DELTA_E_MANY;
      for (const [left, right] of adjacentPairs(seriesPalette(host, count))) {
        expect(deltaEok(left, right)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  test.each(FIXTURES)("%s holds one lightness across the whole set", (_name, host) => {
    const lightnesses = seriesPalette(host, LIVE_SERIES_MAX).map((color) => oklab(color).lightness);
    const spread = Math.max(...lightnesses) - Math.min(...lightnesses);
    expect(spread).toBeLessThan(0.02);
  });

  test.each(FIXTURES)("%s is deterministic and order-stable", (_name, host) => {
    for (const count of COUNTS) {
      expect(seriesPalette(host, count)).toEqual(seriesPalette(host, count));
      expect(seriesPalette(theme({ ...host.colors }), count)).toEqual(seriesPalette(host, count));
    }
  });

  test("starts on the accent's own hue", () => {
    for (const [, host] of FIXTURES) {
      const first = seriesPalette(host, 5)[0] ?? "";
      expect(hueGap(first, host.colors.accent)).toBeLessThan(CHILD_HUE_TOLERANCE);
    }
  });

  test("gives different themes different palettes", () => {
    expect(seriesPalette(DARK, 5)).not.toEqual(seriesPalette(MOCHA, 5));
    expect(seriesPalette(DARK, 5)).not.toEqual(seriesPalette(LIGHT, 5));
  });

  test("moves the whole set when only the accent changes", () => {
    const shifted = theme({ ...DARK.colors, accent: "#3b6fcf" });
    expect(seriesPalette(shifted, 5)).not.toEqual(seriesPalette(DARK, 5));
    expect(seriesPalette(shifted, 5)).toHaveLength(5);
  });

  test("degrades to a usable set when the accent is malformed", () => {
    for (const accent of ["", "not-a-colour", "accent", "#12345", "#1234567", "rgb(0,0,0)"]) {
      const host = theme({ ...DARK.colors, accent });
      const palette = seriesPalette(host, 5);
      expect(palette).toHaveLength(5);
      expect(new Set(palette).size).toBe(5);
      for (const color of palette) {
        expect(color).toMatch(HEX);
        expect(lowestSurfaceContrast(color, host)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      }
    }
  });

  test("honours a three-digit accent rather than discarding it", () => {
    const short = theme({ ...DARK.colors, accent: "#abc" });
    expect(seriesPalette(short, 5)).toEqual(
      seriesPalette(theme({ ...DARK.colors, accent: "#aabbcc" }), 5),
    );
    expect(seriesPalette(short, 5)).not.toEqual(seriesPalette(DARK, 5));
  });

  test("survives a theme whose colours are token names, not hex", () => {
    const tokens = theme({
      surface0: "surface0",
      surface1: "surface1",
      surface2: "surface2",
      border: "border",
      foreground: "foreground",
      foregroundMuted: "foregroundMuted",
      accent: "accent",
      accentForeground: "accentForeground",
      statusSuccess: "statusSuccess",
      statusWarning: "statusWarning",
      statusDanger: "statusDanger",
    });
    const palette = seriesPalette(tokens, 5);
    expect(palette).toHaveLength(5);
    expect(new Set(palette).size).toBe(5);
    for (const color of palette) expect(color).toMatch(HEX);
    expect(palette).toEqual(seriesPalette(DARK, 5));
  });

  test("returns one colour for a count that is not a usable series count", () => {
    for (const count of [0, 1, -4, 1.7, Number.NaN]) {
      const palette = seriesPalette(DARK, count);
      expect(palette).toHaveLength(1);
      expect(palette[0]).toMatch(HEX);
    }
  });
});

describe("seriesColor", () => {
  test.each(FIXTURES)("%s agrees with the palette at every index", (_name, host) => {
    for (const count of COUNTS) {
      const palette = seriesPalette(host, count);
      palette.forEach((color, index) => {
        expect(seriesColor(host, index, count)).toBe(color);
      });
    }
  });

  test("clamps an index past the end onto the last entry", () => {
    const palette = seriesPalette(DARK, 5);
    expect(seriesColor(DARK, 5, 5)).toBe(palette[4]);
    expect(seriesColor(DARK, 99, 5)).toBe(palette[4]);
  });

  test("clamps a negative or unusable index onto the first entry", () => {
    const palette = seriesPalette(DARK, 5);
    expect(seriesColor(DARK, -1, 5)).toBe(palette[0]);
    expect(seriesColor(DARK, Number.NaN, 5)).toBe(palette[0]);
  });
});

describe("childColor", () => {
  test.each(FIXTURES)("%s keeps every child on its parent's hue", (_name, host) => {
    for (const parent of seriesPalette(host, 5)) {
      for (let count = 1; count <= 6; count += 1) {
        for (let index = 0; index < count; index += 1) {
          expect(hueGap(childColor(parent, index, count), parent)).toBeLessThan(
            CHILD_HUE_TOLERANCE,
          );
        }
      }
    }
  });

  test.each(FIXTURES)("%s moves lightness monotonically across children", (_name, host) => {
    for (const parent of seriesPalette(host, 5)) {
      for (let count = 2; count <= 6; count += 1) {
        const steps = Array.from(
          { length: count },
          (_, index) => oklab(childColor(parent, index, count)).lightness,
        );
        const rising = (steps.at(-1) ?? 0) > (steps[0] ?? 0);
        for (let index = 1; index < steps.length; index += 1) {
          const gap = (steps[index] ?? 0) - (steps[index - 1] ?? 0);
          expect(rising ? gap : -gap).toBeGreaterThan(0);
        }
      }
    }
  });

  test.each(FIXTURES)("%s keeps every child above the contrast floor", (_name, host) => {
    for (const parent of seriesPalette(host, 5)) {
      for (let count = 1; count <= 8; count += 1) {
        for (let index = 0; index < count; index += 1) {
          const child = childColor(parent, index, count);
          expect(lowestSurfaceContrast(child, host)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
        }
      }
    }
  });

  test.each(FIXTURES)("%s never repeats a child, and never reuses the parent", (_name, host) => {
    for (const parent of seriesPalette(host, 5)) {
      for (let count = 2; count <= 8; count += 1) {
        const children = Array.from({ length: count }, (_, index) =>
          childColor(parent, index, count),
        );
        expect(new Set(children).size).toBe(count);
        expect(children).not.toContain(parent);
      }
    }
  });

  test("is deterministic", () => {
    expect(childColor("#44c684", 2, 4)).toBe(childColor("#44c684", 2, 4));
  });

  test("returns lowercase six-digit hex", () => {
    for (let index = 0; index < 4; index += 1) {
      expect(childColor("#44c684", index, 4)).toMatch(HEX);
    }
  });

  test("collapses to a single offset colour for one child", () => {
    const only = childColor("#44c684", 0, 1);
    expect(only).toMatch(HEX);
    expect(only).not.toBe("#44c684");
  });

  test("clamps an out-of-range index onto the ends of the band", () => {
    const children = [0, 1, 2, 3].map((index) => childColor("#44c684", index, 4));
    expect(childColor("#44c684", 9, 4)).toBe(children[3]);
    expect(childColor("#44c684", -2, 4)).toBe(children[0]);
    expect(childColor("#44c684", Number.NaN, 4)).toBe(children[0]);
  });

  test("degrades to the fallback family when the parent is malformed", () => {
    for (const parent of ["", "parentColor", "#12345"]) {
      const children = [0, 1, 2].map((index) => childColor(parent, index, 3));
      expect(new Set(children).size).toBe(3);
      for (const child of children) expect(child).toMatch(HEX);
    }
  });

  test("spreads the other way when the parent has no room left", () => {
    for (const parent of ["#ffffff", "#000000"]) {
      const children = [0, 1, 2, 3].map((index) => childColor(parent, index, 4));
      expect(new Set(children).size).toBe(4);
    }
  });
});
