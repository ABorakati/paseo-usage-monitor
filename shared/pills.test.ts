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
  getDefaultPillMatchRules,
  isDashboardVisible,
  matchesPillSelection,
  pillMetrics,
  type ResolvedPillSettings,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
  usageWindowRows,
} from "./pills.shared";

const FIVE_HOURS_MS = 18_000_000;
const SEVEN_DAYS_MS = 604_800_000;

function pill(overrides: Partial<UsagePillDisplay> = {}): UsagePillDisplay {
  return {
    enabled: true,
    visibility: "always",
    label: "provider",
    readout: "percent",
    ...overrides,
  };
}

describe("pill defaults", () => {
  test("existing enabled config keeps its manual visibility with no match rules", () => {
    const existing = UsagePillDisplaySchema.parse({ enabled: true });
    expect(matchesPillSelection(existing, { provider: "omp", model: null })).toBe(true);
    expect(
      matchesPillSelection(UsagePillDisplaySchema.parse({}), {
        provider: "claude",
        model: null,
      }),
    ).toBe(false);
  });

  test("a provider keeps its dashboard card unless it says otherwise", () => {
    expect(isDashboardVisible(undefined)).toBe(true);
    expect(isDashboardVisible({})).toBe(true);
    expect(isDashboardVisible({ dashboard: true })).toBe(true);
    expect(isDashboardVisible({ dashboard: false })).toBe(false);
  });
});

