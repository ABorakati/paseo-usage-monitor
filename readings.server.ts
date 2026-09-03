import {
  readAtPath,
  readNumberAtPath,
  readStringAtPath,
  readTimestampAtPath,
} from "./json-path.server";
import type {
  UsageBalanceMapping,
  UsageBalanceReading,
  UsageEachMapping,
  UsageQuotaMapping,
  UsageQuotaReading,
  UsageRateMapping,
  UsageRateReading,
  UsageRateSchedule,
  UsageRateWindow,
  UsageReading,
  UsageReadingMapping,
  UsageWindow,
} from "./limits.shared";

const MILLIS_PER_MINUTE = 60_000;

type BucketMapping = UsageQuotaMapping | UsageBalanceMapping;

/** Under `each` a mapping yields many readings, so identity is resolved per element. */
interface ReadingIdentity {
  id: string;
  label: string;
  group: string | null;
}

/**
 * A quota genuinely past its ceiling stays past it — only a bar's width gets
 * clamped, never the reported number. A negative result is bad data from the
 * vendor, not zero consumption, so it reads as absent.
 */
function normalizePercent(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

function readPercent(document: unknown, path: string | undefined): number | null {
  if (!path) return null;
  const value = readNumberAtPath(document, path);
  return value === null ? null : normalizePercent(value);
}

/** Blank strings are as absent as a missing path: a label of "" helps nobody. */
function readNonEmptyString(document: unknown, path: string | undefined): string | null {
  if (!path) return null;
  const value = readStringAtPath(document, path);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readAmount(document: unknown, path: string | undefined): number | null {
  return path ? readNumberAtPath(document, path) : null;
}

/**
 * Amounts carry a vendor's unit, percentages never do. One provider reports
 * credit in ten-thousandths of a dollar and another reports a prepaid balance
 * as a negative number, so a mapping may rescale what it reads.
 */
function readScaledAmount(
  document: unknown,
  path: string | undefined,
  scale: number,
): number | null {
  const value = readAmount(document, path);
  return value === null ? null : value * scale;
}

interface QuotaAmounts {
  used: number | null;
  limit: number | null;
  remaining: number | null;
}

function completeQuotaAmounts(amounts: QuotaAmounts): QuotaAmounts {
  const { used, limit, remaining } = amounts;
  if (limit !== null && used !== null && remaining === null) {
    return { used, limit, remaining: limit - used };
  }
  if (limit !== null && remaining !== null && used === null) {
    return { used: limit - remaining, limit, remaining };
  }
  if (used !== null && remaining !== null && limit === null) {
    return { used, limit: used + remaining, remaining };
  }
  return amounts;
}

function resolveQuotaPercent(
  mapping: UsageQuotaMapping,
  document: unknown,
  amounts: QuotaAmounts,
): number | null {
  const explicit = readPercent(document, mapping.percentPath);
  if (explicit !== null) return explicit;
  const remainingPercent = readAmount(document, mapping.percentRemainingPath);
  if (remainingPercent !== null) return normalizePercent(100 - remainingPercent);
  const { used, limit } = amounts;
  if (used === null || limit === null || limit <= 0) return null;
  // Completion already turned a remaining/limit pair into `used`, which is
  // `100 - remaining / limit * 100` reached by another route.
  return normalizePercent((used / limit) * 100);
}

function resolveWindow(
  mapping: UsageQuotaMapping,
  document: unknown,
  now: Date,
): UsageWindow | null {
  const { window } = mapping;
  if (!window) return null;
  // An absolute timestamp survives request latency, while a relative offset
  // ages in transit, so it remains authoritative when a response carries both.
  let resetsAt = window.resetsAtPath ? readTimestampAtPath(document, window.resetsAtPath) : null;
  if (resetsAt === null) {
    const resetsInSec = readAmount(document, window.resetsInSecPath);
    if (resetsInSec !== null && resetsInSec >= 0) {
      const resetInstant = new Date(now.getTime() + resetsInSec * 1000);
      if (!Number.isNaN(resetInstant.getTime())) resetsAt = resetInstant.toISOString();
    }
  }
  const durationMs = window.durationMs ?? readAmount(document, window.durationMsPath);
  return { label: window.label, resetsAt, durationMs };
}

function projectQuota(
  mapping: UsageQuotaMapping,
  document: unknown,
  identity: ReadingIdentity,
  now: Date,
): UsageQuotaReading {
  const scale = mapping.scale ?? 1;
  const amounts = completeQuotaAmounts({
    used: readScaledAmount(document, mapping.usedPath, scale),
    limit: readScaledAmount(document, mapping.limitPath, scale),
    remaining: readScaledAmount(document, mapping.remainingPath, scale),
  });
  return {
    kind: "quota",
    id: identity.id,
    label: identity.label,
    group: identity.group,
    unit: mapping.unit,
    window: resolveWindow(mapping, document, now),
    used: amounts.used,
    limit: amounts.limit,
    remaining: amounts.remaining,
    percent: resolveQuotaPercent(mapping, document, amounts),
  };
}

function projectBalance(
  mapping: UsageBalanceMapping,
  document: unknown,
  identity: ReadingIdentity,
): UsageBalanceReading {
  const scale = mapping.scale ?? 1;
  const remaining = readScaledAmount(document, mapping.remainingPath, scale);
  const total = readScaledAmount(document, mapping.totalPath, scale);
  const explicit = readPercent(document, mapping.percentRemainingPath);
  const derived =
    remaining !== null && total !== null && total > 0
      ? normalizePercent((remaining / total) * 100)
      : null;
  return {
    kind: "balance",
    id: identity.id,
    label: identity.label,
    group: identity.group,
    unit: mapping.unit,
    remaining,
    total,
    percentRemaining: explicit ?? derived,
    currency: readNonEmptyString(document, mapping.currencyPath),
  };
}

function parseWallClock(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

const WALL_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = WALL_CLOCK_FORMATTERS.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  WALL_CLOCK_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/** A clock reading in some zone: local calendar date plus minutes since local midnight. */
interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  minutesOfDay: number;
}

function zonedWallClock(instant: number, timeZone: string): ZonedWallClock {
  const fields: Record<string, string> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(new Date(instant))) {
    fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    minutesOfDay: Number(fields.hour) * 60 + Number(fields.minute),
  };
}

/** Minutes the zone sits east of UTC at this instant. */
function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const wall = zonedWallClock(instant, timeZone);
  const asUtc =
    Date.UTC(wall.year, wall.month - 1, wall.day) + wall.minutesOfDay * MILLIS_PER_MINUTE;
  return (asUtc - (instant - (instant % MILLIS_PER_MINUTE))) / MILLIS_PER_MINUTE;
}

