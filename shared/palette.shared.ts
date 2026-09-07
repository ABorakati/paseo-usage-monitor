import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Categorical colours for the usage chart, derived from the theme.
 *
 * `PluginTheme` carries one accent and no categorical palette, so a chart with
 * five providers has nothing to paint them with. Reusing the accent at falling
 * opacity — the shape this replaced — makes adjacent bands differ only in how
 * washed out they are, and the faintest band disappears into its surface.
 *
 * So the set is generated: hue rotates evenly around the accent's own hue while
 * lightness and chroma stay in one band. Rotating hue keeps the accent as the
 * first series, which means a theme switch moves the whole set together instead
 * of replacing it with unrelated colours.
 *
 * The maths runs in OKLCH rather than HSL. HSL's lightness is not perceived
 * lightness: at a fixed HSL lightness, yellow reads far brighter than blue, so
 * a fixed-lightness rotation produces a set that looks uneven, and the greens
 * (where sRGB has the most room) collapse into each other. OKLCH lightness is
 * perceptual, so one lightness for every hue actually looks like one lightness.
 *
 * Hue carries category and lightness carries nesting, and neither borrows the
 * other's axis. Zig-zagging lightness across the top level would separate
 * neighbouring bands better at eleven or more series, but it would also make a
 * dim provider band look like a bright neighbour's model — which is exactly what
 * `childColor` means by moving lightness. So the top level rotates hue only, and
 * a thirteen-series set accepts a 27-degree step as the price of keeping the two
 * signals separate.
 *
 * The contrast floor is 3:1, WCAG 2.1 SC 1.4.11 (non-text contrast): a chart
 * band is a graphical object carrying meaning, not text. Every colour clears it
 * against all three surfaces, not just the one it happens to sit on, because a
 * legend swatch and a bar sit on different surfaces in the same view.
 */

const CONTRAST_FLOOR = 3;

/**
 * Bright bands on dark surfaces, dark bands on light ones. Lightness sits far
 * enough from 0.5 that `childColor` can tell which way has contrast room.
 */
const DARK_BAND = { lightness: 0.74, chroma: 0.15 };
const LIGHT_BAND = { lightness: 0.47, chroma: 0.16 };

/** Below this mean surface luminance the theme is treated as dark. */
const DARK_SURFACE_LUMINANCE = 0.25;

const CONTRAST_STEP = 0.02;
const CONTRAST_STEPS = 20;
const LIGHTNESS_MIN = 0.12;
const LIGHTNESS_MAX = 0.96;

const CHILD_LIGHTNESS_MIN = 0.26;
const CHILD_LIGHTNESS_MAX = 0.9;
const CHILD_OFFSET_MIN = 0.05;
const CHILD_OFFSET_MAX = 0.28;

/** Paseo's own accent, used when a theme hands over something unparseable. */
const FALLBACK_ACCENT: RgbColor = { red: 0x20, green: 0x74, blue: 0x4a };

const PALETTE_CACHE_LIMIT = 64;
const paletteCache = new Map<string, string[]>();

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

interface LinearRgb {
  red: number;
  green: number;
  blue: number;
}

interface OklchColor {
  lightness: number;
  chroma: number;
  hue: number;
}

interface SurfaceContext {
  surfaces: string[];
  dark: boolean;
}

interface LightnessBand {
  start: number;
  end: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function normalizeHue(hue: number): number {
  const wrapped = hue % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Themes may contribute 3-, 4-, 6- or 8-digit hex; alpha plays no part here. */
function rgbDigits(digits: string): string | null {
  if (digits.length === 6 || digits.length === 8) return digits.slice(0, 6);
  if (digits.length !== 3 && digits.length !== 4) return null;
  let expanded = "";
  for (const digit of digits.slice(0, 3)) expanded += `${digit}${digit}`;
  return expanded;
}

function parseHexColor(value: string): RgbColor | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("#")) return null;
  const digits = trimmed.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  const rgb = rgbDigits(digits);
  if (rgb === null) return null;
  return {
    red: Number.parseInt(rgb.slice(0, 2), 16),
    green: Number.parseInt(rgb.slice(2, 4), 16),
    blue: Number.parseInt(rgb.slice(4, 6), 16),
  };
}

function channelHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function formatHex(color: RgbColor): string {
  return `#${channelHex(color.red)}${channelHex(color.green)}${channelHex(color.blue)}`;
}

function linearSrgbChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function srgbChannel(value: number): number {
  const channel = clamp(value, 0, 1);
  const encoded =
    channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return encoded * 255;
}

/**
 * WCAG 2.1 relative luminance. Unparseable input reads as black rather than
 * throwing, so a theme that hands over a token name still renders.
 */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (rgb === null) return 0;
  return (
    0.2126 * linearSrgbChannel(rgb.red) +
    0.7152 * linearSrgbChannel(rgb.green) +
    0.0722 * linearSrgbChannel(rgb.blue)
  );
}

/** WCAG 2.1 contrast ratio, 1:1 for a colour against itself and 21:1 for black on white. */
export function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToOklch(color: RgbColor): OklchColor {
  const red = linearSrgbChannel(color.red);
  const green = linearSrgbChannel(color.green);
  const blue = linearSrgbChannel(color.blue);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const greenRed = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const blueYellow = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  return {
    lightness,
    chroma: Math.hypot(greenRed, blueYellow),
    hue: normalizeHue((Math.atan2(blueYellow, greenRed) * 180) / Math.PI),
  };
}

function oklchToLinear(color: OklchColor): LinearRgb {
  const radians = (color.hue * Math.PI) / 180;
  const greenRed = Math.cos(radians) * color.chroma;
  const blueYellow = Math.sin(radians) * color.chroma;
  const long = (color.lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow) ** 3;
  const medium = (color.lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow) ** 3;
  const short = (color.lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow) ** 3;
  return {
    red: 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    green: -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    blue: -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  };
}

function inGamut(linear: LinearRgb): boolean {
  const bounds = [linear.red, linear.green, linear.blue];
  return bounds.every((value) => value >= -1e-4 && value <= 1 + 1e-4);
}

/**
 * Hold lightness and hue, give up chroma. Clipping RGB channels instead would
 * shift both, which is how a rotation lands two different hues on one colour.
 */
function fitChroma(color: OklchColor): OklchColor {
  if (inGamut(oklchToLinear(color))) return color;
  let reachable = 0;
  let unreachable = color.chroma;
  for (let step = 0; step < 16; step += 1) {
    const mid = (reachable + unreachable) / 2;
    if (inGamut(oklchToLinear({ ...color, chroma: mid }))) reachable = mid;
    else unreachable = mid;
  }
  return { ...color, chroma: reachable };
}

function oklchToHex(color: OklchColor): string {
  const linear = oklchToLinear(fitChroma(color));
  return formatHex({
    red: srgbChannel(linear.red),
    green: srgbChannel(linear.green),
    blue: srgbChannel(linear.blue),
  });
}

function readSurfaces(theme: PluginTheme): SurfaceContext {
  const colors = theme.colors;
  const candidates = [colors.surface0, colors.surface1, colors.surface2];
  const surfaces = candidates.filter((value) => parseHexColor(value) !== null);
  if (surfaces.length === 0) return { surfaces, dark: true };
  const total = surfaces.reduce((sum, value) => sum + relativeLuminance(value), 0);
  return { surfaces, dark: total / surfaces.length < DARK_SURFACE_LUMINANCE };
}

function minSurfaceContrast(color: string, surfaces: string[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const surface of surfaces) lowest = Math.min(lowest, contrastRatio(color, surface));
  return lowest;
}

/**
 * Walk lightness away from the surfaces until the band clears the floor. A hue
 * whose gamut runs out early — blue on a light theme — ends at the bound rather
 * than at the floor, which is still the most legible colour that hue can offer.
 */
