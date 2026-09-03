import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * A usage provider describes, declaratively, how to read quota state out of
 * some vendor: where to get a JSON document (HTTP endpoint or local command),
 * which credential unlocks it, and which paths inside the response carry the
 * used/limit/reset values.
 *
 * Everything is data, so a provider Paseo has never heard of can be added by
 * editing the plugin's config file instead of shipping code.
 *
 * Vendors do not all measure the same thing, so a provider reports a list of
 * readings in one of three shapes:
 *   - `quota`   — used against a ceiling inside a resetting window (Claude's
 *                 5-hour and weekly buckets, per model family).
 *   - `balance` — money or credits left, optionally against a starting total so
 *                 a percentage is meaningful (DeepSeek, OpenRouter).
 *   - `rate`    — which pricing band is in force right now (peak vs off-peak)
 *                 and when it changes.
 */

export const USAGE_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const UsageUnitSchema = z.enum(["tokens", "requests", "credits", "flows", "usd", "percent"]);

export const UsageEnvCredentialSchema = z.object({
  kind: z.literal("env"),
  variable: z.string().min(1),
});

export const UsageJsonFileCredentialSchema = z.object({
  kind: z.literal("jsonFile"),
  /** `~` and `${VAR}` expand before the read. */
  file: z.string().min(1),
  /** JSON path to the secret inside that file. */
  path: z.string().min(1),
  /**
   * When the stored token stops working, so an expired one is skipped instead
   * of spent on a request that can only 401. The agent CLIs own their own
   * refresh, so a file this plugin only reads goes stale the moment its CLI
   * stops running: Claude Code's credential sat 34 hours past expiry while the
   * card showed a bare transport error.
   */
  expiresAtPath: z.string().min(1).optional(),
  /**
   * The command that rewrites this file. A stale token can then say what to run
   * instead of "the CLI that owns it", which is true but leaves the user to
   * guess a binary name. Omitted where no single command owns the file, and the
   * sentence stays generic rather than inventing one.
   */
  refreshedBy: z.string().min(1).optional(),
});

export const UsageCredentialSourceSchema = z.discriminatedUnion("kind", [
  UsageEnvCredentialSchema,
  UsageJsonFileCredentialSchema,
]);

/**
 * Ordered fallback chain per credential name: the first source that resolves
 * wins. `${name}` in a url, header, body or argv expands to it. Nothing
 * resolving is an error naming every source tried, never an empty credential.
 */
export const UsageCredentialsSchema = z.record(
  z.string().min(1),
  z.array(UsageCredentialSourceSchema).min(1),
);

/**
 * Some vendors answer HTTP 200 with an error envelope — Z.ai's quota route
 * says `{"success":false,"msg":"…"}` to a key with no Coding Plan — and a
 * document like that projects to nothing, which renders as an empty card
 * rather than as the refusal it is. Declaring where the envelope says "no"
 * turns it into an error row that quotes the vendor.
 */
export const UsageHttpFailureSchema = z.object({
  /** Where the envelope marks failure, compared strictly against `equals`. */
  path: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]),
  /** Where the vendor's own wording lives, quoted when present. */
  messagePath: z.string().min(1).optional(),
  /** What the user can do about it, in the preset author's words. */
  hint: z.string().min(1).optional(),
});

export const UsageHttpSourceSchema = z.object({
  kind: z.literal("http"),
  url: z.string().min(1),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
  /** JSON request body, serialized as-is. Only meaningful for POST. */
  body: z.unknown().optional(),
  failure: UsageHttpFailureSchema.optional(),
});

export const UsageCommandSourceSchema = z.object({
  kind: z.literal("command"),
  /** argv; the command must print a single JSON document on stdout. */
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
});

/**
 * A JSON document a local process already wrote. No request, no credential and
 * no expiry: the numbers are as fresh as the tool that produced them. Claude
 * Code hands its own `rate_limits` to a statusline command every turn, which
 * makes a quota readable without a token that can go stale.
 *
 * `files` is a chain because the same document lives at a different path
 * depending on whether the vendor's config directory is overridden. Each
 * candidate expands `${VAR}` from the environment and a leading `~` from the
 * home directory, exactly as a `jsonFile` credential does, and the first
 * candidate that exists wins. A candidate naming an unset variable is skipped
 * rather than fatal, so an override that this machine does not use costs
 * nothing.
 */
export const UsageFileSourceSchema = z.object({
  kind: z.literal("file"),
  files: z.array(z.string().min(1)).min(1),
});

