/**
 * Pure classification of a failed turn or assistant message as a usage-limit
 * refusal. Shared by the daemon hook (records the alert) and the chat
 * transformer (swaps the raw error for the callout), so both agree on what
 * counts as a limit.
 *
 * Provider wording, from the agent CLIs as observed in Paseo's own e2e tests
 * (`/hit your limit|rate limit|quota|credits/i`) and the vendors' docs:
 *   - Claude Code: "You've hit your limit · resets 3pm (Europe/London)",
 *     "Claude usage limit reached. Your limit will reset at 3pm (UTC)",
 *     `rate_limit_error`, HTTP 429.
 *   - Codex: "You've hit your usage limit. Try again at …",
 *     "usage_limit_reached", "insufficient_quota".
 *   - Gemini / Antigravity: "RESOURCE_EXHAUSTED", "Quota exceeded",
 *     "429 Too Many Requests".
 *   - Copilot: "quota exceeded", "premium requests".
 *   - DeepSeek: "Insufficient Balance" with HTTP 402.
 *   - OpenRouter: "Insufficient credits", HTTP 402.
 *   - Moonshot: "exceeded balance", "account balance is insufficient", "余额不足".
 *   - MiniMax: "insufficient balance", `base_resp.status_code: 1008`.
 *   - Z.AI: "balance is insufficient".
 *   - xAI: "used all available credits", "reached its monthly spending limit".
 *   - OpenAI API: "exceeded your current quota", "billing hard limit".
 */

export interface LimitDetection {
  /** ISO instant parsed out of the text, or null when the text names none. */
  resetsAt: string | null;
  /** The sentence that matched, trimmed and cut to a readable length. */
  message: string;
}

const LIMIT_PATTERNS: readonly RegExp[] = [
  /hit your (?:usage )?limit/i,
  /usage limit (?:reached|exceeded|hit)/i,
  /usage_limit_reached/i,
  /rate[ _-]?limit(?:ed|_error| exceeded| reached)?/i,
  /too many requests/i,
  /\b429\b/,
  /resource_exhausted/i,
  /quota (?:exceeded|exhausted|reached|limit)/i,
  /insufficient[ _](?:quota|balance|credits|funds)/i,
  /(?:out of|no remaining|exhausted your) (?:credits|quota|tokens)/i,
  /credits? (?:exhausted|depleted|balance is)/i,
  /premium requests? (?:limit|exhausted|used up)/i,
  // Pay-as-you-go vendors refuse a turn over money rather than a window, and
  // every one of them reports it as HTTP 402 Payment Required.
  /balance is insufficient/i,
  /exceeded (?:your )?(?:account )?balance/i,
  /余额不足/,
  /payment required/i,
  /\b402\b/,
  /billing hard limit/i,
  /exceeded your current quota/i,
  /used all available credits/i,
  /available credits/i,
  /monthly spending limit/i,
  // MiniMax answers with `base_resp.status_code: 1008`; the bare code is not
  // enough, because 1008 covers other refusals on that API too.
  /status_code"?\s*:\s*1008\b/i,
];

/**
 * The refusals that are about money rather than a window. Only these can be
 * classified from the wording alone: a window refusal names the window, not the
 * reason, so the vendor behind it has to be looked up.
 */
const BALANCE_WORDINGS =
  /insufficient[ _](?:balance|credits|funds)|balance is (?:too )?(?:low|insufficient)|exceeded (?:your )?(?:account )?balance|余额不足|payment required|\b402\b|billing hard limit|used all available credits|available credits|monthly spending limit|out of credits|exceeded your current quota/i;

/** Phrases that mention limits without being one: context windows, token caps. */
const FALSE_POSITIVE_PATTERNS: readonly RegExp[] = [
  /context (?:window|length|limit)/i,
  /max(?:imum)? (?:output )?tokens/i,
  /token limit/i,
  /prompt is too long/i,
];

const MESSAGE_LIMIT = 280;

/**
 * "resets 3pm (Europe/London)", "reset at 15:00", "try again at 3:30pm",
 * "resets in 2 hours 15 minutes", "retry after 45 seconds".
 */