describe("pill selection rules", () => {
  test("requires every field within a rule and accepts any matching rule", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: [{ harness: "claude" }, { harness: "omp", provider: "openai", model: "gpt-6*" }],
    });
    expect(matchesPillSelection(matching, { provider: "CLAUDE", model: null })).toBe(true);
    expect(matchesPillSelection(matching, { provider: "OMP", model: "OpenAI/GPT-6-mini" })).toBe(
      true,
    );
    expect(matchesPillSelection(matching, { provider: "codex", model: "openai/gpt-6" })).toBe(
      false,
    );
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai/gpt-5" })).toBe(false);
    expect(matchesPillSelection(matching, { provider: "omp", model: "other/gpt-6" })).toBe(false);
  });

  test("does not confuse a GPT model name with an OpenAI vendor", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: getDefaultPillMatchRules("codex"),
    });
    expect(matchesPillSelection(matching, { provider: "codex", model: null })).toBe(true);
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai/gpt-6" })).toBe(true);
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai-codex/gpt-6" })).toBe(
      true,
    );
    expect(matchesPillSelection(matching, { provider: "omp", model: "github-copilot/gpt-6" })).toBe(
      false,
    );
    expect(
      matchesPillSelection(matching, { provider: "omp", model: "openrouter/openai/gpt-6" }),
    ).toBe(false);
    expect(matchesPillSelection(matching, { provider: "omp", model: "gpt-6" })).toBe(false);
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai-custom/gpt-6" })).toBe(
      false,
    );
  });

  test("treats regex punctuation literally and only asterisk as a wildcard", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: [{ model: "gpt-6.0+(fast)[v2]?*" }],
    });
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "vendor/GPT-6.0+(FAST)[V2]?mini",
      }),
    ).toBe(true);
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "gpt-6.0+(fast)[v2]?",
      }),
    ).toBe(true);
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "gpt-6X000fastv2mini",
      }),
    ).toBe(false);
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "prefix-gpt-6.0+(fast)[v2]?mini",
      }),
    ).toBe(false);
  });

  test("harness and provider accept the same wildcard the model field always had", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: [{ harness: "op*", provider: "*router" }],
    });
    expect(
      matchesPillSelection(matching, { provider: "opencode", model: "openrouter/gpt-6" }),
    ).toBe(true);
    expect(matchesPillSelection(matching, { provider: "omp", model: "openrouter/gpt-6" })).toBe(
      false,
    );
  });

  test("a pipe tries each alternative across every field", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: [{ provider: "anthropic | claude", model: "gpt-6|gpt-6-mini" }],
    });
    expect(matchesPillSelection(matching, { provider: "omp", model: "claude/gpt-6" })).toBe(true);
    expect(matchesPillSelection(matching, { provider: "omp", model: "anthropic/gpt-6-mini" })).toBe(
      true,
    );
    expect(matchesPillSelection(matching, { provider: "omp", model: "claude/gpt-7" })).toBe(false);
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai/gpt-6" })).toBe(false);
  });

  test("matches the entire model part, including segments after the first slash", () => {
    const matching = pill({
      visibility: "matching",
      matchRules: [{ provider: "openrouter", model: "openai/gpt-6" }],
    });
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "openrouter/openai/gpt-6",
      }),
    ).toBe(true);
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "openrouter/gpt-6",
      }),
    ).toBe(false);
    expect(
      matchesPillSelection(matching, {
        provider: "omp",
        model: "openrouter/openai/gpt-6-mini",
      }),
    ).toBe(false);
  });

  test("null models cannot satisfy a provider or model rule, including wildcard", () => {
    const selection = { provider: "omp", model: null };
    expect(
      matchesPillSelection(
        pill({
          visibility: "matching",
          matchRules: [{ provider: "openai" }, { model: "*" }],
        }),
        selection,
      ),
    ).toBe(false);
    expect(
      matchesPillSelection(
        pill({
          visibility: "matching",
          matchRules: [{ harness: "omp" }],
        }),
        selection,
      ),
    ).toBe(true);
  });

  test("missing and explicitly empty rules match nothing without preset fallback", () => {
    const selection = { provider: "claude", model: "claude-sonnet" };
    expect(matchesPillSelection(pill({ visibility: "matching" }), selection)).toBe(false);
    expect(
      matchesPillSelection(
        pill({
          visibility: "matching",
          matchRules: [],
        }),
        selection,
      ),
    ).toBe(false);
    expect(getDefaultPillMatchRules("custom-provider")).toEqual([]);
    expect(
      matchesPillSelection(
        pill({
          visibility: "matching",
          matchRules: getDefaultPillMatchRules("claude"),
        }),
        selection,
      ),
    ).toBe(true);
  });

  test("a suggestion follows one subscription across every harness that sells it", () => {
    const kimi = pill({ visibility: "matching", matchRules: getDefaultPillMatchRules("kimi") });
    expect(matchesPillSelection(kimi, { provider: "omp", model: "kimi/k2-thinking" })).toBe(true);
    expect(matchesPillSelection(kimi, { provider: "pi", model: "kimi-coding/k3" })).toBe(true);
    expect(
      matchesPillSelection(kimi, { provider: "opencode", model: "kimi-for-coding/k2.7-code" }),
    ).toBe(true);
    // Moonshot's pay-as-you-go API is a different account from a Kimi plan.
    expect(matchesPillSelection(kimi, { provider: "pi", model: "moonshotai/kimi-k2.6" })).toBe(
      false,
    );
    // Each harness spells the vendor its own way and only its own way.
    expect(matchesPillSelection(kimi, { provider: "omp", model: "kimi-coding/k3" })).toBe(false);
  });

  test("suggestions keep mainland and global gateways apart", () => {
    const global = pill({
      visibility: "matching",
      matchRules: getDefaultPillMatchRules("minimax"),
    });
    const mainland = pill({
      visibility: "matching",
      matchRules: getDefaultPillMatchRules("minimax-cn"),
    });
    const cnSelection = { provider: "opencode", model: "minimax-cn/MiniMax-M2.5" };
    const globalSelection = { provider: "omp", model: "minimax-code/MiniMax-M2.5" };
    expect(matchesPillSelection(mainland, cnSelection)).toBe(true);
    expect(matchesPillSelection(global, cnSelection)).toBe(false);
    expect(matchesPillSelection(global, globalSelection)).toBe(true);
    expect(matchesPillSelection(mainland, globalSelection)).toBe(false);
  });

  test("opencode's own two products are suggested apart, by vendor not model name", () => {
    const go = pill({
      visibility: "matching",
      matchRules: getDefaultPillMatchRules("opencode-go"),
    });
    const zen = pill({
      visibility: "matching",
      matchRules: getDefaultPillMatchRules("opencode-zen"),
    });
    // The same model id is sold under both, so only the vendor segment decides.
    const shared = "deepseek-v4-flash";
    expect(matchesPillSelection(go, { provider: "opencode", model: `opencode-go/${shared}` })).toBe(
      true,
    );
    expect(
      matchesPillSelection(zen, { provider: "opencode", model: `opencode-go/${shared}` }),
    ).toBe(false);
    expect(matchesPillSelection(zen, { provider: "opencode", model: `opencode/${shared}` })).toBe(
      true,
    );
    expect(matchesPillSelection(go, { provider: "opencode", model: `opencode/${shared}` })).toBe(
      false,
    );
  });

  test("a probe's reading ids are not providers and suggest nothing", () => {
    expect(getDefaultPillMatchRules("gemini-5h")).toEqual([]);
    expect(getDefaultPillMatchRules("premium")).toEqual([]);
    expect(getDefaultPillMatchRules("antigravity")).not.toEqual([]);
  });

  test("manual always overrides rules while the master switch overrides both modes", () => {
    const selection = { provider: "claude", model: null };
    expect(matchesPillSelection(pill({ visibility: "always", matchRules: [] }), selection)).toBe(
      true,
    );
    expect(
      matchesPillSelection(
        pill({
          enabled: false,
          visibility: "always",
        }),
        selection,
      ),
    ).toBe(false);
    expect(
      matchesPillSelection(
        pill({
          enabled: false,
          visibility: "matching",
          matchRules: [{ harness: "claude" }],
        }),
        selection,
      ),
    ).toBe(false);
    expect(matchesPillSelection(undefined, selection)).toBe(false);
  });

  test("rejects empty rules and blank fields while normalizing surrounding whitespace", () => {
    expect(UsagePillDisplaySchema.safeParse({ matchRules: [{}] }).success).toBe(false);
    expect(
      UsagePillDisplaySchema.safeParse({
        matchRules: [{ harness: "omp", provider: "  " }],
      }).success,
    ).toBe(false);
    const matching = UsagePillDisplaySchema.parse({
      enabled: true,
      visibility: "matching",
      matchRules: [{ harness: " OMP ", provider: " OpenAI ", model: " GPT-6* " }],
    });
    expect(matchesPillSelection(matching, { provider: "omp", model: "openai/gpt-6" })).toBe(true);
  });
});