/**
 * The instant at which the zone's clock reads `target`. A zone's offset is not
 * constant, so the wall time is resolved against the offset in force at the
 * answer rather than the one in force now.
 *
 * A wall time that occurs twice on a fall-back day resolves to its first
 * occurrence. One the clock skips on a spring-forward day resolves to the
 * instant the clock jumps to, so a boundary never lands before the gap.
 */
function instantForWallClock(target: ZonedWallClock, timeZone: string): number {
  const naive =
    Date.UTC(target.year, target.month - 1, target.day) + target.minutesOfDay * MILLIS_PER_MINUTE;
  const guess = naive - zoneOffsetMinutes(naive, timeZone) * MILLIS_PER_MINUTE;
  const resolved = naive - zoneOffsetMinutes(guess, timeZone) * MILLIS_PER_MINUTE;
  const readback = zonedWallClock(resolved, timeZone);
  if (
    readback.year === target.year &&
    readback.month === target.month &&
    readback.day === target.day &&
    readback.minutesOfDay === target.minutesOfDay
  ) {
    return resolved;
  }
  return Math.max(guess, resolved);
}

/** Weekday, 0 = Sunday, of the local calendar date `daysAhead` days after this one. */
function weekdayAhead(wall: ZonedWallClock, daysAhead: number): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day + daysAhead)).getUTCDay();
}

function appliesOn(days: readonly number[] | undefined, weekday: number): boolean {
  return days === undefined || days.includes(weekday);
}