const RELATIVE_PATTERN =
  /(?:resets?|retry|try again|available)\s+(?:in|after)\s+((?:\d+\s*(?:h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\s*)+)/i;
const CLOCK_PATTERN =
  /(?:resets?|reset at|try again at|available at|until)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;
const ISO_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

function parseRelative(text: string, now: Date): string | null {
  const match = RELATIVE_PATTERN.exec(text);
  if (!match) return null;
  let ms = 0;
  for (const part of (match[1] ?? "").matchAll(/(\d+)\s*(h|m|s)/gi)) {
    const value = Number(part[1]);
    const unit = (part[2] ?? "").toLowerCase();
    ms += unit === "h" ? value * 3_600_000 : unit === "m" ? value * 60_000 : value * 1_000;
  }
  return ms > 0 ? new Date(now.getTime() + ms).toISOString() : null;
}

/**
 * A wall-clock time with no date is the next occurrence of that time. A named
 * zone in parentheses is honoured through Intl; an unknown zone falls back to
 * the local clock rather than failing the whole detection.
 */
function parseClock(text: string, now: Date): string | null {
  const match = CLOCK_PATTERN.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (!meridiem && !match[2]) return null;
  if (hours > 23 || minutes > 59) return null;

  const zone = match[4]?.trim();
  const candidate = zonedTimeToday(now, hours, minutes, zone);
  if (!candidate) return null;
  if (candidate.getTime() <= now.getTime()) {
    candidate.setTime(candidate.getTime() + 86_400_000);
  }
  return candidate.toISOString();
}

function zonedTimeToday(
  now: Date,
  hours: number,
  minutes: number,
  zone: string | undefined,
): Date | null {
  if (!zone) {
    const local = new Date(now);
    local.setHours(hours, minutes, 0, 0);
    return local;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const zoneNow = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
    );
    const offsetMs = zoneNow - Math.floor(now.getTime() / 60_000) * 60_000;
    const target = Date.UTC(read("year"), read("month") - 1, read("day"), hours, minutes);
    return new Date(target - offsetMs);
  } catch {
    const local = new Date(now);
    local.setHours(hours, minutes, 0, 0);
    return local;
  }
}

export function parseResetInstant(text: string, now: Date = new Date()): string | null {
  const iso = ISO_PATTERN.exec(text);
  if (iso) {
    const parsed = new Date(iso[1] ?? "");
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed.toISOString();
    }
  }
  return parseRelative(text, now) ?? parseClock(text, now);
}

/**
 * The vendor's own `"message"` when the text is an error envelope — Google's
 * 429 arrives as a multi-line JSON blob whose readable sentence sits inside
 * `error.message` — else the line the pattern matched on.
 */
function excerpt(text: string, index: number): string {
  const embedded = /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(text);
  let chosen: string;
  if (embedded?.[1]) {
    chosen = embedded[1].replace(/\\(.)/g, "$1");
  } else {
    const start = Math.max(0, text.lastIndexOf("\n", index) + 1);
    const end = text.indexOf("\n", index);
    chosen = text.slice(start, end === -1 ? undefined : end).trim();
  }
  return chosen.length > MESSAGE_LIMIT ? `${chosen.slice(0, MESSAGE_LIMIT - 1)}…` : chosen;
}

/**
 * Null when the text is not a usage-limit refusal. The returned message is the
 * matching line, so a long tool transcript with one limit sentence in it
 * yields that sentence, not the transcript.
 */
export function detectUsageLimit(text: string, now: Date = new Date()): LimitDetection | null {
  if (!text) return null;
  if (FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    const strong =
      /hit your (?:usage )?limit|usage_limit_reached|resource_exhausted|insufficient_quota|insufficient[ _](?:balance|credits|funds)|balance is insufficient|exceeded (?:your )?(?:account )?balance|payment required|\b402\b|billing hard limit|exceeded your current quota|available credits|余额不足/i;
    if (!strong.test(text)) return null;
  }
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    return {
      resetsAt: parseResetInstant(text, now),
      message: excerpt(text, match.index),
    };
  }
  return null;
}