/**
 * A source no url can express. Antigravity publishes no quota API: its numbers
 * come from the user's own stored credential and an undocumented endpoint, so
 * the plugin ships the mechanism as code and the config only names it. GitHub
 * Copilot is the same shape: a documented limit, an undocumented route, and a
 * token the IDE extensions stored. Naming a probe is how a provider opts into
 * a mechanism the vendor never documented, which is why every probe-backed
 * preset stays flagged `unverified`.
 */
export const UsageProbeSourceSchema = z.object({
  kind: z.literal("probe"),
  probe: z.enum(["antigravity", "github-copilot"]),
});

export const UsageSourceSchema = z.discriminatedUnion("kind", [
  UsageHttpSourceSchema,
  UsageCommandSourceSchema,
  UsageFileSourceSchema,
  UsageProbeSourceSchema,
]);

/** Names the resetting window a quota belongs to: "Session", "Weekly". */
export const UsageWindowMappingSchema = z.object({
  label: z.string().min(1),
  resetsAtPath: z.string().min(1).optional(),
  resetsInSecPath: z.string().min(1).optional(),
  /**
   * How long the window lasts. With a reset time this yields how much of the
   * window has elapsed, so the bar can mark where even consumption would be.
   */
  durationMs: z.number().int().positive().optional(),
  durationMsPath: z.string().min(1).optional(),
});

const UsageReadingCommonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * Groups readings inside one provider — a vendor that meters Google and
   * non-Google models separately reports a group per family, each with its
   * own windows.
   */
  group: z.string().min(1).optional(),
});

/**
 * A provider's mark. Three kinds, because a plugin cannot ship image assets to
 * the client bundle and must not pretend otherwise:
 *   - `lucide` names an icon the host already renders and themes.
 *   - `monogram` draws one or two letters, which is how every built-in preset
 *     identifies itself without bundling a trademarked logo.
 *   - `image` points at a `data:` or `https:` URI the user supplies, which is
 *     the escape hatch for an actual logo. Nothing is fetched unless the user
 *     asks for it by setting one.
 */
export const UsageIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lucide"), name: z.string().min(1) }),
  z.object({
    kind: z.literal("monogram"),
    text: z.string().min(1).max(2),
    /** Hex fill for the monogram plate; omitted uses the theme's accent. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("image"),
    uri: z.string().regex(/^(?:https:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/),
  }),
]);

/**
 * Projects one reading per element of an array in the response, for vendors
 * that report a variable number of buckets (one per model, one per limit).
 * Every other path in the mapping is then relative to the element.
 */
export const UsageEachMappingSchema = z.object({
  path: z.string().min(1),
  idPath: z.string().min(1).optional(),
  labelPath: z.string().min(1).optional(),
  groupPath: z.string().min(1).optional(),
  /**
   * Keeps only the elements whose `path` equals `equals`. Anthropic's `limits`
   * array mixes its scoped model limits in with the plain session and weekly
   * ones, so projecting all of it rendered the same two numbers twice under
   * fallback labels.
   */
  where: z
    .object({
      path: z.string().min(1),
      equals: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional(),
});

/**
 * Multiplies every amount this reading reads — used, limit, remaining, total.
 * Percentages are never scaled. Two real vendors need it: one reports credit
 * in ten-thousandths of a dollar, and another reports a prepaid balance as a
 * negative number because it models credit as money owed.
 */
const UsageAmountScaleSchema = z.number().refine((value) => value !== 0, {
  message: "scale must not be zero",
});

export const UsageQuotaMappingSchema = UsageReadingCommonSchema.extend({
  kind: z.literal("quota"),
  unit: UsageUnitSchema,
  window: UsageWindowMappingSchema.optional(),
  each: UsageEachMappingSchema.optional(),
  scale: UsageAmountScaleSchema.optional(),
  usedPath: z.string().min(1).optional(),
  limitPath: z.string().min(1).optional(),
  remainingPath: z.string().min(1).optional(),
  percentPath: z.string().min(1).optional(),
  /** Set when the response reports what is left as a percentage, not what is used. */
  percentRemainingPath: z.string().min(1).optional(),
});

export const UsageBalanceMappingSchema = UsageReadingCommonSchema.extend({
  kind: z.literal("balance"),
  unit: UsageUnitSchema,
  each: UsageEachMappingSchema.optional(),
  scale: UsageAmountScaleSchema.optional(),
  remainingPath: z.string().min(1).optional(),
  /** Starting balance, so a percentage remaining can be shown. */
  totalPath: z.string().min(1).optional(),
  percentRemainingPath: z.string().min(1).optional(),
  currencyPath: z.string().min(1).optional(),
});

/** One band in a peak/off-peak pricing schedule. Times are `HH:MM` wall clock. */
export const UsageRateWindowSchema = z.object({
  label: z.string().min(1),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /**
   * Days the band applies on, 0 = Sunday, in the schedule's own zone. Omitted
   * means every day. DeepSeek's peak hours are weekdays only, so without this
   * a schedule would report peak pricing all weekend.
   */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  multiplier: z.number().positive().optional(),
  detail: z.string().min(1).optional(),
});

export const UsageRateScheduleSchema = z.object({
  /** IANA zone the `start`/`end` times are expressed in. */
  timeZone: z.string().min(1).default("UTC"),
  windows: z.array(UsageRateWindowSchema).min(1),
  /** Applies whenever no window is active. */
  defaultLabel: z.string().min(1).default("Standard"),
  defaultMultiplier: z.number().positive().default(1),
});

export const UsageRateResolutionSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("schedule"), schedule: UsageRateScheduleSchema }),
  z.object({
    via: z.literal("response"),
    statePath: z.string().min(1),
    multiplierPath: z.string().min(1).optional(),
    changesAtPath: z.string().min(1).optional(),
    detailPath: z.string().min(1).optional(),
  }),
]);

