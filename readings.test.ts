import { describe, expect, test } from "vitest";
import type {
  UsageBalanceMapping,
  UsageQuotaMapping,
  UsageRateMapping,
  UsageRateSchedule,
} from "./limits.shared";
import { projectReadings, requiresSourceDocument } from "./readings.server";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function project(
  readings: readonly (UsageQuotaMapping | UsageBalanceMapping | UsageRateMapping)[],
  document: unknown,
  now: Date = NOW,
) {
  return projectReadings({ readings, document, now });
}

describe("projectReadings quota", () => {
  test("derives percent from used and limit", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      usedPath: "data.used",
      limitPath: "data.limit",
    };

    expect(project([mapping], { data: { used: 3500, limit: 10000 } })).toEqual([
      {
        kind: "quota",
        id: "session",
        label: "Session",
        group: null,
        unit: "tokens",
        window: null,
        used: 3500,
        limit: 10000,
        remaining: 6500,
        percent: 35,
      },
    ]);
  });

  test("prefers an explicit percent path over the used/limit pair", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      usedPath: "used",
      limitPath: "limit",
      percentPath: "utilization",
    };

    expect(project([mapping], { used: 1, limit: 10, utilization: 62.5 })[0]).toMatchObject({
      percent: 62.5,
      used: 1,
      limit: 10,
    });
  });

  test("inverts a percent-remaining path when no explicit percent exists", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "weekly",
      label: "Weekly",
      unit: "requests",
      percentRemainingPath: "left_pct",
    };

    expect(project([mapping], { left_pct: 18 })[0]).toMatchObject({ percent: 82 });
  });

  test("derives the missing member of the used/limit/remaining triple", () => {
    const fromRemaining: UsageQuotaMapping = {
      kind: "quota",
      id: "weekly",
      label: "Weekly",
      unit: "requests",
      limitPath: "limit",
      remainingPath: "remaining",
    };
    const fromUsedAndRemaining: UsageQuotaMapping = {
      kind: "quota",
      id: "weekly",
      label: "Weekly",
      unit: "requests",
      usedPath: "used",
      remainingPath: "remaining",
    };

    expect(project([fromRemaining], { limit: 200, remaining: 50 })[0]).toMatchObject({
      used: 150,
      limit: 200,
      remaining: 50,
      percent: 75,
    });
    expect(project([fromUsedAndRemaining], { used: 30, remaining: 70 })[0]).toMatchObject({
      used: 30,
      limit: 100,
      remaining: 70,
      percent: 30,
    });
  });

  test("keeps a quota past its ceiling above 100 and rounds to one decimal", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      usedPath: "used",
      limitPath: "limit",
    };

    expect(project([mapping], { used: 1, limit: 3 })[0]).toMatchObject({ percent: 33.3 });
    expect(project([mapping], { used: 9994, limit: 10000 })[0]).toMatchObject({ percent: 99.9 });
    expect(project([mapping], { used: 500, limit: 100 })[0]).toMatchObject({ percent: 500 });
    expect(project([mapping], { used: 130, limit: 100 })[0]).toMatchObject({ percent: 130 });
  });

  test("reports a negative or non-finite percentage as absent, never as zero", () => {
    const fromAmounts: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      usedPath: "used",
      limitPath: "limit",
    };
    const fromPercent: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      percentPath: "utilization",
    };
    const fromRemainingPercent: UsageQuotaMapping = {
      kind: "quota",
      id: "weekly",
      label: "Weekly",
      unit: "requests",
      percentRemainingPath: "left_pct",
    };

    expect(project([fromAmounts], { used: -20, limit: 100 })[0]).toMatchObject({ percent: null });
    expect(project([fromPercent], { utilization: -1 })[0]).toMatchObject({ percent: null });
    expect(project([fromPercent], { utilization: "Infinity" })[0]).toMatchObject({ percent: null });
    expect(project([fromRemainingPercent], { left_pct: 120 })[0]).toMatchObject({ percent: null });
  });

  test("never invents a percent from a single unrelated number", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      usedPath: "used",
      limitPath: "limit",
    };

    expect(project([mapping], { used: 4200 })[0]).toMatchObject({
      used: 4200,
      limit: null,
      remaining: null,
      percent: null,
    });
  });
});