/**
 * A money refusal says so in words ("Insufficient Balance", "payment
 * required"); a window refusal rarely does. So the only kind readable from the
 * text alone is `balance`, and everything else returns null and is decided from
 * the agent's provider and model instead.
 */
export function limitKindFromText(text: string): LimitKind | null {
  return BALANCE_WORDINGS.test(text) ? "balance" : null;
}

/**
 * How a vendor's limit behaves. `quota` is a window that resets, so waiting for
 * it is an answer; `balance` is prepaid money or credits, so only a top-up is.
 */
export const LIMIT_KINDS = ["quota", "balance"] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/**
 * One vendor's pages, keyed by usage-monitor preset id: a preset is one
 * vendor's own numbers, so its id names the vendor. Two vendors the plugin
 * tracks no card for (`anthropic`, `openai`) still carry a page, because the
 * harnesses run every vendor the same way and the reader still needs a link.
 */
interface VendorSpec {
  /** Vendor id; the primary preset id when the plugin tracks this vendor. */
  id: string;
  /** Every preset id that names this vendor, aliases included. */
  presets: readonly string[];
  /** The preset whose card tracks these numbers, or null when none does. */
  trackedBy: string | null;
  label: string;
  kind: LimitKind;
  /** Where the account's usage, balance or plan is shown. */
  usageUrl: string | null;
  /** Where credit is bought; null when the vendor has nothing to top up. */
  topUpUrl: string | null;
  /** Model-id prefixes, as the multi-provider harnesses print them. */
  modelPrefixes: readonly RegExp[];
  /** Paseo agent provider ids that resolve straight to this vendor. */
  agentProviders: readonly string[];
}

/**
 * A page is listed only where the vendor publishes one. A guessed URL would
 * send the reader somewhere that may not exist, which is worse than a callout
 * with no link at all, so a vendor whose console page is unconfirmed carries
 * null and the callout offers the actions that need no URL.
 *
 * The subscription vendors carry no top-up page: their windows refill on their
 * own and no purchase moves them. The API vendors are the other way round —
 * nothing resets, so `topUpUrl` is the only action that unblocks them.
 */
