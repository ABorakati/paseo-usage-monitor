import { describe, expect, test } from "vitest";
import {
  type UsageBalanceReading,
  type UsageDisplay,
  type UsagePillDisplay,
  UsagePillDisplaySchema,
  type UsageProviderSnapshot,
  type UsageQuotaReading,
  type UsageRateReading,
} from "./limits.shared";
import {
  composerPillId,
  isDashboardVisible,
  pillMetrics,
  type ResolvedPillSettings,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
} from "./pills.shared";

const FIVE_HOURS_MS = 18_000_000;
const SEVEN_DAYS_MS = 604_800_000;

function pill(overrides: Partial<UsagePillDisplay> = {}): UsagePillDisplay {
  return { enabled: true, label: "provider", readout: "percent", ...overrides };
}

describe("pill defaults", () => {
  test("an opted-in pill shows its gauge and number, and no text", () => {
    expect(UsagePillDisplaySchema.parse({ enabled: true })).toEqual({
      enabled: true,
      label: "none",
      readout: "percent",
    });
  });

  test("a provider keeps its dashboard card unless it says otherwise", () => {
    expect(isDashboardVisible(undefined)).toBe(true);
    expect(isDashboardVisible({})).toBe(true);
    expect(isDashboardVisible({ dashboard: true })).toBe(true);
    expect(isDashboardVisible({ dashboard: false })).toBe(false);
  });
});

/** Metrics only run for an opted-in pill, so the fixture proves that once here. */
function settings(
  overrides: Partial<UsagePillDisplay> = {},
  card: UsageDisplay = {},
): ResolvedPillSettings {
  const resolved = resolvePillSettings({ ...card, pill: pill(overrides) });
  if (resolved === null) {
    throw new Error("pill fixture must opt in");
  }
  return resolved;
}

function quota(overrides: Partial<UsageQuotaReading> = {}): UsageQuotaReading {
  return {
    kind: "quota",
    id: "session",
    label: "Session",
    group: null,
    unit: "tokens",
    window: { label: "Session", resetsAt: "2026-09-07T18:00:00.000Z", durationMs: FIVE_HOURS_MS },
    used: 2_500,
    limit: 10_000,
    remaining: 7_500,
    percent: 25,
    ...overrides,
  };
}

function balance(overrides: Partial<UsageBalanceReading> = {}): UsageBalanceReading {
  return {
    kind: "balance",
    id: "credits",
    label: "Credits",
    group: null,
    unit: "usd",
    remaining: 12.5,
    total: 50,
    percentRemaining: 25,
    currency: "USD",
    ...overrides,
  };
}