describe("projectReadings window", () => {
  test("normalizes an epoch-seconds reset time to an ISO instant", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      window: { label: "5 hours", resetsAtPath: "resets_at" },
      usedPath: "used",
      limitPath: "limit",
    };

    expect(project([mapping], { resets_at: 1_800_000_000, used: 1, limit: 4 })[0]).toMatchObject({
      window: { label: "5 hours", resetsAt: "2027-01-15T08:00:00.000Z", durationMs: null },
    });
  });

  test("resolves a relative reset against the injected clock", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      window: { label: "Session", resetsInSecPath: "resetInSec" },
      percentPath: "percent",
    };

    expect(
      project([mapping], { percent: 17, resetInSec: 90 }, new Date("2026-09-02T10:00:00Z"))[0],
    ).toMatchObject({
      window: { label: "Session", resetsAt: "2026-09-02T10:01:30.000Z", durationMs: null },
    });
  });

  test("prefers an absolute reset when both reset forms are configured", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      window: {
        label: "Session",
        resetsAtPath: "resetsAt",
        resetsInSecPath: "resetInSec",
      },
      percentPath: "percent",
    };

    expect(
      project([mapping], {
        percent: 17,
        resetsAt: "2026-09-03T00:00:00Z",
        resetInSec: 90,
      })[0],
    ).toMatchObject({
      window: { resetsAt: "2026-09-03T00:00:00Z" },
    });
    expect(
      project([mapping], { percent: 17, resetInSec: 90 }, new Date("2026-09-02T10:00:00Z"))[0],
    ).toMatchObject({
      window: { resetsAt: "2026-09-02T10:01:30.000Z" },
    });
  });

  test("rejects negative and unparseable relative resets", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      window: { label: "Session", resetsInSecPath: "resetInSec" },
      percentPath: "percent",
    };

    expect(project([mapping], { percent: 17, resetInSec: -1 })[0]).toMatchObject({
      window: { resetsAt: null },
    });
    expect(project([mapping], { percent: 17, resetInSec: "later" })[0]).toMatchObject({
      window: { resetsAt: null },
    });
  });

  test("leaves a missing relative reset path unresolved", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      window: { label: "Session", resetsInSecPath: "resetInSec" },
      percentPath: "percent",
    };

    expect(project([mapping], { percent: 17 })[0]).toMatchObject({
      window: { resetsAt: null },
    });
  });

  test("passes a literal durationMs through and reads durationMsPath otherwise", () => {
    const literal: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      window: { label: "5 hours", durationMs: 18_000_000 },
    };
    const fromPath: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      window: { label: "Weekly", durationMsPath: "window_ms" },
    };

    expect(project([literal], {})[0]).toMatchObject({
      window: { label: "5 hours", resetsAt: null, durationMs: 18_000_000 },
    });
    expect(project([fromPath], { window_ms: 604_800_000 })[0]).toMatchObject({
      window: { label: "Weekly", resetsAt: null, durationMs: 604_800_000 },
    });
  });
});

describe("projectReadings balance", () => {
  test("derives percentRemaining from remaining and total", () => {
    const mapping: UsageBalanceMapping = {
      kind: "balance",
      id: "credits",
      label: "Credits",
      unit: "usd",
      remainingPath: "balance.remaining",
      totalPath: "balance.granted",
      currencyPath: "balance.currency",
    };

    expect(
      project([mapping], { balance: { remaining: 12.5, granted: 50, currency: "USD" } }),
    ).toEqual([
      {
        kind: "balance",
        id: "credits",
        label: "Credits",
        group: null,
        unit: "usd",
        remaining: 12.5,
        total: 50,
        percentRemaining: 25,
        currency: "USD",
      },
    ]);
  });

  test("prefers an explicit percentRemaining path", () => {
    const mapping: UsageBalanceMapping = {
      kind: "balance",
      id: "credits",
      label: "Credits",
      unit: "credits",
      remainingPath: "remaining",
      totalPath: "total",
      percentRemainingPath: "pct_left",
    };

    expect(project([mapping], { remaining: 1, total: 10, pct_left: 41.25 })[0]).toMatchObject({
      percentRemaining: 41.3,
    });
  });

  test("preserves a percentRemaining above 100 and drops a negative one", () => {
    const mapping: UsageBalanceMapping = {
      kind: "balance",
      id: "credits",
      label: "Credits",
      unit: "usd",
      remainingPath: "remaining",
      totalPath: "total",
    };
    const explicit: UsageBalanceMapping = { ...mapping, percentRemainingPath: "pct_left" };

    expect(project([mapping], { remaining: 60, total: 50 })[0]).toMatchObject({
      percentRemaining: 120,
    });
    expect(project([explicit], { remaining: 1, total: 50, pct_left: 140 })[0]).toMatchObject({
      percentRemaining: 140,
    });
    expect(project([mapping], { remaining: -5, total: 50 })[0]).toMatchObject({
      remaining: -5,
      percentRemaining: null,
    });
  });

  test("leaves percentRemaining null when nothing supports it", () => {
    const noTotal: UsageBalanceMapping = {
      kind: "balance",
      id: "credits",
      label: "Credits",
      unit: "usd",
      remainingPath: "remaining",
    };
    const zeroTotal: UsageBalanceMapping = {
      kind: "balance",
      id: "credits",
      label: "Credits",
      unit: "usd",
      remainingPath: "remaining",
      totalPath: "total",
    };

    expect(project([noTotal], { remaining: 8 })[0]).toMatchObject({
      remaining: 8,
      total: null,
      percentRemaining: null,
      currency: null,
    });
    expect(project([zeroTotal], { remaining: 0, total: 0 })[0]).toMatchObject({
      percentRemaining: null,
    });
  });
});