/** Start is inclusive, end exclusive, and `start > end` wraps past midnight. */
function windowIsActive(window: UsageRateWindow, wall: ZonedWallClock): boolean {
  const start = parseWallClock(window.start);
  const end = parseWallClock(window.end);
  if (start === end) return false;
  if (start < end) {
    return (
      wall.minutesOfDay >= start &&
      wall.minutesOfDay < end &&
      appliesOn(window.days, weekdayAhead(wall, 0))
    );
  }
  // A wrapping band belongs to the day its start falls on, and runs past midnight
  // into the next day even when that day is excluded.
  if (wall.minutesOfDay >= start) return appliesOn(window.days, weekdayAhead(wall, 0));
  return wall.minutesOfDay < end && appliesOn(window.days, weekdayAhead(wall, -1));
}

/** A boundary as a local calendar offset plus a wall-clock minute of that day. */
interface ScheduleBoundary {
  daysAhead: number;
  minutesOfDay: number;
}

/**
 * The next time any window begins, which is days away for a weekday-only band
 * read over a weekend. Every schedule has a window and every `days` list has an
 * entry, so a week's scan always finds one.
 *
 * The scan stops on the first day that yields a candidate, so every candidate
 * shares that day and the nearest is simply the earliest minute of it.
 */
function nextWindowStart(schedule: UsageRateSchedule, wall: ZonedWallClock): ScheduleBoundary {
  const candidates: ScheduleBoundary[] = [];
  for (let daysAhead = 0; candidates.length === 0 && daysAhead <= 7; daysAhead += 1) {
    const weekday = weekdayAhead(wall, daysAhead);
    for (const window of schedule.windows) {
      if (!appliesOn(window.days, weekday)) continue;
      const minutesOfDay = parseWallClock(window.start);
      if (daysAhead === 0 && minutesOfDay <= wall.minutesOfDay) continue;
      candidates.push({ daysAhead, minutesOfDay });
    }
  }
  return candidates.reduce((nearest, candidate) =>
    candidate.minutesOfDay < nearest.minutesOfDay ? candidate : nearest,
  );
}

interface ScheduleBand {
  state: string;
  multiplier: number;
  detail: string | null;
  boundary: ScheduleBoundary;
}

function resolveScheduleBand(schedule: UsageRateSchedule, wall: ZonedWallClock): ScheduleBand {
  const active = schedule.windows.find((window) => windowIsActive(window, wall));
  if (active) {
    const end = parseWallClock(active.end);
    return {
      state: active.label,
      multiplier: active.multiplier ?? schedule.defaultMultiplier,
      detail: active.detail ?? null,
      boundary: { daysAhead: end > wall.minutesOfDay ? 0 : 1, minutesOfDay: end },
    };
  }
  return {
    state: schedule.defaultLabel,
    multiplier: schedule.defaultMultiplier,
    detail: null,
    boundary: nextWindowStart(schedule, wall),
  };
}

function scheduleChangesAt(
  timeZone: string,
  boundary: ScheduleBoundary,
  wall: ZonedWallClock,
): string {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + boundary.daysAhead));
  const target: ZonedWallClock = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    minutesOfDay: boundary.minutesOfDay,
  };
  return new Date(instantForWallClock(target, timeZone)).toISOString();
}

function projectRate(mapping: UsageRateMapping, document: unknown, now: Date): UsageRateReading {
  const common = {
    kind: "rate",
    id: mapping.id,
    label: mapping.label,
    group: mapping.group ?? null,
  } as const;

  if (mapping.resolution.via === "schedule") {
    const { schedule } = mapping.resolution;
    const wall = zonedWallClock(now.getTime(), schedule.timeZone);
    const band = resolveScheduleBand(schedule, wall);
    return {
      ...common,
      state: band.state,
      multiplier: band.multiplier,
      detail: band.detail,
      changesAt: scheduleChangesAt(schedule.timeZone, band.boundary, wall),
    };
  }

  const { statePath, multiplierPath, changesAtPath, detailPath } = mapping.resolution;
  return {
    ...common,
    state: readNonEmptyString(document, statePath) ?? "Unknown",
    multiplier: readAmount(document, multiplierPath),
    changesAt: changesAtPath ? readTimestampAtPath(document, changesAtPath) : null,
    detail: readNonEmptyString(document, detailPath),
  };
}

