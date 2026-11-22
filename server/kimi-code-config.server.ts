import { join } from "node:path";
import { parse } from "smol-toml";
import type { CredentialAdapters } from "./credentials.server";

type TomlTable = Record<string, unknown>;

function table(value: unknown): TomlTable | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isKimiCodingUrl(value: unknown, hostname: string): boolean {
  const baseUrl = readString(value);
  if (baseUrl === undefined) return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === `https://${hostname}` &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/coding(?:\/v1)?\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function readProviderKey(
  provider: TomlTable | undefined,
  model: TomlTable | undefined,
  hostname: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (provider === undefined || provider.oauth !== undefined) return undefined;
  if (!isKimiCodingUrl(provider.base_url, hostname)) return undefined;
  if (model?.base_url !== undefined && !isKimiCodingUrl(model.base_url, hostname)) return undefined;
  const envName = readString(provider.api_key_env);
  return envName === undefined ? readString(provider.api_key) : readString(env[envName]);
}

/** Only send an automatically discovered API key to its own Kimi Code deployment. */
export function readKimiCodeConfigKey(
  destination: string | undefined,
  adapters: CredentialAdapters,
): string | undefined {
  const hostname =
    destination === "https://api.kimi.com/coding/v1/usages"
      ? "api.kimi.com"
      : destination === "https://api.kimi.ai/coding/v1/usages"
        ? "api.kimi.ai"
        : undefined;
  if (hostname === undefined) return undefined;

  const home = adapters.env.KIMI_CODE_HOME?.trim() || join(adapters.homeDir, ".kimi-code");
  const text = adapters.readTextFile(join(home, "config.toml"));
  if (text === null) return undefined;

  let config: TomlTable;
  try {
    config = parse(text);
  } catch {
    // TOML parse errors can quote the offending line, which may contain a key.
    return undefined;
  }
  const providers = table(config.providers);
  if (providers === undefined) return undefined;

  const modelName = readString(config.default_model);
  const models = table(config.models);
  const model = modelName === undefined ? undefined : table(models?.[modelName]);
  const providerName = readString(model?.provider);
  if (providerName !== undefined) {
    return readProviderKey(table(providers[providerName]), model, hostname, adapters.env);
  }

  // With no selected provider, a unique official key is unambiguous. Never
  // guess between multiple Coding Plan accounts based on the file's order.
  const keys = new Set(
    Object.values(providers)
      .map((provider) => readProviderKey(table(provider), undefined, hostname, adapters.env))
      .filter((key) => key !== undefined),
  );
  return keys.size === 1 ? keys.values().next().value : undefined;
}
