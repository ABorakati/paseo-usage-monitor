import { formatUsageAmount } from "./amount.shared";
import type {
  UsageBalanceReading,
  UsageDisplay,
  UsageProviderSnapshot,
  UsageQuotaReading,
  UsageReading,
} from "./limits.shared";

/**
 * The composer rail is a glance, not a screen. Everything here answers one
 * question per provider — how much of one window is gone — and leaves the
 * card surfaces to answer the rest. The logic lives apart from the component
 * so the rules that decide which reading a pill tracks are testable without a
 * renderer.
 */

/** Pill ids are plugin-local and must match the host's `^[a-z][a-z0-9-]*$`. */
export const PILL_ID_PREFIX = "usage-";

export function composerPillId(providerId: string): string {
  return `${PILL_ID_PREFIX}${providerId}`;
}

export interface ResolvedPillSettings {
  /** Ascending along the rail; null sorts after every number. */
  order: number | null;
  style: "ring" | "bar" | "none";
  value: "used" | "remaining";
  /** Reading mapping id the user pinned, or null to let the window rule decide. */
  reading: string | null;
  label: "provider" | "reading" | "none";
  readout: "percent" | "amount" | "none";
}

export type UsagePillReading = UsageQuotaReading | UsageBalanceReading;

/**
 * A pill inherits the card's own style and direction so a provider set to a
 * ring reads as a ring in both places, and only diverges where the user says
 * so. Returns null for a provider that has not opted onto the rail.
 */
export function resolvePillSettings(
  display: UsageDisplay | undefined,
): ResolvedPillSettings | null {
  const pill = display?.pill;
  if (!pill?.enabled) {
    return null;
  }
  return {
    order: pill.order ?? display?.order ?? null,
    style: pill.style ?? (display?.style === "ring" ? "ring" : "bar"),
    value: pill.value ?? display?.value ?? "used",
    reading: pill.reading ?? null,
    label: pill.label,
    readout: pill.readout,
  };
}

function isPillReading(reading: UsageReading): reading is UsagePillReading {
  return reading.kind === "quota" || reading.kind === "balance";
}

function windowDuration(reading: UsagePillReading): number | null {
  if (reading.kind !== "quota" || reading.window === null) {
    return null;
  }
  const { durationMs } = reading.window;
  return durationMs !== null && durationMs > 0 ? durationMs : null;
}

/**
 * Which of two readings a rail should show. Shorter windows win, because the
 * five-hour session runs out mid-task while the weekly allowance rarely does.
 * A vendor that publishes no window duration leaves nothing to compare — every
 * Antigravity pool bar arrives that way — so those fall back to whichever is
 * closest to running out, which is also what a collapsed card shows.
 */
function preferredReading(left: UsagePillReading, right: UsagePillReading): UsagePillReading {
  const leftMs = windowDuration(left);
  const rightMs = windowDuration(right);
  if (leftMs !== rightMs) {
    if (leftMs === null) return right;
    if (rightMs === null) return left;
    return leftMs <= rightMs ? left : right;
  }
  const leftPercent = readingPercentUsed(left) ?? -1;
  const rightPercent = readingPercentUsed(right) ?? -1;
  return rightPercent > leftPercent ? right : left;
}

/**
 * Without a pinned id the pill tracks the reading that answers "how close am I
 * to running out". A reading whose vendor publishes no ceiling can state an
 * amount but never a percentage, so it cannot fill a gauge and is only ever a
 * last resort: Antigravity reports request and token counts with no allowance
 * beside them, and picking one of those left the rail with nothing to draw.
 * A provider with no quota at all falls back to its balance, which is what an
 * API-credit account has instead.
 */
export function selectPillReading(
  readings: readonly UsageReading[],
  preferredId: string | null,
): UsagePillReading | null {
  const candidates = readings.filter(isPillReading);
  if (candidates.length === 0) {
    return null;
  }
  if (preferredId !== null) {
    const pinned = candidates.find((reading) => reading.id === preferredId);
    if (pinned !== undefined) {
      return pinned;
    }
  }
  const measured = candidates.filter((reading) => readingPercentUsed(reading) !== null);
  const pool = measured.length > 0 ? measured : candidates;
  return pool.reduce(preferredReading);
}

export interface PillMetrics {
  /** 0-100 consumed. Drives the threshold tone even when the gauge draws headroom. */
  percentUsed: number | null;
  /** 0-100 the gauge draws, already in the configured direction. */
  percentFilled: number | null;
  /** The number beside the gauge, already in the configured direction. */
  readout: string | null;
  readingLabel: string;
  /** "Session", "Weekly", and the like. Null for a balance. */
  windowLabel: string | null;
  resetsAt: string | null;
}

