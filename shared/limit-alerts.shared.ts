import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { LIMIT_KINDS } from "./limit-detect.shared";

/**
 * A usage-limit alert is one agent turn that a vendor refused because the
 * account's quota ran out. The daemon-side hook records it; the chat renders
 * it as a callout in place of the raw error; the user (or a setting) decides
 * whether to wait for the reset, hand the work to another provider, or drop it.
 *
 * Everything the callout needs to draw itself lives on the alert, so the
 * renderer makes one RPC and never derives state from the error text again.
 */

/** A window that resets, or a prepaid balance that only a top-up moves. */
export const LimitKindSchema = z.enum(LIMIT_KINDS);

export const LimitAlertStatusSchema = z.enum([
  /** Detected; nothing decided yet. */
  "open",
  /** A resume is armed for `resume.scheduledFor`. */
  "resume_scheduled",
  /** The resume prompt was sent to the original agent. */
  "resumed",
  /** A new agent on another provider took the work (`handoff.agentId`). */
  "handed_off",
  /** User closed the callout without action. */
  "dismissed",
]);

export const LimitAlertResumeSchema = z.object({
  /** ISO instant the daemon sends the continue prompt. */
  scheduledFor: z.string(),
  /** The text sent when the timer fires. */
  prompt: z.string().min(1),
  /** True when a setting armed it rather than a button. */
  automatic: z.boolean(),
});

export const LimitAlertHandoffSchema = z.object({
  /** The new agent that continues the work. */
  agentId: z.string(),
  /** `provider/model` the new agent runs on. */
  provider: z.string().min(1),
  createdAt: z.string(),
});

export const LimitAlertSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().nullable(),
  /** Paseo agent provider id: `claude`, `codex`, `omp`, … */
  agentProvider: z.string().min(1),
  /** The provider's own label for the callout heading. */
  providerLabel: z.string().min(1),
  /**
   * The usage-monitor provider id whose card tracks this quota, when one is
   * configured (`claude`, `codex`, …). Lets the callout link to the card and
   * borrow its reset window when the error text carries none.
   */
  usageProviderId: z.string().nullable(),
  /** The vendor's own wording, trimmed, for the callout body. */
  message: z.string(),
  detectedAt: z.string(),
  /** ISO instant the quota window opens again, or null when unknown. */
  resetsAt: z.string().nullable(),
  /** Where the user manages or tops up the quota. */
  resetUrl: z.string().url().nullable(),
  /**
   * Whether the refusal was a window that resets or a spent balance. Absent on
   * an alert the daemon could not attribute to a vendor it knows.
   */
  limitKind: LimitKindSchema.optional(),
  /** Where the user buys credit, for a balance the vendor sells a page for. */
  topUpUrl: z.string().url().nullable().optional(),
  /** Last user message before the failure, so a resume or handoff can repeat it. */
  lastUserMessage: z.string().nullable(),
  /** The agent's working directory, so a handoff starts where the work was. */
  cwd: z.string().nullable().optional(),
  /** The agent's title, used to name the handoff agent. */
  title: z.string().nullable().optional(),
  status: LimitAlertStatusSchema,
  resume: LimitAlertResumeSchema.nullable(),
  handoff: LimitAlertHandoffSchema.nullable(),
});

export const LimitAlertSettingsSchema = z.object({
  /** Master switch for detection, callouts, and toasts. */
  enabled: z.boolean().default(true),
  /** Arm a resume for `resetsAt` as soon as an alert is detected. */
  autoResume: z.boolean().default(false),
  /** `provider/model` offered first in the handoff picker, or null for none. */
  handoffProvider: z.string().min(1).nullable().default(null),
  /** Create the handoff agent automatically instead of waiting for a click. */
  autoHandoff: z.boolean().default(false),
  /** Show an in-app toast when an alert is detected. */
  toast: z.boolean().default(true),
});

export const readLimitAlerts = defineRpc({
  name: "usage.limit-alerts.read",
  input: z.object({
    /** Narrow to one agent; omit for every alert the daemon still holds. */
    agentId: z.string().min(1).optional(),
  }),
  output: z.object({ alerts: z.array(LimitAlertSchema) }),
});

export const dismissLimitAlert = defineRpc({
  name: "usage.limit-alerts.dismiss",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ alert: LimitAlertSchema }),
});

export const scheduleLimitAlertResume = defineRpc({
  name: "usage.limit-alerts.resume.schedule",
  input: z.object({
    id: z.string().min(1),
    /** Override the alert's `resetsAt`; required when it is null. */
    at: z.string().optional(),
    /** Override the default continue prompt. */
    prompt: z.string().min(1).optional(),
  }),
  output: z.object({ alert: LimitAlertSchema }),
});

export const cancelLimitAlertResume = defineRpc({
  name: "usage.limit-alerts.resume.cancel",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ alert: LimitAlertSchema }),
});

export const handOffLimitAlert = defineRpc({
  name: "usage.limit-alerts.handoff",
  input: z.object({
    id: z.string().min(1),
    /** `provider/model` for the new agent. */
    provider: z.string().min(1),
    /** Provider mode id for the new agent, when the picker chose one. */
    modeId: z.string().min(1).optional(),
  }),
  output: z.object({ alert: LimitAlertSchema }),
});

export const readLimitAlertSettings = defineRpc({
  name: "usage.limit-alerts.settings.read",
  input: z.object({}),
  output: LimitAlertSettingsSchema,
});

export const writeLimitAlertSettings = defineRpc({
  name: "usage.limit-alerts.settings.write",
  input: LimitAlertSettingsSchema.partial(),
  output: LimitAlertSettingsSchema,
});

export const LIMIT_ALERTS_QUERY_KEY = ["usage-limits", "alerts"] as const;
export const LIMIT_ALERT_SETTINGS_QUERY_KEY = ["usage-limits", "alert-settings"] as const;

/** Timeline item kind the client transformer emits and the renderer draws. */
export const LIMIT_ALERT_TIMELINE_KIND = "usage-limit";
export const LIMIT_ALERT_TIMELINE_VERSION = 1;

/**
 * Payload of the replaced timeline item. Deliberately small: the renderer
 * fetches the live alert by `agentId` and matches on `message`, so the
 * callout updates when a resume fires without the timeline changing.
 */
export const LimitAlertTimelineDataSchema = z.object({
  agentProvider: z.string().min(1),
  providerLabel: z.string().min(1),
  message: z.string(),
  resetsAt: z.string().nullable(),
  resetUrl: z.string().nullable(),
  /** Readable from the wording alone, and set only when it is. */
  limitKind: LimitKindSchema.optional(),
  /** The daemon fills this in on the alert; the transformer cannot know it. */
  topUpUrl: z.string().nullable().optional(),
});

export type LimitAlert = z.infer<typeof LimitAlertSchema>;
export type LimitAlertStatus = z.infer<typeof LimitAlertStatusSchema>;
export type LimitAlertSettings = z.infer<typeof LimitAlertSettingsSchema>;
export type LimitAlertTimelineData = z.infer<typeof LimitAlertTimelineDataSchema>;