describe("projectReadings scale", () => {
  test("scales every amount and leaves an explicit percentage alone", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "tokens",
      scale: 1000,
      usedPath: "used",
      limitPath: "limit",
      percentPath: "pct",
    };

    expect(project([mapping], { used: 3, limit: 10, pct: 30 })[0]).toMatchObject({
      used: 3000,
      limit: 10000,
      remaining: 7000,
      percent: 30,
    });
  });

  test("derives a percent from the scaled pair", () => {
    const mapping: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "credits",
      scale: -1,
      remainingPath: "owed",
      limitPath: "granted",
    };

    expect(project([mapping], { owed: -25, granted: -100 })[0]).toMatchObject({
      used: 75,
      limit: 100,
      remaining: 25,
      percent: 75,
    });
  });

  test("scales a balance, including a vendor that reports credit as money owed", () => {
    const novita: UsageBalanceMapping = {
      kind: "balance",
      id: "credit",
      label: "Credit",
      unit: "usd",
      scale: 0.0001,
      remainingPath: "availableBalance",
    };
    const deepinfra: UsageBalanceMapping = {
      kind: "balance",
      id: "prepaid",
      label: "Prepaid",
      unit: "usd",
      scale: -1,
      remainingPath: "stripe_balance",
    };

    expect(project([novita], { availableBalance: "1000000" })[0]).toMatchObject({
      remaining: 100,
    });
    expect(project([deepinfra], { stripe_balance: -42.5 })[0]).toMatchObject({ remaining: 42.5 });
  });

  test("scales a balance total and keeps an explicit percentRemaining unscaled", () => {
    const mapping: UsageBalanceMapping = {
      kind: "balance",
      id: "credit",
      label: "Credit",
      unit: "usd",
      scale: 0.01,
      remainingPath: "remaining",
      totalPath: "total",
      percentRemainingPath: "pct_left",
    };

    expect(project([mapping], { remaining: 2500, total: 10000, pct_left: 25 })[0]).toMatchObject({
      remaining: 25,
      total: 100,
      percentRemaining: 25,
    });
  });

  test("reports a scaled balance beyond its total as beyond it, not as a full bar", () => {
    // Novita's own documented sample: available credit exceeds the credit limit,
    // so the honest reading is 500 percent remaining rather than a clamped 100.
    const novita: UsageBalanceMapping = {
      kind: "balance",
      id: "credit",
      label: "Credit",
      unit: "usd",
      scale: 0.0001,
      remainingPath: "availableBalance",
      totalPath: "creditLimit",
    };

    expect(
      project([novita], { availableBalance: "1000000", creditLimit: "200000" })[0],
    ).toMatchObject({ remaining: 100, total: 20, percentRemaining: 500 });
  });
});