export const UsageRateMappingSchema = UsageReadingCommonSchema.extend({
  kind: z.literal("rate"),
  resolution: UsageRateResolutionSchema,
});

export const UsageReadingMappingSchema = z.discriminatedUnion("kind", [
  UsageQuotaMappingSchema,
  UsageBalanceMappingSchema,
  UsageRateMappingSchema,
]);

/**
 * How a provider's card is laid out. This lives in the same config file as the
 * provider itself so the surface has one place to read and write, and so a
 * layout survives a reload without a second store.
 */
/**
 * Readings per row are NOT stored: the card derives its own column count from
 * its measured width, so a resize reflows it and no stale number survives a
 * layout change. A `columns` key left by an older config parses and is dropped.
 */
export const UsageDisplaySchema = z.object({
  /** Ascending; providers without one sort after those with one, then by id. */
  order: z.number().int().optional(),
  /** A bar reads left to right; a ring reads as a dial. */
  style: z.enum(["bar", "ring"]).optional(),
  /** Whether a quota shows what it consumed or what is left. */
  value: z.enum(["used", "remaining"]).optional(),
  /** Collapsed cards render their header and worst reading only. */
  collapsed: z.boolean().optional(),
  /** Overrides the provider's own mark. */
  icon: UsageIconSchema.optional(),
});

export const UsageProviderSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  /** Marks a preset whose endpoint no vendor has published. */
  unverified: z.boolean().default(false),
  /** The mark shown on the card, unless `display.icon` overrides it. */
  icon: UsageIconSchema.optional(),
  enabled: z.boolean().default(true),
  refreshIntervalMs: z.number().int().min(30_000).max(86_400_000).default(300_000),
  credentials: UsageCredentialsSchema.default({}),
  /** Omit when every reading is schedule-driven and needs no request. */
  source: UsageSourceSchema.optional(),
  readings: z.array(UsageReadingMappingSchema).min(1),
  display: UsageDisplaySchema.default({}),
});

/**
 * Config-file shape. An entry either defines a provider outright, or names a
 * built-in preset with `preset` and overrides only what it needs.
 */
export const UsageProviderOverrideSchema = z.object({
  preset: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  refreshIntervalMs: z.number().int().min(30_000).max(86_400_000).optional(),
  credentials: UsageCredentialsSchema.optional(),
  source: UsageSourceSchema.optional(),
  readings: z.array(UsageReadingMappingSchema).min(1).optional(),
  display: UsageDisplaySchema.optional(),
  icon: UsageIconSchema.optional(),
});

export const UsageProviderOverridesSchema = z
  .record(z.string(), UsageProviderOverrideSchema)
  .superRefine((overrides, ctx) => {
    for (const [id, override] of Object.entries(overrides)) {
      if (!USAGE_PROVIDER_ID_PATTERN.test(id)) {
        ctx.addIssue({
          code: "custom",
          path: [id],
          message: `Usage provider id "${id}" must be lowercase alphanumeric with hyphens`,
        });
        continue;
      }
      if (override.preset) continue;
      if (!override.label) {
        ctx.addIssue({
          code: "custom",
          path: [id],
          message: `Usage provider "${id}" needs either "preset" or "label"`,
        });
      }
      if (!override.readings) {
        ctx.addIssue({
          code: "custom",
          path: [id],
          message: `Usage provider "${id}" needs either "preset" or "readings"`,
        });
      }
    }
  });