function rate(overrides: Partial<UsageRateReading> = {}): UsageRateReading {
  return {
    kind: "rate",
    id: "peak",
    label: "Peak",
    group: null,
    state: "off-peak",
    multiplier: 0.5,
    changesAt: null,
    detail: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<UsageProviderSnapshot> = {}): UsageProviderSnapshot {
  return {
    providerId: "claude",
    label: "Claude",
    description: null,
    unverified: false,
    status: "ok",
    readings: [quota()],
    error: null,
    fetchedAt: "2026-09-07T13:00:00.000Z",
    notice: null,
    display: {},
    icon: null,
    ...overrides,
  };
}

describe("resolvePillSettings", () => {
  test("keeps a provider off the rail until it opts in", () => {
    expect(resolvePillSettings(undefined)).toBeNull();
    expect(resolvePillSettings({})).toBeNull();
    expect(resolvePillSettings({ pill: pill({ enabled: false }) })).toBeNull();
  });

  test("inherits the card's style, direction, and order", () => {
    const display: UsageDisplay = {
      order: 3,
      style: "ring",
      value: "remaining",
      pill: pill(),
    };

    expect(resolvePillSettings(display)).toEqual({
      order: 3,
      style: "ring",
      value: "remaining",
      reading: null,
      label: "provider",
      readout: "percent",
    });
  });

  test("pill fields override the card they would otherwise inherit", () => {
    const display: UsageDisplay = {
      order: 3,
      style: "ring",
      value: "remaining",
      pill: pill({ order: 1, style: "none", value: "used", reading: "weekly", readout: "amount" }),
    };

    expect(resolvePillSettings(display)).toMatchObject({
      order: 1,
      style: "none",
      value: "used",
      reading: "weekly",
      readout: "amount",
    });
  });

  test("a card with no style of its own draws a bar, and consumption is the default direction", () => {
    expect(resolvePillSettings({ pill: pill() })).toMatchObject({
      style: "bar",
      value: "used",
      order: null,
    });
  });
});

describe("selectPillReading", () => {
  test("tracks the shortest quota window, so the session figure wins over the weekly one", () => {
    const session = quota({
      id: "session",
      window: { label: "Session", resetsAt: null, durationMs: FIVE_HOURS_MS },
    });
    const weekly = quota({
      id: "weekly",
      window: { label: "Weekly", resetsAt: null, durationMs: SEVEN_DAYS_MS },
    });

    expect(selectPillReading([weekly, session], null)).toBe(session);
  });

  test("a pinned reading id beats the window rule", () => {
    const session = quota({ id: "session" });
    const weekly = quota({
      id: "weekly",
      window: { label: "Weekly", resetsAt: null, durationMs: SEVEN_DAYS_MS },
    });

    expect(selectPillReading([session, weekly], "weekly")).toBe(weekly);
  });

  test("an id that names no reading falls back to the window rule instead of showing nothing", () => {
    const session = quota({ id: "session" });

    expect(selectPillReading([session], "gone")).toBe(session);
  });

  test("a windowless quota still qualifies", () => {
    const windowless = quota({ id: "requests", window: null });

    expect(selectPillReading([windowless], null)).toBe(windowless);
  });

  test("skips a reading whose vendor publishes no ceiling when another can be measured", () => {
    const uncapped = quota({ id: "requests", window: null, percent: null, used: 106, limit: null });
    const pool = quota({
      id: "bucket-weekly",
      window: { label: "Window", resetsAt: null, durationMs: null },
      used: null,
      limit: null,
      remaining: null,
      percent: 23.7,
    });

    expect(selectPillReading([uncapped, pool], null)).toBe(pool);
  });

  test("without published window durations it shows whichever pool is closest to running out", () => {
    const idle = quota({
      id: "bucket-gemini-5h",
      window: { label: "Window", resetsAt: null, durationMs: null },
      used: null,
      limit: null,
      remaining: null,
      percent: 0,
    });
    const burning = quota({
      id: "bucket-gemini-weekly",
      window: { label: "Window", resetsAt: null, durationMs: null },
      used: null,
      limit: null,
      remaining: null,
      percent: 23.7,
    });

    expect(selectPillReading([idle, burning], null)).toBe(burning);
  });

  test("a published window still beats a higher percentage with no duration", () => {
    const session = quota({
      id: "session",
      window: { label: "Session", resetsAt: null, durationMs: FIVE_HOURS_MS },
      percent: 4,
    });
    const pool = quota({
      id: "pool",
      window: { label: "Window", resetsAt: null, durationMs: null },
      percent: 60,
    });

    expect(selectPillReading([pool, session], null)).toBe(session);
  });

  test("an unmeasurable reading is still shown when it is all the provider has", () => {
    const uncapped = quota({ id: "requests", window: null, percent: null, used: 106, limit: null });

    expect(selectPillReading([uncapped], null)).toBe(uncapped);
  });

  test("a provider with no quota falls back to its balance", () => {
    const credits = balance();

    expect(selectPillReading([rate(), credits], null)).toBe(credits);
  });

  test("a schedule-only provider has nothing a pill can draw", () => {
    expect(selectPillReading([rate()], null)).toBeNull();
    expect(selectPillReading([], null)).toBeNull();
  });
});

describe("pillMetrics quota", () => {
  test("reports consumption and draws it when the pill counts what is used", () => {
    expect(pillMetrics(quota(), settings())).toMatchObject({
      percentUsed: 25,
      percentFilled: 25,
      readout: "25%",
      windowLabel: "Session",
      resetsAt: "2026-09-07T18:00:00.000Z",
    });
  });

  test("inverts only the geometry and the number, never the tone input", () => {
    expect(pillMetrics(quota(), settings({ value: "remaining" }))).toMatchObject({
      percentUsed: 25,
      percentFilled: 75,
      readout: "75%",
    });
  });

  test("derives a missing percent from used against the limit", () => {
    const reading = quota({ percent: null, used: 3_500, remaining: null });

    expect(pillMetrics(reading, settings())).toMatchObject({
      percentUsed: 35,
      percentFilled: 35,
      readout: "35%",
    });
  });

  test("derives a missing percent from what is left when nothing reports consumption", () => {
    const reading = quota({ percent: null, used: null, remaining: 2_000 });

    expect(pillMetrics(reading, settings())).toMatchObject({ percentUsed: 80, readout: "80%" });
  });

  test("no ceiling means no gauge, and the amount stands in for the percentage", () => {
    const metrics = pillMetrics(quota({ percent: null, limit: 0, remaining: null }), settings());

    expect(metrics.percentUsed).toBeNull();
    expect(metrics.percentFilled).toBeNull();
    expect(metrics.readout).toBe("2,500");
  });

  test("a reading with neither a ceiling nor an amount has nothing to say", () => {
    const blank = quota({ percent: null, used: null, limit: null, remaining: null });

    expect(pillMetrics(blank, settings()).readout).toBeNull();
  });

  test("an amount readout shows the side the pill counts", () => {
    expect(pillMetrics(quota(), settings({ readout: "amount" })).readout).toBe("2,500");
    expect(pillMetrics(quota(), settings({ readout: "amount", value: "remaining" })).readout).toBe(
      "7,500",
    );
  });

  test("a suppressed readout leaves the gauge to speak alone", () => {
    expect(pillMetrics(quota(), settings({ readout: "none" }))).toMatchObject({
      percentFilled: 25,
      readout: null,
    });
  });
});

describe("pillMetrics balance", () => {
  test("turns a remaining balance into consumption so the tone matches a quota's", () => {
    expect(pillMetrics(balance(), settings())).toMatchObject({
      percentUsed: 75,
      percentFilled: 75,
      readout: "75%",
    });
  });

  test("carries no window, because a balance does not reset", () => {
    expect(pillMetrics(balance(), settings())).toMatchObject({
      windowLabel: null,
      resetsAt: null,
    });
  });

  test("an amount readout keeps the currency and spends against the starting total", () => {
    const left = settings({ readout: "amount", value: "remaining" });
    const spent = settings({ readout: "amount" });

    expect(pillMetrics(balance(), left).readout).toBe("$12.50");
    expect(pillMetrics(balance(), spent).readout).toBe("$37.50");
  });

  test("spend is unknowable without a starting total", () => {
    const spent = settings({ readout: "amount" });

    expect(pillMetrics(balance({ total: null }), spent).readout).toBeNull();
  });

  test("derives consumption from the amounts when no percentage is published", () => {
    const reading = balance({ percentRemaining: null, remaining: 10, total: 40 });

    expect(pillMetrics(reading, settings({ value: "remaining" }))).toMatchObject({
      percentUsed: 75,
      percentFilled: 25,
    });
  });
});

describe("selectComposerPills", () => {
  test("returns only providers that opted in", () => {
    const entries = selectComposerPills([
      snapshot({ providerId: "claude", display: { pill: pill() } }),
      snapshot({ providerId: "codex", display: {} }),
    ]);

    expect(entries.map((entry) => entry.providerId)).toEqual(["claude"]);
  });

  test("drops a provider switched off entirely", () => {
    const entries = selectComposerPills([
      snapshot({ providerId: "claude", status: "disabled", display: { pill: pill() } }),
    ]);

    expect(entries).toEqual([]);
  });

  test("keeps a failing provider on the rail, because a watched quota must not vanish", () => {
    const entries = selectComposerPills([
      snapshot({
        providerId: "claude",
        status: "error",
        readings: [],
        error: "401 Unauthorized",
        display: { pill: pill() },
      }),
    ]);

    expect(entries).toHaveLength(1);
  });

  test("orders by the configured position, then by id, with unordered pills last", () => {
    const entries = selectComposerPills([
      snapshot({ providerId: "zai", display: { pill: pill() } }),
      snapshot({ providerId: "codex", display: { pill: pill({ order: 2 }) } }),
      snapshot({ providerId: "claude", display: { pill: pill({ order: 1 }) } }),
      snapshot({ providerId: "grok", display: { pill: pill() } }),
    ]);

    expect(entries.map((entry) => entry.providerId)).toEqual(["claude", "codex", "grok", "zai"]);
  });

  test("carries the provider's label so a pill can name itself without a second lookup", () => {
    const entries = selectComposerPills([
      snapshot({ providerId: "claude", label: "Claude", display: { pill: pill() } }),
    ]);

    expect(entries[0]).toMatchObject({ providerId: "claude", providerLabel: "Claude" });
  });
});

describe("composerPillId", () => {
  test("namespaces a provider id into the host's contribution id grammar", () => {
    expect(composerPillId("zai-coding-plan")).toBe("usage-zai-coding-plan");
    expect(composerPillId("claude")).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