describe("projectReadings each", () => {
  const buckets = {
    limits: [
      { model: "GPT-5 Codex", family: "codex", used: 120, limit: 400 },
      { model: "Claude Opus", family: "claude", used: 50, limit: 100 },
      { model: "Claude Opus", family: "claude", used: 10, limit: 100 },
    ],
  };

  const mapping: UsageQuotaMapping = {
    kind: "quota",
    id: "model",
    label: "Model",
    unit: "tokens",
    each: { path: "limits", idPath: "model", labelPath: "model", groupPath: "family" },
    usedPath: "used",
    limitPath: "limit",
  };

  test("emits one reading per element with unique ids, suffixed labels and per-element groups", () => {
    const readings = project([mapping], buckets);

    expect(readings.map((reading) => reading.id)).toEqual([
      "model-gpt-5-codex",
      "model-claude-opus",
      "model-claude-opus-2",
    ]);
    expect(readings.map((reading) => reading.label)).toEqual([
      "Model · GPT-5 Codex",
      "Model · Claude Opus",
      "Model · Claude Opus",
    ]);
    expect(readings.map((reading) => reading.group)).toEqual(["codex", "claude", "claude"]);
    expect(readings.map((reading) => reading.kind)).toEqual(["quota", "quota", "quota"]);
  });

  test("keeps ids distinct when a de-collision suffix collides with another slug", () => {
    const collide = {
      limits: [{ model: "a-2" }, { model: "a" }, { model: "a" }],
    };

    expect(project([mapping], collide).map((reading) => reading.id)).toEqual([
      "model-a-2",
      "model-a",
      "model-a-3",
    ]);
  });

  test("resolves every other path relative to the element", () => {
    expect(project([mapping], buckets)[0]).toMatchObject({
      used: 120,
      limit: 400,
      remaining: 280,
      percent: 30,
    });
  });

  test("falls back to index-based identity and the mapping group", () => {
    const bare: UsageBalanceMapping = {
      kind: "balance",
      id: "wallet",
      label: "Wallet",
      group: "billing",
      unit: "usd",
      each: { path: "wallets" },
      remainingPath: "amount",
    };

    expect(project([bare], { wallets: [{ amount: 4 }, { amount: 9 }] })).toEqual([
      {
        kind: "balance",
        id: "wallet-0",
        label: "Wallet 1",
        group: "billing",
        unit: "usd",
        remaining: 4,
        total: null,
        percentRemaining: null,
        currency: null,
      },
      {
        kind: "balance",
        id: "wallet-1",
        label: "Wallet 2",
        group: "billing",
        unit: "usd",
        remaining: 9,
        total: null,
        percentRemaining: null,
        currency: null,
      },
    ]);
  });

  // Z.ai's `limits` array names each window only by the unit it is measured
  // in, so a preset filters one element out by `where` and names it itself.
  // Numbering that lone reading "Session 1" would imply a second.
  test("keeps the mapping's own id and label when a filter leaves one unnamed element", () => {
    const session: UsageQuotaMapping = {
      kind: "quota",
      id: "session",
      label: "Session",
      unit: "percent",
      each: { path: "limits", where: { path: "unit", equals: 3 } },
      percentPath: "percentage",
    };
    const document = {
      limits: [
        { unit: 3, percentage: 25 },
        { unit: 6, percentage: 9 },
      ],
    };
    expect(project([session], document)).toMatchObject([
      { id: "session", label: "Session", percent: 25 },
    ]);
  });

  test("still numbers a lone unnamed element when the array is unfiltered", () => {
    const bare: UsageBalanceMapping = {
      kind: "balance",
      id: "wallet",
      label: "Wallet",
      unit: "usd",
      each: { path: "wallets" },
      remainingPath: "amount",
    };
    // One element today may be two tomorrow, and the id must not change under
    // the first when the second arrives; only a `where` filter promises one.
    expect(project([bare], { wallets: [{ amount: 4 }] })).toMatchObject([
      { id: "wallet-0", label: "Wallet 1", remaining: 4 },
    ]);
  });

  test("yields nothing when the each path is missing or not an array", () => {
    expect(project([mapping], { other: [] })).toEqual([]);
    expect(project([mapping], { limits: { model: "GPT-5 Codex" } })).toEqual([]);
    expect(project([mapping], null)).toEqual([]);
  });
});