function ratioPercent(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) {
    return null;
  }
  return (part / whole) * 100;
}

function quotaPercentUsed(reading: UsageQuotaReading): number | null {
  if (reading.percent !== null) {
    return reading.percent;
  }
  const fromUsed = ratioPercent(reading.used, reading.limit);
  if (fromUsed !== null) {
    return fromUsed;
  }
  const fromRemaining = ratioPercent(reading.remaining, reading.limit);
  return fromRemaining === null ? null : 100 - fromRemaining;
}

function balancePercentUsed(reading: UsageBalanceReading): number | null {
  if (reading.percentRemaining !== null) {
    return 100 - reading.percentRemaining;
  }
  const fromRemaining = ratioPercent(reading.remaining, reading.total);
  return fromRemaining === null ? null : 100 - fromRemaining;
}

function readingPercentUsed(reading: UsagePillReading): number | null {
  return reading.kind === "quota" ? quotaPercentUsed(reading) : balancePercentUsed(reading);
}

/** One side of a reading as text: what it consumed, or what is left. */
function amountText(reading: UsagePillReading, settings: ResolvedPillSettings): string | null {
  if (reading.kind === "quota") {
    const amount = settings.value === "used" ? reading.used : reading.remaining;
    return amount === null ? null : formatUsageAmount(amount, reading.unit);
  }
  if (settings.value === "remaining") {
    return reading.remaining === null
      ? null
      : formatUsageAmount(reading.remaining, reading.unit, reading.currency);
  }
  if (reading.total === null || reading.remaining === null) {
    return null;
  }
  return formatUsageAmount(reading.total - reading.remaining, reading.unit, reading.currency);
}

/**
 * The number beside the gauge, in the direction the pill is configured to
 * read. A quota states its own used and remaining sides; a balance publishes
 * only what is left, so spend is the difference against its starting total.
 *
 * A percentage needs a ceiling, and plenty of vendors publish none — an
 * Antigravity request count arrives with no allowance beside it. Falling back
 * to the amount keeps a real number on the rail instead of a dash.
 */
function readoutText(
  reading: UsagePillReading,
  settings: ResolvedPillSettings,
  percentFilled: number | null,
): string | null {
  if (settings.readout === "none") {
    return null;
  }
  if (settings.readout === "percent" && percentFilled !== null) {
    return `${Math.round(percentFilled)}%`;
  }
  return amountText(reading, settings);
}

export function pillMetrics(
  reading: UsagePillReading,
  settings: ResolvedPillSettings,
): PillMetrics {
  const percentUsed = readingPercentUsed(reading);
  let percentFilled: number | null = null;
  if (percentUsed !== null) {
    percentFilled = settings.value === "used" ? percentUsed : 100 - percentUsed;
  }
  const window = reading.kind === "quota" ? reading.window : null;
  return {
    percentUsed,
    percentFilled,
    readout: readoutText(reading, settings, percentFilled),
    readingLabel: reading.label,
    windowLabel: window?.label ?? null,
    resetsAt: window?.resetsAt ?? null,
  };
}

export interface ComposerPillEntry {
  providerId: string;
  providerLabel: string;
  settings: ResolvedPillSettings;
}

/**
 * A provider that opted in keeps its slot even while its last fetch failed: a
 * quota you asked to watch must not vanish at the moment it stops reporting.
 * A provider switched off entirely has nothing to say and is dropped.
 */
export function selectComposerPills(
  providers: readonly UsageProviderSnapshot[],
): ComposerPillEntry[] {
  const entries: ComposerPillEntry[] = [];
  for (const provider of providers) {
    if (provider.status === "disabled") {
      continue;
    }
    const settings = resolvePillSettings(provider.display);
    if (settings === null) {
      continue;
    }
    entries.push({
      providerId: provider.providerId,
      providerLabel: provider.label,
      settings,
    });
  }
  return entries.sort(comparePillEntries);
}

function comparePillEntries(left: ComposerPillEntry, right: ComposerPillEntry): number {
  const leftOrder = left.settings.order;
  const rightOrder = right.settings.order;
  if (leftOrder !== rightOrder) {
    if (leftOrder === null) {
      return 1;
    }
    if (rightOrder === null) {
      return -1;
    }
    return leftOrder - rightOrder;
  }
  return left.providerId.localeCompare(right.providerId);
}