export const UsageWindowSchema = z.object({
  label: z.string(),
  resetsAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});

const UsageReadingCommonOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string().nullable(),
});

export const UsageQuotaReadingSchema = UsageReadingCommonOutputSchema.extend({
  kind: z.literal("quota"),
  unit: UsageUnitSchema,
  window: UsageWindowSchema.nullable(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
  /** 0-100 consumed, from a percent path or derived from whichever pair resolved. */
  percent: z.number().nullable(),
});

export const UsageBalanceReadingSchema = UsageReadingCommonOutputSchema.extend({
  kind: z.literal("balance"),
  unit: UsageUnitSchema,
  remaining: z.number().nullable(),
  total: z.number().nullable(),
  /**
   * 0-100 of the starting balance still available. Named apart from a quota's
   * `percent` because it runs the other way: a quota's percent is consumption,
   * so it climbs toward trouble, while this one drains toward it.
   */
  percentRemaining: z.number().nullable(),
  currency: z.string().nullable(),
});

export const UsageRateReadingSchema = UsageReadingCommonOutputSchema.extend({
  kind: z.literal("rate"),
  state: z.string(),
  multiplier: z.number().nullable(),
  changesAt: z.string().nullable(),
  detail: z.string().nullable(),
});

export const UsageReadingSchema = z.discriminatedUnion("kind", [
  UsageQuotaReadingSchema,
  UsageBalanceReadingSchema,
  UsageRateReadingSchema,
]);

export const UsageProviderStatusSchema = z.enum(["ok", "error", "disabled"]);

export const UsageProviderSnapshotSchema = z.object({
  providerId: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  unverified: z.boolean(),
  status: UsageProviderStatusSchema,
  readings: z.array(UsageReadingSchema),
  error: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  /**
   * Why these readings are not current. A provider that rate-limits its own
   * quota endpoint — Anthropic's throttles after very few calls — keeps its
   * last good readings on screen with the reason and the retry time, which
   * beats replacing real numbers with an error row.
   */
  notice: z.string().nullable(),
  /** Resolved layout for this card, so the surface needs no second fetch. */
  display: UsageDisplaySchema,
  /** The mark to draw: `display.icon`, else the provider's own, else null. */
  icon: UsageIconSchema.nullable(),
});

export const UsageSnapshotSchema = z.object({
  configPath: z.string(),
  providers: z.array(UsageProviderSnapshotSchema),
});

export const readUsageLimits = defineRpc({
  name: "usage.limits.read",
  input: z.object({ refresh: z.boolean() }),
  output: UsageSnapshotSchema,
});

export type UsageUnit = z.infer<typeof UsageUnitSchema>;
export type UsageDisplay = z.infer<typeof UsageDisplaySchema>;
export type UsageIcon = z.infer<typeof UsageIconSchema>;
export type UsageCredentialSource = z.infer<typeof UsageCredentialSourceSchema>;
export type UsageCredentials = z.infer<typeof UsageCredentialsSchema>;
export type UsageSource = z.infer<typeof UsageSourceSchema>;
export type UsageHttpFailure = z.infer<typeof UsageHttpFailureSchema>;
export type UsageWindowMapping = z.infer<typeof UsageWindowMappingSchema>;
export type UsageEachMapping = z.infer<typeof UsageEachMappingSchema>;
export type UsageQuotaMapping = z.infer<typeof UsageQuotaMappingSchema>;
export type UsageBalanceMapping = z.infer<typeof UsageBalanceMappingSchema>;
export type UsageRateWindow = z.infer<typeof UsageRateWindowSchema>;
export type UsageRateSchedule = z.infer<typeof UsageRateScheduleSchema>;
export type UsageRateMapping = z.infer<typeof UsageRateMappingSchema>;
export type UsageReadingMapping = z.infer<typeof UsageReadingMappingSchema>;
export type UsageProvider = z.infer<typeof UsageProviderSchema>;
export type UsageProviderOverride = z.infer<typeof UsageProviderOverrideSchema>;
export type UsageProviderOverrides = z.infer<typeof UsageProviderOverridesSchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageQuotaReading = z.infer<typeof UsageQuotaReadingSchema>;
export type UsageBalanceReading = z.infer<typeof UsageBalanceReadingSchema>;
export type UsageRateReading = z.infer<typeof UsageRateReadingSchema>;
export type UsageReading = z.infer<typeof UsageReadingSchema>;
export type UsageProviderStatus = z.infer<typeof UsageProviderStatusSchema>;
export type UsageProviderSnapshot = z.infer<typeof UsageProviderSnapshotSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