describe("projectReadings each where", () => {
  /**
   * The recorded Anthropic `limits[]` shape: per-model scoped weekly limits are
   * mixed in with the plain session and weekly ones, which carry no scope, so
   * projecting the whole array rendered the same numbers twice.
   */
  const anthropic = {
    limits: [
      { kind: "session", percent: 27, resets_at: "2026-08-29T15:19:59.000Z" },
      { kind: "weekly_all", percent: 17, resets_at: "2026-08-29T15:59:59.000Z" },
      {
        kind: "weekly_scoped",
        percent: 0,
        resets_at: "2026-08-29T15:59:59.000Z",
        scope: { model: { display_name: "Fable" }, surface: null },
      },
    ],
  };

  const scoped: UsageQuotaMapping = {
    kind: "quota",
    id: "scoped-weekly",
    label: "Weekly",
    unit: "tokens",
    each: {
      path: "limits",
      idPath: "scope.model.display_name",
      labelPath: "scope.model.display_name",
      where: { path: "kind", equals: "weekly_scoped" },
    },
    percentPath: "percent",
    window: { label: "Weekly", resetsAtPath: "resets_at" },
  };

  test("keeps only the elements the filter matches", () => {
    expect(project([scoped], anthropic)).toEqual([
      {
        kind: "quota",
        id: "scoped-weekly-fable",
        label: "Weekly · Fable",
        group: null,
        unit: "tokens",
        window: { label: "Weekly", resetsAt: "2026-08-29T15:59:59.000Z", durationMs: null },
        used: null,
        limit: null,
        remaining: null,
        percent: 0,
      },
    ]);
  });

  test("numbers the id and label fallbacks over the filtered list", () => {
    const unlabelled = {
      limits: [
        { kind: "session", percent: 27 },
        { kind: "weekly_scoped", percent: 4 },
        { kind: "weekly_all", percent: 17 },
        { kind: "weekly_scoped", percent: 9 },
      ],
    };
    const readings = project([scoped], unlabelled);

    expect(readings.map((reading) => reading.id)).toEqual(["scoped-weekly-0", "scoped-weekly-1"]);
    expect(readings.map((reading) => reading.label)).toEqual(["Weekly 1", "Weekly 2"]);
  });

  test("excludes an element that does not carry the filter path", () => {
    const partial = {
      limits: [{ percent: 27 }, { kind: "weekly_scoped", percent: 4 }],
    };

    expect(project([scoped], partial)).toMatchObject([{ id: "scoped-weekly-0", percent: 4 }]);
  });

  test("yields no readings when the filter matches nothing", () => {
    expect(project([scoped], { limits: [{ kind: "session", percent: 27 }] })).toEqual([]);
  });

  test("matches a numeric equals against a vendor's quoted number", () => {
    const quoted: UsageQuotaMapping = {
      ...scoped,
      each: { path: "limits", where: { path: "tier", equals: 2 } },
    };
    const document = {
      limits: [
        { tier: "1", percent: 10 },
        { tier: "2", percent: 20 },
        { tier: 2, percent: 30 },
      ],
    };

    expect(project([quoted], document)).toMatchObject([{ percent: 20 }, { percent: 30 }]);
  });

  test("matches a boolean equals strictly", () => {
    const activeOnly: UsageQuotaMapping = {
      ...scoped,
      each: { path: "limits", where: { path: "active", equals: true } },
    };
    const document = {
      limits: [
        { active: true, percent: 10 },
        { active: false, percent: 20 },
        { active: "true", percent: 30 },
      ],
    };

    expect(project([activeOnly], document)).toMatchObject([{ percent: 10 }]);
  });
});

