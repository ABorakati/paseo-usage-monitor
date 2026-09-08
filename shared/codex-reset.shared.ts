import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CodexBankedResetCreditSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
});

export const CodexBankedResetDetailsSchema = z.object({
  availableCount: z.number().int().nonnegative(),
  credit: CodexBankedResetCreditSchema.nullable(),
  /** Reused for every retry of this prepared reset attempt. */
  redeemRequestId: z.string().uuid().nullable(),
});

export const CodexBankedResetOutcomeSchema = z.enum([
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
]);

export const readCodexBankedReset = defineRpc({
  name: "usage.codex.banked-reset.read",
  input: z.object({ providerId: z.string().min(1) }),
  output: CodexBankedResetDetailsSchema,
});

export const consumeCodexBankedReset = defineRpc({
  name: "usage.codex.banked-reset.consume",
  input: z.object({
    providerId: z.string().min(1),
    creditId: z.string().min(1).nullable(),
    redeemRequestId: z.string().uuid(),
  }),
  output: z.object({
    outcome: CodexBankedResetOutcomeSchema,
    windowsReset: z.number().int().nonnegative(),
  }),
});

export type CodexBankedResetDetails = z.infer<typeof CodexBankedResetDetailsSchema>;
export type CodexBankedResetOutcome = z.infer<typeof CodexBankedResetOutcomeSchema>;
