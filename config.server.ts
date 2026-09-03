import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageConfigError } from "./errors.server";
import { type UsageProviderOverrides, UsageProviderOverridesSchema } from "./limits.shared";

/**
 * A config read has exactly two acceptable outcomes: the file is not there, or
 * here is its text. Everything else — a permission problem, a directory where
 * the file should be, a failing disk — is an error, never a silent "missing".
 * Collapsing those into "missing" would swap the user's deliberately narrowed
 * config for the defaults and start making requests they did not ask for.
 */
export type ConfigFileRead = { kind: "missing" } | { kind: "text"; text: string };

export interface ConfigAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readConfigFile(path: string): ConfigFileRead;
}

/**
 * What runs when the user has never written a config file: the two providers
 * whose credentials are already on disk for anyone using Claude Code or Codex.
 */
export const DEFAULT_USAGE_CONFIG: UsageProviderOverrides = {
  claude: { preset: "claude" },
  codex: { preset: "codex" },
};

function readConfigFileSync(target: string): ConfigFileRead {
  try {
    return { kind: "text", text: readFileSync(target, "utf8") };
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new UsageConfigError(`Usage limits config at ${target} could not be read: ${detail}`, {
      cause,
    });
  }
}

export function createNodeConfigAdapters(): ConfigAdapters {
  return { env: process.env, homeDir: os.homedir(), readConfigFile: readConfigFileSync };
}

export function usageConfigPath(adapters: ConfigAdapters): string {
  const configured = adapters.env.PASEO_HOME;
  if (!configured) {
    return path.join(adapters.homeDir, ".paseo", "usage-limits.json");
  }
  const expanded = configured.startsWith("~/")
    ? path.join(adapters.homeDir, configured.slice(2))
    : configured;
  return path.join(expanded, "usage-limits.json");
}

export function loadUsageConfig(adapters: ConfigAdapters): UsageProviderOverrides {
  const configPath = usageConfigPath(adapters);
  const read = adapters.readConfigFile(configPath);
  if (read.kind === "missing") return DEFAULT_USAGE_CONFIG;

  let document: unknown;
  try {
    document = JSON.parse(read.text);
  } catch (cause) {
    throw new UsageConfigError(`Usage limits config at ${configPath} is not valid JSON`, { cause });
  }

  const parsed = UsageProviderOverridesSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new UsageConfigError(`Usage limits config at ${configPath} is invalid — ${detail}`);
  }
  return parsed.data;
}