describe("projectReadings rate via schedule", () => {
  const offPeak: UsageRateSchedule = {
    timeZone: "UTC",
    windows: [
      { label: "Off-peak", start: "00:30", end: "08:30", multiplier: 0.5, detail: "Half price" },
    ],
    defaultLabel: "Standard",
    defaultMultiplier: 1,
  };

  function scheduleMapping(schedule: UsageRateSchedule): UsageRateMapping {
    return {
      kind: "rate",
      id: "pricing",
      label: "Pricing",
      resolution: { via: "schedule", schedule },
    };
  }

  test("reports the active window and its end as changesAt", () => {
    const readings = project([scheduleMapping(offPeak)], {}, new Date("2026-08-27T03:15:20.000Z"));

    expect(readings).toEqual([
      {
        kind: "rate",
        id: "pricing",
        label: "Pricing",
        group: null,
        state: "Off-peak",
        multiplier: 0.5,
        detail: "Half price",
        changesAt: "2026-08-27T08:30:00.000Z",
      },
    ]);
  });

  test("falls back to the schedule default and the next window start", () => {
    expect(
      project([scheduleMapping(offPeak)], {}, new Date("2026-08-27T12:00:00.000Z"))[0],
    ).toEqual({
      kind: "rate",
      id: "pricing",
      label: "Pricing",
      group: null,
      state: "Standard",
      multiplier: 1,
      detail: null,
      changesAt: "2026-08-28T00:30:00.000Z",
    });
  });

  test("handles a window that wraps past midnight", () => {
    const night: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [{ label: "Night", start: "22:00", end: "06:00", multiplier: 0.4 }],
      defaultLabel: "Day",
      defaultMultiplier: 1,
    };

    expect(
      project([scheduleMapping(night)], {}, new Date("2026-08-27T23:30:00.000Z"))[0],
    ).toMatchObject({
      state: "Night",
      multiplier: 0.4,
      detail: null,
      changesAt: "2026-08-28T06:00:00.000Z",
    });
    expect(
      project([scheduleMapping(night)], {}, new Date("2026-08-27T02:00:00.000Z"))[0],
    ).toMatchObject({ state: "Night", changesAt: "2026-08-27T06:00:00.000Z" });
    expect(
      project([scheduleMapping(night)], {}, new Date("2026-08-27T10:00:00.000Z"))[0],
    ).toMatchObject({ state: "Day", multiplier: 1, changesAt: "2026-08-27T22:00:00.000Z" });
  });

  test("resolves a spring-forward boundary against the offset in force at the boundary", () => {
    const morning: UsageRateSchedule = {
      timeZone: "America/New_York",
      windows: [{ label: "Off-peak", start: "03:30", end: "08:30", multiplier: 0.5 }],
      defaultLabel: "Standard",
      defaultMultiplier: 1,
    };

    // 01:30 EST, before the 02:00 -> 03:00 jump: 03:30 local is 07:30Z under EDT,
    // not the 08:30Z that adding wall-clock minutes to the UTC instant produces.
    expect(
      project([scheduleMapping(morning)], {}, new Date("2026-03-08T06:30:00.000Z"))[0],
    ).toMatchObject({ state: "Standard", changesAt: "2026-03-08T07:30:00.000Z" });
  });

  test("moves an active band's end past a wall time the spring-forward jump skips", () => {
    const overnight: UsageRateSchedule = {
      timeZone: "America/New_York",
      windows: [{ label: "Night", start: "22:00", end: "02:30", multiplier: 0.4 }],
      defaultLabel: "Day",
      defaultMultiplier: 1,
    };

    // 02:30 local never happens on this date, so the boundary is the instant the
    // clock jumps to: 03:30 EDT.
    expect(
      project([scheduleMapping(overnight)], {}, new Date("2026-03-08T05:00:00.000Z"))[0],
    ).toMatchObject({ state: "Night", changesAt: "2026-03-08T07:30:00.000Z" });
  });

  test("resolves a fall-back boundary for an active band and an idle schedule", () => {
    const overnight: UsageRateSchedule = {
      timeZone: "America/New_York",
      windows: [{ label: "Night", start: "22:00", end: "02:00", multiplier: 0.4 }],
      defaultLabel: "Day",
      defaultMultiplier: 1,
    };
    const business: UsageRateSchedule = {
      timeZone: "America/New_York",
      windows: [{ label: "Business hours", start: "09:00", end: "17:00", multiplier: 2 }],
      defaultLabel: "Overnight",
      defaultMultiplier: 1,
    };

    // 00:00 EDT on the fall-back date: 02:00 local arrives as EST, at 07:00Z.
    expect(
      project([scheduleMapping(overnight)], {}, new Date("2026-11-01T04:00:00.000Z"))[0],
    ).toMatchObject({ state: "Night", changesAt: "2026-11-01T07:00:00.000Z" });
    // 23:00 EDT the evening before: the next 09:00 local is 11 hours away, not 10.
    expect(
      project([scheduleMapping(business)], {}, new Date("2026-11-01T03:00:00.000Z"))[0],
    ).toMatchObject({ state: "Overnight", changesAt: "2026-11-01T14:00:00.000Z" });
  });

  test("picks the nearest upcoming start when several windows are configured", () => {
    const split: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [
        { label: "Morning", start: "06:00", end: "09:00" },
        { label: "Evening", start: "18:00", end: "21:00" },
      ],
      defaultLabel: "Standard",
      defaultMultiplier: 1,
    };

    expect(
      project([scheduleMapping(split)], {}, new Date("2026-08-27T12:00:00.000Z"))[0],
    ).toMatchObject({ state: "Standard", changesAt: "2026-08-27T18:00:00.000Z" });
    expect(
      project([scheduleMapping(split)], {}, new Date("2026-08-27T22:00:00.000Z"))[0],
    ).toMatchObject({ state: "Standard", changesAt: "2026-08-28T06:00:00.000Z" });
  });

  test("evaluates wall clock in the declared time zone", () => {
    const tokyo: UsageRateSchedule = {
      timeZone: "Asia/Tokyo",
      windows: [{ label: "Business hours", start: "09:00", end: "18:00", multiplier: 2 }],
      defaultLabel: "Overnight",
      defaultMultiplier: 1,
    };

    expect(
      project([scheduleMapping(tokyo)], {}, new Date("2026-08-27T01:00:00.000Z"))[0],
    ).toMatchObject({
      state: "Business hours",
      multiplier: 2,
      changesAt: "2026-08-27T09:00:00.000Z",
    });
    expect(
      project([scheduleMapping(tokyo)], {}, new Date("2026-08-27T20:00:00.000Z"))[0],
    ).toMatchObject({ state: "Overnight", changesAt: "2026-08-28T00:00:00.000Z" });
  });

  test("ignores a window on a weekday it does not apply to", () => {
    // DeepSeek's current peak: weekdays only, so a weekend reading must not
    // announce peak pricing.
    const deepseek: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [
        { label: "Peak", start: "01:00", end: "04:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
        { label: "Peak", start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
      ],
      defaultLabel: "Off-peak",
      defaultMultiplier: 1,
    };

    expect(
      project([scheduleMapping(deepseek)], {}, new Date("2026-08-26T02:00:00.000Z"))[0],
    ).toMatchObject({ state: "Peak", multiplier: 2, changesAt: "2026-08-26T04:00:00.000Z" });
    expect(
      project([scheduleMapping(deepseek)], {}, new Date("2026-08-30T02:00:00.000Z"))[0],
    ).toMatchObject({ state: "Off-peak", multiplier: 1 });
  });

  test("points changesAt at the next day a weekday-only window actually begins", () => {
    const deepseek: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [
        { label: "Peak", start: "01:00", end: "04:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
        { label: "Peak", start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
      ],
      defaultLabel: "Off-peak",
      defaultMultiplier: 1,
    };

    // Saturday: the next start is Monday's 01:00, two days out, not tomorrow's.
    expect(
      project([scheduleMapping(deepseek)], {}, new Date("2026-08-29T12:00:00.000Z"))[0],
    ).toMatchObject({ state: "Off-peak", changesAt: "2026-08-31T01:00:00.000Z" });
    // Friday after the last band closes: tomorrow is excluded, so Monday again.
    expect(
      project([scheduleMapping(deepseek)], {}, new Date("2026-08-28T11:00:00.000Z"))[0],
    ).toMatchObject({ state: "Off-peak", changesAt: "2026-08-31T01:00:00.000Z" });
    // Wednesday between the two bands: later the same day.
    expect(
      project([scheduleMapping(deepseek)], {}, new Date("2026-08-26T05:00:00.000Z"))[0],
    ).toMatchObject({ state: "Off-peak", changesAt: "2026-08-26T06:00:00.000Z" });
  });

  test("keeps a midnight-wrapping weekday window active into an excluded next day", () => {
    const weeknights: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [
        {
          label: "Weeknight",
          start: "22:00",
          end: "06:00",
          days: [1, 2, 3, 4, 5],
          multiplier: 0.5,
        },
      ],
      defaultLabel: "Standard",
      defaultMultiplier: 1,
    };

    // Friday 23:00: the band begins on a day it applies to.
    expect(
      project([scheduleMapping(weeknights)], {}, new Date("2026-08-28T23:00:00.000Z"))[0],
    ).toMatchObject({ state: "Weeknight", changesAt: "2026-08-29T06:00:00.000Z" });
    // Saturday 03:00: still the band that began Friday, though Saturday is excluded.
    expect(
      project([scheduleMapping(weeknights)], {}, new Date("2026-08-29T03:00:00.000Z"))[0],
    ).toMatchObject({ state: "Weeknight", changesAt: "2026-08-29T06:00:00.000Z" });
    // Saturday 07:00: past the end, and Saturday starts nothing.
    expect(
      project([scheduleMapping(weeknights)], {}, new Date("2026-08-29T07:00:00.000Z"))[0],
    ).toMatchObject({ state: "Standard", changesAt: "2026-08-31T22:00:00.000Z" });
    // Sunday 03:00: Saturday began nothing, so no band is running.
    expect(
      project([scheduleMapping(weeknights)], {}, new Date("2026-08-30T03:00:00.000Z"))[0],
    ).toMatchObject({ state: "Standard" });
  });

  test("reads the weekday from the schedule's zone, not the host's", () => {
    const mondays: UsageRateSchedule = {
      timeZone: "Asia/Tokyo",
      windows: [{ label: "Monday deal", start: "00:00", end: "06:00", days: [1], multiplier: 0.5 }],
      defaultLabel: "Standard",
      defaultMultiplier: 1,
    };

    // 2026-08-30T15:30Z is Sunday in UTC but already Monday 00:30 in Tokyo.
    expect(
      project([scheduleMapping(mondays)], {}, new Date("2026-08-30T15:30:00.000Z"))[0],
    ).toMatchObject({ state: "Monday deal", changesAt: "2026-08-30T21:00:00.000Z" });
    // An hour earlier is still Sunday 23:30 in Tokyo, so the band has not opened.
    expect(
      project([scheduleMapping(mondays)], {}, new Date("2026-08-30T14:30:00.000Z"))[0],
    ).toMatchObject({ state: "Standard", changesAt: "2026-08-30T15:00:00.000Z" });
  });

  test("inherits the schedule multiplier when a window omits its own", () => {
    const plain: UsageRateSchedule = {
      timeZone: "UTC",
      windows: [{ label: "Surge", start: "08:00", end: "20:00" }],
      defaultLabel: "Standard",
      defaultMultiplier: 1.5,
    };

    expect(
      project([scheduleMapping(plain)], {}, new Date("2026-08-27T09:00:00.000Z"))[0],
    ).toMatchObject({ state: "Surge", multiplier: 1.5 });
  });
});