function claimEachIdentity(
  mapping: BucketMapping,
  each: UsageEachMapping,
  element: unknown,
  index: number,
  claimed: Set<string>,
): ReadingIdentity {
  const slug = (readNonEmptyString(element, each.idPath) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug === "" ? `${mapping.id}-${index}` : `${mapping.id}-${slug}`;
  // A suffixed candidate can itself be a slug another element already claimed,
  // so keep advancing until one is free.
  let id = base;
  let attempt = index;
  while (claimed.has(id)) {
    id = `${base}-${attempt}`;
    attempt += 1;
  }
  claimed.add(id);
  const labelValue = readNonEmptyString(element, each.labelPath);
  return {
    id,
    label:
      labelValue === null ? `${mapping.label} ${index + 1}` : `${mapping.label} · ${labelValue}`,
    group: readNonEmptyString(element, each.groupPath) ?? mapping.group ?? null,
  };
}

/**
 * A numeric `equals` also matches a numeric string ("12"), the same coercion
 * every amount path already applies; string and boolean comparisons are strict,
 * and an element whose `path` does not resolve never matches.
 */
function matchesWhere(element: unknown, where: NonNullable<UsageEachMapping["where"]>): boolean {
  if (typeof where.equals === "number") {
    return readNumberAtPath(element, where.path) === where.equals;
  }
  return readAtPath(element, where.path) === where.equals;
}

/**
 * One entry per reading a bucket mapping produces, each carrying the document
 * its paths resolve against: the whole response, or one `each` element.
 */
interface BucketInstance {
  document: unknown;
  identity: ReadingIdentity;
}

function bucketInstances(mapping: BucketMapping, document: unknown): BucketInstance[] {
  const { each } = mapping;
  if (!each) {
    const identity = { id: mapping.id, label: mapping.label, group: mapping.group ?? null };
    return [{ document, identity }];
  }
  const value = readAtPath(document, each.path);
  if (!Array.isArray(value)) return [];
  const { where } = each;
  const elements: readonly unknown[] = where
    ? value.filter((element: unknown) => matchesWhere(element, where))
    : value;
  // A filter that keeps exactly one element, from an array whose elements
  // carry no id or label of their own, is a way of addressing one bucket by
  // its contents rather than its position. Z.ai's `limits` names its windows
  // only by unit. Numbering a lone reading "Session 1" would say there is a
  // second, so it keeps the mapping's own identity.
  if (
    where !== undefined &&
    elements.length === 1 &&
    each.idPath === undefined &&
    each.labelPath === undefined
  ) {
    const [element] = elements;
    return [
      {
        document: element,
        identity: {
          id: mapping.id,
          label: mapping.label,
          group: readNonEmptyString(element, each.groupPath) ?? mapping.group ?? null,
        },
      },
    ];
  }
  const claimed = new Set<string>();
  // Index numbering runs over the kept elements, so a reading's id does not
  // renumber when the vendor adds an entry the filter excludes.
  return elements.map((element, index) => ({
    document: element,
    identity: claimEachIdentity(mapping, each, element, index, claimed),
  }));
}

export interface ProjectReadingsInput {
  readings: readonly UsageReadingMapping[];
  document: unknown;
  now: Date;
}

export function projectReadings(input: ProjectReadingsInput): UsageReading[] {
  const projected: UsageReading[] = [];
  for (const mapping of input.readings) {
    if (mapping.kind === "rate") {
      projected.push(projectRate(mapping, input.document, input.now));
      continue;
    }
    for (const instance of bucketInstances(mapping, input.document)) {
      projected.push(
        mapping.kind === "quota"
          ? projectQuota(mapping, instance.document, instance.identity, input.now)
          : projectBalance(mapping, instance.document, instance.identity),
      );
    }
  }
  return projected;
}

/** A provider whose readings are all schedule-driven never needs a request. */
export function requiresSourceDocument(readings: readonly UsageReadingMapping[]): boolean {
  return readings.some(
    (mapping) => mapping.kind !== "rate" || mapping.resolution.via === "response",
  );
}