test("a composer without a selected harness cannot satisfy a harness rule", () => {
  const selection = { provider: null, model: null };
  expect(
    matchesPillSelection(
      pill({
        visibility: "matching",
        matchRules: [{ harness: "claude" }],
      }),
      selection,
    ),
  ).toBe(false);
  expect(matchesPillSelection(pill({ visibility: "always" }), selection)).toBe(true);
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
    authRefreshCommand: null,
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

describe("usageWindowRows", () => {
  test("tells two same-window readings apart by their own labels", () => {
    const rows = usageWindowRows(
      [
        quota({ id: "weekly", label: "Weekly", percent: 39 }),
        quota({ id: "scoped-weekly-scoped", label: "Weekly · Fable", percent: 60 }),
      ],
      null,
    );

    expect(rows.map((row) => `${row.name} ${row.readout}`)).toEqual([
      "Weekly 39% used",
      "Weekly · Fable 60% used",
    ]);
  });

  test("skips the reading the headline already states", () => {
    const rows = usageWindowRows([quota({ id: "session" }), quota({ id: "weekly" })], "session");

    expect(rows.map((row) => row.id)).toEqual(["weekly"]);
  });

  test("carries the geometry each row needs to draw its own bar", () => {
    const [row] = usageWindowRows([quota({ id: "weekly", percent: 39 })], null);

    expect(row).toMatchObject({ percentUsed: 39, percentFilled: 39 });
    expect(row?.window).toMatchObject({ label: "Session" });
  });

  test("a balance states what is left, not what is spent", () => {
    const rows = usageWindowRows([balance()], null);

    expect(rows[0]?.readout).toBe("$12.50 left");
  });

  test("a schedule has no window to draw and is left out", () => {
    expect(usageWindowRows([rate()], null)).toEqual([]);
  });

  test("a reading with no number at all is left out rather than shown empty", () => {
    const blank = quota({ id: "blank", percent: null, used: null, limit: null, remaining: null });

    expect(usageWindowRows([blank], null)).toEqual([]);
  });
});