describe("projectReadings rate via response", () => {
  test("reads state, multiplier, changesAt and detail from the document", () => {
    const mapping: UsageRateMapping = {
      kind: "rate",
      id: "pricing",
      label: "Pricing",
      resolution: {
        via: "response",
        statePath: "rate.state",
        multiplierPath: "rate.multiplier",
        changesAtPath: "rate.until",
        detailPath: "rate.note",
      },
    };

    expect(
      project([mapping], {
        rate: { state: "Peak", multiplier: 2, until: 1_800_000_000, note: "Double rate" },
      }),
    ).toEqual([
      {
        kind: "rate",
        id: "pricing",
        label: "Pricing",
        group: null,
        state: "Peak",
        multiplier: 2,
        changesAt: "2027-01-15T08:00:00.000Z",
        detail: "Double rate",
      },
    ]);
  });

  test("reports an unresolved state as Unknown", () => {
    const mapping: UsageRateMapping = {
      kind: "rate",
      id: "pricing",
      label: "Pricing",
      resolution: { via: "response", statePath: "rate.state" },
    };

    expect(project([mapping], {})[0]).toMatchObject({
      state: "Unknown",
      multiplier: null,
      changesAt: null,
      detail: null,
    });
  });
});

describe("requiresSourceDocument", () => {
  const scheduleRate: UsageRateMapping = {
    kind: "rate",
    id: "pricing",
    label: "Pricing",
    resolution: {
      via: "schedule",
      schedule: {
        timeZone: "UTC",
        windows: [{ label: "Off-peak", start: "00:30", end: "08:30" }],
        defaultLabel: "Standard",
        defaultMultiplier: 1,
      },
    },
  };
  const responseRate: UsageRateMapping = {
    kind: "rate",
    id: "pricing",
    label: "Pricing",
    resolution: { via: "response", statePath: "state" },
  };
  const quota: UsageQuotaMapping = {
    kind: "quota",
    id: "session",
    label: "Session",
    unit: "tokens",
    usedPath: "used",
  };

  test("is false when every reading is a schedule-resolved rate", () => {
    expect(requiresSourceDocument([scheduleRate, scheduleRate])).toBe(false);
  });

  test("is true when any reading needs the response", () => {
    expect(requiresSourceDocument([scheduleRate, quota])).toBe(true);
    expect(requiresSourceDocument([responseRate])).toBe(true);
  });
});
