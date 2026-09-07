import { formatUsageAmount } from "./amount.shared";
import type {
  UsageBalanceReading,
  UsageDisplay,
  UsagePillMatchRule,
  UsageProviderSnapshot,
  UsageQuotaReading,
  UsageReading,
  UsageWindow,
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

/**
 * A provider is on the dashboard unless it says otherwise, so a config written
 * before the rail existed keeps every card it had.
 */
export function isDashboardVisible(display: UsageDisplay | undefined): boolean {
  return display?.dashboard !== false;
}

/**
 * Which agents a preset's pill belongs above, as `harness` or `harness:vendor`.
 *
 * A harness reports itself as the agent's provider and its models as
 * `vendor/model`, so one vendor is one entry here. The vendor namespaces are
 * per harness and do not agree with each other: the same Kimi subscription is
 * `kimi` under omp, `kimi-coding` under pi and `kimi-for-coding` under
 * opencode. Every entry below was read off a real catalog — omp's
 * `~/.omp/agent/models.db` and its binary, pi's bundled `models.generated.js`,
 * opencode's models.dev cache — rather than guessed from a vendor's name.
 *
 * A vendor whose usage no endpoint reports (cloud-billed accounts, header-only
 * rate limits, console-only plans) has no preset, so it appears nowhere here.
 * Presets that exist only as reading ids inside a probe (`gemini-5h`,
 * `premium`) name no provider and get no rules either.
 */
const SUGGESTED_MATCH_SPECS: Record<string, readonly string[]> = {
  claude: ["claude", "omp:anthropic", "pi:anthropic", "opencode:anthropic"],
  "claude-statusline": ["claude", "omp:anthropic", "pi:anthropic", "opencode:anthropic"],
  codex: [
    "codex",
    "omp:openai-codex",
    "omp:openai",
    "pi:openai-codex",
    "pi:openai",
    "opencode:openai",
  ],
  "github-copilot": [
    "copilot",
    "omp:github-copilot",
    "pi:github-copilot",
    "opencode:github-copilot",
  ],
  antigravity: ["omp:google-antigravity", "opencode:google-agy"],
  cursor: ["cursor", "omp:cursor"],
  grok: ["omp:grok"],
  xai: ["omp:xai", "pi:xai", "opencode:xai"],
  deepseek: ["omp:deepseek", "pi:deepseek", "opencode:deepseek"],
  "deepseek-rate": ["omp:deepseek", "pi:deepseek", "opencode:deepseek"],
  kimi: ["omp:kimi", "pi:kimi-coding", "opencode:kimi-for-coding"],
  moonshot: ["omp:moonshot", "pi:moonshotai", "opencode:moonshotai"],
  "moonshot-cn": ["pi:moonshotai-cn", "opencode:moonshotai-cn"],
  minimax: [
    "omp:minimax",
    "omp:minimax-code",
    "pi:minimax",
    "opencode:minimax",
    "opencode:minimax-coding-plan",
  ],
  "minimax-cn": [
    "omp:minimax-cn",
    "omp:minimax-code-cn",
    "pi:minimax-cn",
    "opencode:minimax-cn",
    "opencode:minimax-cn-coding-plan",
  ],
  // `zai` is this catalogue's alias for the same Coding Plan preset.
  "zai-coding-plan": [
    "omp:zai",
    "omp:zai-coding-plan",
    "pi:zai",
    "opencode:zai",
    "opencode:zai-coding-plan",
  ],
  zai: ["omp:zai", "omp:zai-coding-plan", "pi:zai", "opencode:zai", "opencode:zai-coding-plan"],
  "zhipuai-coding-plan": [
    "omp:zhipuai-coding-plan",
    "opencode:zhipuai",
    "opencode:zhipuai-coding-plan",
  ],
  "opencode-go": ["omp:opencode-go", "pi:opencode-go", "opencode:opencode-go"],
  "opencode-zen": ["omp:opencode-zen", "pi:opencode", "opencode:opencode"],
  openrouter: ["omp:openrouter", "pi:openrouter", "opencode:openrouter"],
  "openrouter-credits": ["omp:openrouter", "pi:openrouter", "opencode:openrouter"],
  vercel: ["omp:vercel-ai-gateway", "pi:vercel-ai-gateway", "opencode:vercel"],
  siliconflow: ["omp:siliconflow", "opencode:siliconflow"],
  "siliconflow-cn": ["omp:siliconflow-cn", "opencode:siliconflow-cn"],
  stepfun: ["omp:stepfun", "opencode:stepfun"],
  "stepfun-ai": ["opencode:stepfun-ai"],
  novita: ["omp:novita", "opencode:novita-ai"],
  deepinfra: ["omp:deepinfra", "opencode:deepinfra"],
  chutes: ["omp:chutes", "opencode:chutes"],
  synthetic: ["omp:synthetic", "opencode:synthetic"],
  zenmux: ["omp:zenmux", "opencode:zenmux"],
  venice: ["omp:venice", "opencode:venice"],
  "nano-gpt": ["omp:nanogpt", "omp:nano-gpt", "opencode:nano-gpt"],
  poe: ["opencode:poe"],
};

/** Suggested mappings become explicit config only when the user selects matching. */
export function getDefaultPillMatchRules(presetOrProviderId: string): UsagePillMatchRule[] {
  const specs = SUGGESTED_MATCH_SPECS[presetOrProviderId.trim().toLowerCase()] ?? [];
  return specs.map((spec) => {
    const separator = spec.indexOf(":");
    if (separator < 0) return { harness: spec };
    return { harness: spec.slice(0, separator), provider: spec.slice(separator + 1) };
  });
}

/** The host calls the harness `provider`; the model's first segment names its vendor. */
export function matchesPillSelection(
  pill: UsageDisplay["pill"],
  selection: { provider: string | null; model: string | null },
): boolean {
  if (!pill?.enabled) {
    return false;
  }
  if (pill.visibility !== "matching") {
    return true;
  }
  const harness = selection.provider?.toLowerCase() ?? null;
  const qualifiedModel = selection.model?.toLowerCase() ?? null;
  const separator = qualifiedModel?.indexOf("/") ?? -1;
  const provider =
    qualifiedModel !== null && separator >= 0 ? qualifiedModel.slice(0, separator) : null;
  const model =
    qualifiedModel !== null && separator >= 0
      ? qualifiedModel.slice(separator + 1)
      : qualifiedModel;
  return (pill.matchRules ?? []).some((rule) => {
    if (rule.harness === undefined && rule.provider === undefined && rule.model === undefined) {
      return false;
    }
    if (rule.harness !== undefined && rule.harness.toLowerCase() !== harness) {
      return false;
    }
    if (rule.provider !== undefined && rule.provider.toLowerCase() !== provider) {
      return false;
    }
    if (rule.model !== undefined) {
      if (model === null) {
        return false;
      }
      const pattern = rule.model.toLowerCase();
      if (!pattern.includes("*")) {
        return pattern === model;
      }
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(model);
    }
    return true;
  });
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

export interface UsageWindowRow {
  id: string;
  /** "Weekly", "Weekly · Fable", "Credits". */
  name: string;
  readout: string;
  percentUsed: number | null;
  percentFilled: number | null;
  window: UsageWindow | null;
}

const QUOTA_ROW_SETTINGS: ResolvedPillSettings = {
  order: null,
  style: "bar",
  value: "used",
  reading: null,
  label: "none",
  readout: "percent",
};

const BALANCE_ROW_SETTINGS: ResolvedPillSettings = {
  ...QUOTA_ROW_SETTINGS,
  value: "remaining",
  readout: "amount",
};

/**
 * The windows a card lists beneath its headline, one row each, skipping the
 * one the headline already states. A quota reads as consumption because that
 * is what runs out; a balance reads as what is left, because "75% used" of a
 * credit account buries the number that matters.
 *
 * A row is named from its reading, not from its window. Claude scopes a second
 * weekly allowance to one model and calls both windows "Weekly", so naming by
 * window printed "Weekly" twice and hid which was which.
 */
export function usageWindowRows(
  readings: readonly UsageReading[],
  skipReadingId: string | null,
): UsageWindowRow[] {
  const rows: UsageWindowRow[] = [];
  for (const reading of readings) {
    if (reading.id === skipReadingId || !isPillReading(reading)) {
      continue;
    }
    const settings = reading.kind === "balance" ? BALANCE_ROW_SETTINGS : QUOTA_ROW_SETTINGS;
    const metrics = pillMetrics(reading, settings);
    if (metrics.readout === null) {
      continue;
    }
    const suffix =
      reading.kind === "balance" ? " left" : metrics.percentUsed === null ? "" : " used";
    rows.push({
      id: reading.id,
      name: reading.label.trim() === "" ? (metrics.windowLabel ?? reading.id) : reading.label,
      readout: `${metrics.readout}${suffix}`,
      percentUsed: metrics.percentUsed,
      percentFilled: metrics.percentFilled,
      window: reading.kind === "quota" ? reading.window : null,
    });
  }
  return rows;
}

export interface ComposerPillEntry {
  providerId: string;
  providerLabel: string;
  settings: ResolvedPillSettings;
  pill: UsageDisplay["pill"];
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
      pill: provider.display.pill,
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
