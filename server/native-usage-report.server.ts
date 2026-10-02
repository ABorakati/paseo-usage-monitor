// Server-only: the plugin compiler rejects `@getpaseo/plugin/server/*` imports,
// type-only ones included, from any file the client bundle can reach.
import type { UsageDetail, UsageReport, UsageWindow } from "@getpaseo/plugin/server/usage";
import { formatUsageAmount } from "../shared/amount.shared";
import { selectPillReading } from "../shared/pills.shared";
import type { UsageProviderSnapshot, UsageQuotaReading } from "../shared/limits.shared";

function tone(usedPct: number | null): UsageWindow["tone"] {
  if (usedPct === null) return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

function durationLabel(durationMs: number): string | undefined {
  if (durationMs === 18_000_000) return "5h";
  if (durationMs === 604_800_000) return "wk";
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (durationMs >= size) return `${Math.round(durationMs / size)}${suffix}`;
  }
  return undefined;
}
function usedPercent(reading: UsageQuotaReading): number | null {
  if (reading.percent !== null) return reading.percent;
  if (reading.used === null || reading.limit === null || reading.limit <= 0) return null;
  return (reading.used / reading.limit) * 100;
}

function readingLabel(reading: { label: string; group: string | null }): string {
  return reading.group === null ? reading.label : `${reading.group} · ${reading.label}`;
}

function shortestQuota(readings: readonly UsageProviderSnapshot["readings"][number][]) {
  const quotas = readings.filter(
    (reading): reading is UsageQuotaReading =>
      reading.kind === "quota" && usedPercent(reading) !== null,
  );
  return quotas.reduce<UsageQuotaReading | null>((selected, reading) => {
    if (selected === null) return reading;
    const duration = reading.window?.durationMs ?? Number.POSITIVE_INFINITY;
    const selectedDuration = selected.window?.durationMs ?? Number.POSITIVE_INFINITY;
    return duration < selectedDuration ? reading : selected;
  }, null);
}

function quotaWindows(snapshot: UsageProviderSnapshot): UsageWindow[] {
  const quotaReadings = snapshot.readings.filter(
    (reading): reading is UsageQuotaReading =>
      reading.kind === "quota" &&
      (usedPercent(reading) !== null || reading.used !== null || reading.limit !== null),
  );
  const windows: UsageWindow[] = quotaReadings
    .filter((reading) => usedPercent(reading) !== null)
    .map((reading) => {
      const usedPct = usedPercent(reading);
      const window = reading.window;
      const result: UsageWindow = {
        id: reading.id,
        label: readingLabel(reading),
        usedPct,
        remainingPct: Math.max(0, 100 - (usedPct ?? 0)),
        resetsAt: window?.resetsAt ?? null,
        tone: tone(usedPct),
      };
      if (window?.durationMs !== null && window?.durationMs !== undefined) {
        const shortLabel = durationLabel(window.durationMs);
        if (shortLabel !== undefined) result.shortLabel = shortLabel;
      }
      return result;
    });
  const selected = snapshot.display.pill?.reading
    ? selectPillReading(snapshot.readings, snapshot.display.pill.reading)
    : selectPillReading(snapshot.readings, null);
  let summaryId =
    selected?.kind === "quota" && windows.some((window) => window.id === selected.id)
      ? selected.id
      : shortestQuota(snapshot.readings)?.id;
  if (summaryId === undefined)
    summaryId = quotaReadings.find((reading) => usedPercent(reading) !== null)?.id;
  if (summaryId !== undefined) {
    const target = windows.find((window) => window.id === summaryId);
    if (target) target.summary = true;
  }
  return windows;
}

function balanceEntries(snapshot: UsageProviderSnapshot): {
  balances: NonNullable<Extract<UsageReport, { status: "available" }>["balances"]>;
  details: UsageDetail[];
} {
  const balances: NonNullable<Extract<UsageReport, { status: "available" }>["balances"]> = [];
  const details: UsageDetail[] = [];
  for (const reading of snapshot.readings) {
    if (reading.kind !== "balance") continue;
    // Paseo's balance units have no other currency, no "flows" and no percent,
    // so those amounts travel as a formatted detail row instead.
    const unit =
      reading.currency !== null
        ? reading.currency.toUpperCase() === "USD"
          ? "usd"
          : null
        : reading.unit === "flows" || reading.unit === "percent"
          ? null
          : reading.unit;
    if (unit === null) {
      const amount = reading.remaining ?? reading.total;
      if (amount !== null) {
        details.push({
          id: reading.id,
          label: readingLabel(reading),
          value: formatUsageAmount(amount, reading.unit, reading.currency),
        });
      }
      continue;
    }
    const remaining = reading.remaining;
    const total = reading.total;
    const used = remaining !== null && total !== null ? total - remaining : null;
    const usedPct =
      reading.percentRemaining !== null
        ? 100 - reading.percentRemaining
        : used !== null && total !== null && total > 0
          ? (used / total) * 100
          : null;
    balances.push({
      id: reading.id,
      label: readingLabel(reading),
      remaining,
      limit: total,
      ...(used === null ? {} : { used }),
      unit,
      tone:
        total !== null && total > 0
          ? tone(usedPct)
          : remaining !== null && remaining <= 0
            ? "danger"
            : "ok",
    });
  }
  return { balances, details };
}

function percentageDetail(reading: UsageQuotaReading): UsageDetail | null {
  if (usedPercent(reading) !== null || reading.used === null) return null;
  return {
    id: reading.id,
    label: readingLabel(reading),
    value: formatUsageAmount(reading.used, reading.unit),
  };
}

export function nativeUsageReport(snapshot: UsageProviderSnapshot): UsageReport {
  const windows = quotaWindows(snapshot);
  const { balances, details } = balanceEntries(snapshot);
  for (const reading of snapshot.readings) {
    if (reading.kind === "quota") {
      const detail = percentageDetail(reading);
      if (detail !== null) details.push(detail);
    } else if (reading.kind === "rate") {
      details.push({
        id: reading.id,
        label: readingLabel(reading),
        value: `${reading.state}${reading.multiplier === null ? "" : ` ×${reading.multiplier}`}${reading.changesAt === null ? "" : ` until ${reading.changesAt}`}`,
      });
    }
  }
  if (snapshot.notice !== null) {
    details.push({ id: "notice", label: "Status", value: snapshot.notice, tone: "warning" });
  }
  if (snapshot.status === "error") {
    if (snapshot.readings.length > 0) {
      if (snapshot.error !== null) {
        details.push({ id: "error", label: "Status", value: snapshot.error, tone: "warning" });
      }
    } else if (snapshot.authStatus === 401 || snapshot.authStatus === 403) {
      return {
        status: "unavailable",
        problem: {
          kind: "rejected",
          status: snapshot.authStatus,
          ...(snapshot.authRefreshCommand === null
            ? {}
            : { refreshedBy: snapshot.authRefreshCommand }),
        },
      };
    } else {
      return { status: "error", error: snapshot.error ?? "Usage provider failed" };
    }
  }
  return {
    status: "available",
    windows,
    ...(balances.length === 0 ? {} : { balances }),
    ...(details.length === 0 ? {} : { details }),
  };
}
