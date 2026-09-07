import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";
import { UsageProviderOverrideSchema, UsageProviderOverridesSchema } from "./limits.shared";

/**
 * Editing providers from the surface, so adding a provider does not mean
 * hand-writing JSON in a file the app never shows you.
 *
 * Secrets never enter the config file. A key typed into the UI is written to a
 * sibling secrets file with owner-only permissions, and the provider entry
 * references it as a `jsonFile` credential, which is the same mechanism a
 * hand-written config uses.
 */

export const UsagePresetSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  unverified: z.boolean(),
  /** Credential names the preset interpolates, in the order it declares them. */
  credentialNames: z.array(z.string()),
  /** How each credential resolves today, so the form can explain what it needs. */
  credentialHints: z.array(z.string()),
  endpoint: z.string().nullable(),
});

export const UsageConfigStateSchema = z.object({
  configPath: z.string(),
  secretsPath: z.string(),
  /** Providers exactly as the config file holds them. */
  providers: UsageProviderOverridesSchema,
  presets: z.array(UsagePresetSummarySchema),
  /** Credential names that already have a stored secret, per provider id. */
  storedSecrets: z.record(z.string(), z.array(z.string())),
});

export const UsageProviderWriteSchema = z.object({
  id: z.string().min(1),
  entry: UsageProviderOverrideSchema,
  /**
   * Secret values by credential name. A value is written to the secrets file
   * and referenced from the entry; an empty string clears a stored secret.
   */
  secrets: z.record(z.string(), z.string()),
});

export const readUsageConfig = defineRpc({
  name: "usage.config.read",
  input: z.object({}),
  output: UsageConfigStateSchema,
});

export const writeUsageProvider = defineRpc({
  name: "usage.config.write-provider",
  input: UsageProviderWriteSchema,
  output: UsageConfigStateSchema,
});

export const removeUsageProvider = defineRpc({
  name: "usage.config.remove-provider",
  input: z.object({ id: z.string().min(1) }),
  output: UsageConfigStateSchema,
});

export const testUsageProvider = defineRpc({
  name: "usage.config.test-provider",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    readingCount: z.number(),
  }),
});

export type UsagePresetSummary = z.infer<typeof UsagePresetSummarySchema>;
export type UsageConfigState = z.infer<typeof UsageConfigStateSchema>;
export type UsageProviderWrite = z.infer<typeof UsageProviderWriteSchema>;