const VENDOR_SPECS: readonly VendorSpec[] = [
  {
    id: "anthropic",
    presets: [],
    trackedBy: "claude",
    label: "Anthropic API",
    kind: "balance",
    usageUrl: "https://console.anthropic.com/settings/limits",
    topUpUrl: "https://console.anthropic.com/settings/billing",
    modelPrefixes: [/^anthropic\//i],
    agentProviders: [],
  },
  {
    id: "openai",
    presets: [],
    trackedBy: null,
    label: "OpenAI API",
    kind: "balance",
    usageUrl: "https://platform.openai.com/usage",
    topUpUrl: "https://platform.openai.com/settings/organization/billing/overview",
    modelPrefixes: [/^openai\//i],
    agentProviders: [],
  },
  {
    id: "google",
    presets: [],
    trackedBy: null,
    label: "Google AI",
    kind: "quota",
    usageUrl: "https://aistudio.google.com/usage",
    topUpUrl: null,
    modelPrefixes: [/^google\//i],
    agentProviders: ["gemini"],
  },
  {
    id: "claude",
    presets: ["claude", "claude-statusline"],
    trackedBy: "claude",
    label: "Claude",
    kind: "quota",
    usageUrl: "https://claude.ai/settings/usage",
    topUpUrl: null,
    modelPrefixes: [],
    agentProviders: ["claude"],
  },
  {
    id: "codex",
    presets: ["codex"],
    trackedBy: "codex",
    label: "Codex",
    kind: "quota",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
    topUpUrl: null,
    modelPrefixes: [/^openai-codex\//i],
    agentProviders: ["codex"],
  },
  {
    id: "antigravity",
    presets: ["antigravity"],
    trackedBy: "antigravity",
    label: "Antigravity",
    kind: "quota",
    usageUrl: "https://antigravity.google/",
    topUpUrl: null,
    modelPrefixes: [/^google-antigravity\//i],
    agentProviders: ["antigravity", "antigravity-acp", "antigravity-official"],
  },
  {
    id: "github-copilot",
    presets: ["github-copilot"],
    trackedBy: "github-copilot",
    label: "GitHub Copilot",
    kind: "quota",
    usageUrl: "https://github.com/settings/copilot/features",
    topUpUrl: null,
    modelPrefixes: [],
    agentProviders: ["copilot", "github-copilot"],
  },
  {
    id: "cursor",
    presets: ["cursor"],
    trackedBy: "cursor",
    label: "Cursor",
    kind: "quota",
    usageUrl: "https://cursor.com/dashboard",
    topUpUrl: null,
    modelPrefixes: [/^cursor\//i],
    agentProviders: ["cursor"],
  },
  {
    id: "grok",
    presets: ["grok"],
    trackedBy: "grok",
    label: "Grok",
    kind: "quota",
    usageUrl: "https://grok.com/?_s=usage",
    topUpUrl: null,
    modelPrefixes: [/^grok\//i],
    agentProviders: ["grok"],
  },
  {
    id: "kimi",
    presets: ["kimi"],
    trackedBy: "kimi",
    label: "Kimi",
    kind: "quota",
    usageUrl: "https://www.kimi.com/code",
    topUpUrl: null,
    modelPrefixes: [/^kimi\//i],
    agentProviders: [],
  },
  {
    id: "minimax",
    presets: ["minimax"],
    trackedBy: "minimax",
    label: "MiniMax",
    kind: "quota",
    usageUrl: "https://platform.minimax.io/user-center/payment/balance",
    topUpUrl: null,
    modelPrefixes: [/^minimax\//i],
    agentProviders: [],
  },
  {
    id: "minimax-cn",
    presets: ["minimax-cn"],
    trackedBy: "minimax-cn",
    label: "MiniMax (CN)",
    kind: "quota",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^minimax-cn\//i],
    agentProviders: [],
  },
  {
    id: "zai-coding-plan",
    presets: ["zai-coding-plan", "zai"],
    trackedBy: "zai-coding-plan",
    label: "Z.ai",
    kind: "quota",
    usageUrl: "https://z.ai/manage-apikey/billing",
    topUpUrl: null,
    modelPrefixes: [/^z-ai\//i, /^zai\//i],
    agentProviders: [],
  },
  {
    id: "zhipuai-coding-plan",
    presets: ["zhipuai-coding-plan"],
    trackedBy: "zhipuai-coding-plan",
    label: "Zhipu Coding Plan",
    kind: "quota",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^zhipu\//i],
    agentProviders: [],
  },
  {
    id: "synthetic",
    presets: ["synthetic"],
    trackedBy: "synthetic",
    label: "Synthetic",
    kind: "quota",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^synthetic\//i],
    agentProviders: [],
  },
  {
    id: "opencode-go",
    presets: ["opencode-go"],
    trackedBy: "opencode-go",
    label: "OpenCode Go",
    kind: "quota",
    usageUrl: "https://opencode.ai/go",
    topUpUrl: null,
    modelPrefixes: [/^opencode-go\//i],
    agentProviders: [],
  },
  {
    id: "chutes",
    presets: ["chutes"],
    trackedBy: "chutes",
    label: "Chutes",
    kind: "quota",
    usageUrl: "https://chutes.ai/app/api/billing-balance",
    topUpUrl: null,
    modelPrefixes: [/^chutes\//i],
    agentProviders: [],
  },
  {
    id: "zenmux",
    presets: ["zenmux"],
    trackedBy: "zenmux",
    label: "ZenMux",
    kind: "quota",
    usageUrl: "https://zenmux.ai/platform/cost",
    topUpUrl: null,
    modelPrefixes: [/^zenmux\//i],
    agentProviders: [],
  },
  {
    id: "deepseek",
    presets: ["deepseek", "deepseek-rate"],
    trackedBy: "deepseek",
    label: "DeepSeek",
    kind: "balance",
    usageUrl: "https://platform.deepseek.com/usage",
    topUpUrl: "https://platform.deepseek.com/top_up",
    modelPrefixes: [/^deepseek\//i],
    agentProviders: ["deepseek"],
  },
  {
    id: "moonshot",
    presets: ["moonshot"],
    trackedBy: "moonshot",
    label: "Moonshot",
    kind: "balance",
    usageUrl: "https://platform.kimi.ai/console",
    topUpUrl: "https://platform.kimi.ai/console/pay",
    modelPrefixes: [/^moonshot\//i],
    agentProviders: [],
  },
  {
    id: "moonshot-cn",
    presets: ["moonshot-cn"],
    trackedBy: "moonshot-cn",
    label: "Moonshot (CN)",
    kind: "balance",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^moonshot-cn\//i],
    agentProviders: [],
  },
  {
    id: "siliconflow",
    presets: ["siliconflow"],
    trackedBy: "siliconflow",
    label: "SiliconFlow",
    kind: "balance",
    usageUrl: "https://cloud.siliconflow.com/bills",
    topUpUrl: "https://cloud.siliconflow.com/bills",
    modelPrefixes: [/^siliconflow\//i],
    agentProviders: [],
  },
  {
    id: "siliconflow-cn",
    presets: ["siliconflow-cn"],
    trackedBy: "siliconflow-cn",
    label: "SiliconFlow (CN)",
    kind: "balance",
    usageUrl: "https://cloud.siliconflow.cn/bills",
    topUpUrl: "https://cloud.siliconflow.cn/bills",
    modelPrefixes: [/^siliconflow-cn\//i],
    agentProviders: [],
  },
  {
    id: "stepfun-ai",
    presets: ["stepfun-ai"],
    trackedBy: "stepfun-ai",
    label: "StepFun",
    kind: "balance",
    usageUrl: "https://platform.stepfun.ai/account-overview",
    topUpUrl: null,
    modelPrefixes: [/^stepfun-ai\//i, /^stepfun\//i],
    agentProviders: [],
  },
  {
    id: "stepfun",
    presets: ["stepfun"],
    trackedBy: "stepfun",
    label: "StepFun (CN)",
    kind: "balance",
    usageUrl: "https://platform.stepfun.com/account-overview",
    topUpUrl: null,
    modelPrefixes: [],
    agentProviders: [],
  },
  {
    id: "novita",
    presets: ["novita"],
    trackedBy: "novita",
    label: "Novita",
    kind: "balance",
    usageUrl: "https://novita.ai/billing",
    topUpUrl: "https://novita.ai/billing",
    modelPrefixes: [/^novita\//i],
    agentProviders: [],
  },
  {
    id: "deepinfra",
    presets: ["deepinfra"],
    trackedBy: "deepinfra",
    label: "DeepInfra",
    kind: "balance",
    usageUrl: "https://deepinfra.com/dash/billing",
    topUpUrl: "https://deepinfra.com/dash/billing",
    modelPrefixes: [/^deepinfra\//i],
    agentProviders: [],
  },
  {
    id: "venice",
    presets: ["venice"],
    trackedBy: "venice",
    label: "Venice",
    kind: "balance",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^venice\//i],
    agentProviders: [],
  },
  {
    id: "xai",
    presets: ["xai"],
    trackedBy: "xai",
    label: "xAI",
    kind: "balance",
    usageUrl: "https://console.x.ai/",
    topUpUrl: "https://console.x.ai/",
    modelPrefixes: [/^xai\//i],
    agentProviders: ["xai"],
  },
  {
    id: "nano-gpt",
    presets: ["nano-gpt"],
    trackedBy: "nano-gpt",
    label: "NanoGPT",
    kind: "balance",
    usageUrl: "https://nano-gpt.com/balance",
    topUpUrl: "https://nano-gpt.com/balance",
    modelPrefixes: [/^nano-gpt\//i],
    agentProviders: [],
  },
  {
    id: "poe",
    presets: ["poe"],
    trackedBy: "poe",
    label: "Poe",
    kind: "balance",
    usageUrl: "https://poe.com/settings",
    topUpUrl: "https://poe.com/subscription_plans",
    modelPrefixes: [/^poe\//i],
    agentProviders: [],
  },
  {
    id: "openrouter",
    presets: ["openrouter", "openrouter-credits"],
    trackedBy: "openrouter",
    label: "OpenRouter",
    kind: "balance",
    usageUrl: "https://openrouter.ai/activity",
    topUpUrl: "https://openrouter.ai/credits",
    modelPrefixes: [/^openrouter\//i],
    agentProviders: [],
  },
  {
    id: "vercel",
    presets: ["vercel"],
    trackedBy: "vercel",
    label: "Vercel AI Gateway",
    kind: "balance",
    usageUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway",
    topUpUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway",
    modelPrefixes: [/^vercel\//i],
    agentProviders: [],
  },
  {
    id: "opencode-zen",
    presets: ["opencode-zen"],
    trackedBy: "opencode-zen",
    label: "OpenCode Zen",
    kind: "balance",
    usageUrl: null,
    topUpUrl: null,
    modelPrefixes: [/^opencode-zen\//i],
    agentProviders: [],
  },
];

/** A vendor's pages and shape, as the callout and the server consume them. */
export interface LimitVendor {
  /** Vendor id; a usage-monitor preset id when the plugin tracks the vendor. */
  id: string;
  /** The preset whose card tracks this vendor's numbers, or null. */
  presetId: string | null;
  label: string;
  kind: LimitKind;
  usageUrl: string | null;
  topUpUrl: string | null;
}

/** Every usage-monitor preset id, and the vendor pages that answer to it. */
export const VENDORS: Readonly<Record<string, LimitVendor>> = (() => {
  const table: Record<string, LimitVendor> = {};
  for (const spec of VENDOR_SPECS) {
    const vendor: LimitVendor = {
      id: spec.id,
      presetId: spec.trackedBy,
      label: spec.label,
      kind: spec.kind,
      usageUrl: spec.usageUrl,
      topUpUrl: spec.topUpUrl,
    };
    table[spec.id] = vendor;
    for (const presetId of spec.presets) table[presetId] = vendor;
  }
  return table;
})();

/**
 * `omp`, `pi` and `opencode` run many vendors, so the model id
 * (`google-antigravity/gemini-3.8-flash`, `deepseek/deepseek-flash`) is what
 * says who ran out. The model is asked first because it is the narrower fact;
 * a harness's own provider id is the fallback for a single-vendor harness.
 */
function vendorFor(agentProvider: string, model: string | null): VendorSpec | null {
  if (model !== null && model.includes("/")) {
    for (const spec of VENDOR_SPECS) {
      if (spec.modelPrefixes.some((pattern) => pattern.test(model))) return spec;
    }
  }
  for (const spec of VENDOR_SPECS) {
    if (spec.agentProviders.includes(agentProvider)) return spec;
  }
  let named = agentProvider;
  if (model !== null) {
    const separator = model.indexOf("/");
    if (separator > 0) named = model.slice(0, separator);
  }
  return VENDOR_SPECS.find((spec) => spec.id === named || spec.presets.includes(named)) ?? null;
}

/** The vendor's own name for the callout heading, or null when none is implied. */
export function vendorLabelFor(agentProvider: string, model: string | null): string | null {
  return vendorFor(agentProvider, model)?.label ?? null;
}

/**
 * The usage-monitor provider whose card tracks this agent's quota, so the
 * callout can borrow a reset window the error text did not name. Null when no
 * preset id is implied.
 */
export function usageProviderIdFor(agentProvider: string, model: string | null): string | null {
  return vendorFor(agentProvider, model)?.trackedBy ?? null;
}

/** Where the user manages the quota or balance that ran out. */
export function resetUrlFor(agentProvider: string, model: string | null): string | null {
  return vendorFor(agentProvider, model)?.usageUrl ?? null;
}

/** Where the user buys credit; null when the vendor has no such page. */
export function topUpUrlFor(agentProvider: string, model: string | null): string | null {
  return vendorFor(agentProvider, model)?.topUpUrl ?? null;
}

/** Whether the refusal is a resetting window or a spent balance. */
export function limitKindFor(agentProvider: string, model: string | null): LimitKind | null {
  return vendorFor(agentProvider, model)?.kind ?? null;
}