function fitContrast(color: OklchColor, context: SurfaceContext): string {
  const direction = context.dark ? 1 : -1;
  let lightness = color.lightness;
  let hex = oklchToHex(color);
  for (let step = 0; step < CONTRAST_STEPS; step += 1) {
    if (minSurfaceContrast(hex, context.surfaces) >= CONTRAST_FLOOR) return hex;
    lightness = clamp(lightness + direction * CONTRAST_STEP, LIGHTNESS_MIN, LIGHTNESS_MAX);
    hex = oklchToHex({ ...color, lightness });
  }
  return hex;
}

function buildPalette(theme: PluginTheme, count: number): string[] {
  const context = readSurfaces(theme);
  const accent = rgbToOklch(parseHexColor(theme.colors.accent) ?? FALLBACK_ACCENT);
  const band = context.dark ? DARK_BAND : LIGHT_BAND;
  const palette: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hue = normalizeHue(accent.hue + (index * 360) / count);
    palette.push(fitContrast({ ...band, hue }, context));
  }
  return palette;
}

function seriesCount(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
}

/**
 * `count` distinct colours for `count` series, in a stable order: index 0 keeps
 * the accent's hue and each later index rotates one even step on.
 *
 * The chart asks for a colour per series per bucket, so the set is memoised on
 * the theme colours it was derived from rather than regenerated per bar.
 */
export function seriesPalette(theme: PluginTheme, count: number): string[] {
  const total = seriesCount(count);
  const colors = theme.colors;
  const key = `${colors.accent}|${colors.surface0}|${colors.surface1}|${colors.surface2}|${total}`;
  const cached = paletteCache.get(key);
  if (cached !== undefined) return cached;
  const palette = buildPalette(theme, total);
  if (paletteCache.size >= PALETTE_CACHE_LIMIT) paletteCache.clear();
  paletteCache.set(key, palette);
  return palette;
}

/** The palette entry for one series. Out-of-range indices clamp to the ends. */
export function seriesColor(theme: PluginTheme, index: number, count: number): string {
  const palette = seriesPalette(theme, count);
  const slot = Number.isFinite(index) ? clamp(Math.floor(index), 0, palette.length - 1) : 0;
  return palette[slot] ?? formatHex(FALLBACK_ACCENT);
}

/**
 * Which way a child can move and still gain contrast. The parent already clears
 * the floor against its own surfaces, and a colour past 0.5 perceptual lightness
 * has its contrast room on the light side, so moving away from 0.5 can only
 * raise the ratio. A parent already at the end of its band spreads the other way
 * rather than collapsing every child onto one colour.
 */
function childBand(parentLightness: number): LightnessBand {
  const away = parentLightness >= 0.5 ? 1 : -1;
  const room = childRoom(parentLightness, away);
  if (room > CHILD_OFFSET_MIN) return childSpan(parentLightness, away, room);
  return childSpan(parentLightness, -away, childRoom(parentLightness, -away));
}

function childRoom(parentLightness: number, direction: number): number {
  const limit = direction > 0 ? CHILD_LIGHTNESS_MAX : CHILD_LIGHTNESS_MIN;
  return Math.max(0, (limit - parentLightness) * direction);
}

function childSpan(parentLightness: number, direction: number, room: number): LightnessBand {
  const start = Math.min(CHILD_OFFSET_MIN, room / 4);
  const end = Math.min(CHILD_OFFSET_MAX, room);
  return {
    start: parentLightness + direction * start,
    end: parentLightness + direction * end,
  };
}

/**
 * A model's colour inside its provider's: same hue and chroma, separated only by
 * lightness, so an expanded provider reads as one family rather than as `count`
 * new categories competing with the providers beside it.
 */
export function childColor(parentColor: string, index: number, count: number): string {
  const parent = rgbToOklch(parseHexColor(parentColor) ?? FALLBACK_ACCENT);
  const total = seriesCount(count);
  const slot = Number.isFinite(index) ? clamp(Math.floor(index), 0, total - 1) : 0;
  const band = childBand(parent.lightness);
  const ratio = total === 1 ? 0 : slot / (total - 1);
  return oklchToHex({
    lightness: band.start + (band.end - band.start) * ratio,
    chroma: parent.chroma,
    hue: parent.hue,
  });
}
