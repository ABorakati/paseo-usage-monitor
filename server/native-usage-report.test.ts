import { describe, expect, test } from "vitest";
import { UsageProviderSnapshotSchema } from "../shared/limits.shared";
import { nativeUsageReport } from "./native-usage-report.server";

function snapshot(
  values: Partial<Parameters<typeof UsageProviderSnapshotSchema.parse>[0]> &
    Record<string, unknown> = {},
) {
  return UsageProviderSnapshotSchema.parse({
    providerId: "provider",
    label: "Provider",
    description: null,
    unverified: false,
    live: false,
    status: "ok",
    readings: [],
    error: null,
    notice: null,
    authRefreshCommand: null,
    fetchedAt: null,
    display: {},
    icon: null,
    ...values,
  });
}

describe("native usage report mapping", () => {
  test("maps windows, chooses one pill summary, and derives percent from amounts", () => {
    const report = nativeUsageReport(
      snapshot({
        readings: [
          {
            id: "session-5h",
            label: "Session",
            group: "Model",
            kind: "quota",
            unit: "requests",
            window: { label: "5 hours", durationMs: 18_000_000, resetsAt: "2026-10-03T00:00:00Z" },
            used: 8,
            limit: 10,
            remaining: 2,
            percent: null,
          },
          {
            id: "weekly",
            label: "Weekly",
            group: null,
            kind: "quota",
            unit: "requests",
            window: { label: "Weekly", durationMs: 604_800_000, resetsAt: null },
            used: 2,
            limit: 10,
            remaining: 8,
            percent: 20,
          },
        ],
      }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("expected available report");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "session-5h",
        label: "Model · Session",
        usedPct: 80,
        remainingPct: 20,
        shortLabel: "5h",
        summary: true,
      }),
      expect.objectContaining({ id: "weekly", shortLabel: "wk" }),
    ]);
  });

  test("maps balances, count-only quotas, rates, and notices as details", () => {
    const report = nativeUsageReport(
      snapshot({
        notice: "Showing a stored reading",
        readings: [
          {
            id: "requests",
            label: "Requests",
            group: null,
            kind: "quota",
            unit: "requests",
            window: null,
            used: 9,
            limit: null,
            remaining: null,
            percent: null,
          },
          {
            id: "eur",
            label: "Credit",
            group: null,
            kind: "balance",
            unit: "usd",
            remaining: 12.5,
            total: 20,
            percentRemaining: 62.5,
            currency: "EUR",
          },
          {
            id: "rate",
            label: "Rate",
            group: null,
            kind: "rate",
            state: "peak",
            multiplier: 1.5,
            changesAt: "18:00",
            detail: null,
          },
        ],
      }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("expected available report");
    expect(report.balances).toBeUndefined();
    expect(report.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "requests", value: "9" }),
        expect.objectContaining({ id: "eur", value: "€12.50" }),
        expect.objectContaining({ id: "rate", value: "peak ×1.5 until 18:00" }),
        expect.objectContaining({ id: "notice", tone: "warning" }),
      ]),
    );
  });

  test("maps supported balances and preserves an empty available report", () => {
    const report = nativeUsageReport(
      snapshot({
        readings: [
          {
            id: "credits",
            label: "Credits",
            group: null,
            kind: "balance",
            unit: "credits",
            remaining: 3,
            total: 10,
            percentRemaining: 30,
            currency: null,
          },
        ],
      }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("expected available report");
    expect(report.balances).toEqual([
      expect.objectContaining({
        id: "credits",
        used: 7,
        remaining: 3,
        limit: 10,
        unit: "credits",
        tone: "warning",
      }),
    ]);
    expect(nativeUsageReport(snapshot())).toEqual({ status: "available", windows: [] });
  });

  test("returns structured auth rejection and retains stored fallback readings", () => {
    expect(
      nativeUsageReport(
        snapshot({
          status: "error",
          authStatus: 403,
          authRefreshCommand: "claude",
          error: "Credential rejected",
        }),
      ),
    ).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 403, refreshedBy: "claude" },
    });
    const fallback = nativeUsageReport(
      snapshot({
        status: "error",
        error: "Provider unavailable",
        readings: [
          {
            id: "window",
            label: "Window",
            group: null,
            kind: "quota",
            unit: "tokens",
            window: null,
            used: 4,
            limit: 10,
            remaining: 6,
            percent: null,
          },
        ],
      }),
    );
    expect(fallback.status).toBe("available");
    if (fallback.status !== "available") throw new Error("expected stored fallback");
    expect(fallback.windows[0]).toMatchObject({ id: "window", summary: true, usedPct: 40 });
    expect(fallback.details).toEqual([expect.objectContaining({ id: "error", tone: "warning" })]);
  });

  test("uses a configured composer reading as the summary window", () => {
    const report = nativeUsageReport(
      snapshot({
        display: { pill: { reading: "weekly" } },
        readings: [
          {
            id: "session",
            label: "Session",
            group: null,
            kind: "quota",
            unit: "tokens",
            window: { label: "5h", durationMs: 18_000_000, resetsAt: null },
            used: 1,
            limit: 10,
            remaining: 9,
            percent: 10,
          },
          {
            id: "weekly",
            label: "Weekly",
            group: null,
            kind: "quota",
            unit: "tokens",
            window: { label: "7d", durationMs: 604_800_000, resetsAt: null },
            used: 2,
            limit: 10,
            remaining: 8,
            percent: 20,
          },
        ],
      }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("expected available report");
    expect(
      report.windows.filter((window) => window.summary === true).map((window) => window.id),
    ).toEqual(["weekly"]);
  });
});
