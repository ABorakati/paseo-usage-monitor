import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CredentialAdapters } from "./credentials.server";
import { readKimiCodeConfigKey } from "./kimi-code-config.server";

const HOME = "/home/tester";
const MAINLAND_USAGE = "https://api.kimi.com/coding/v1/usages";
const GLOBAL_USAGE = "https://api.kimi.ai/coding/v1/usages";
const API_KEY = "test-kimi-coding-key";

function adaptersFor(config: string, env: NodeJS.ProcessEnv = {}): CredentialAdapters {
  const configPath = join(env.KIMI_CODE_HOME ?? join(HOME, ".kimi-code"), "config.toml");
  return {
    env,
    homeDir: HOME,
    readTextFile: (path) => (path === configPath ? config : null),
    now: () => new Date(0),
  };
}

describe("Kimi Code API keys", () => {
  test("uses the default model's provider even if another eligible provider appears first", () => {
    const adapters = adaptersFor(`
      default_model = "model/alias"
      [models."model/alias"]
      provider = "my.kimi"
      [providers.other]
      base_url = "https://api.kimi.com/coding/"
      api_key = "test-unselected-key"
      [providers."my.kimi"]
      base_url = "https://api.kimi.com/coding/v1"
      api_key = "${API_KEY}" # optional comment
    `);

    expect(readKimiCodeConfigKey(MAINLAND_USAGE, adapters)).toBe(API_KEY);
  });

  test("honors KIMI_CODE_HOME and the credential's declared environment variable", () => {
    const adapters = adaptersFor(
      `
        [providers.my-kimi]
        base_url = "https://api.kimi.ai/coding/v1/"
        api_key_env = "CLI_KIMI_KEY"
      `,
      { KIMI_CODE_HOME: "/another-kimi-home", CLI_KIMI_KEY: API_KEY },
    );

    expect(readKimiCodeConfigKey(GLOBAL_USAGE, adapters)).toBe(API_KEY);
    expect(readKimiCodeConfigKey(MAINLAND_USAGE, adapters)).toBeUndefined();
  });

  test("never reads the file for a custom usage endpoint", () => {
    const adapters = adaptersFor("");
    const read = vi.spyOn(adapters, "readTextFile");

    expect(readKimiCodeConfigKey("https://proxy.example/usage", adapters)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  test.each(["http://api.kimi.com/coding/", "https://api.kimi.com.proxy.example/coding/"])(
    "skips API keys configured for %s",
    (baseUrl) => {
      const adapters = adaptersFor(`
        [providers.proxy]
        base_url = "${baseUrl}"
        api_key = "${API_KEY}"
      `);

      expect(readKimiCodeConfigKey(MAINLAND_USAGE, adapters)).toBeUndefined();
    },
  );

  test("does not guess a default when multiple eligible accounts are present", () => {
    const adapters = adaptersFor(`
      [providers.first]
      base_url = "https://api.kimi.com/coding/v1/"
      api_key = "${API_KEY}"
      [providers.second]
      base_url = "https://api.kimi.com/coding/v1/"
      api_key = "test-kimi-second-key"
    `);

    expect(readKimiCodeConfigKey(MAINLAND_USAGE, adapters)).toBeUndefined();
  });

  test("skips malformed TOML without surfacing its contents", () => {
    const adapters = adaptersFor(`
      [providers.kimi]
      base_url = "https://api.kimi.com/coding/"
      api_key = "${API_KEY}
    `);

    expect(readKimiCodeConfigKey(MAINLAND_USAGE, adapters)).toBeUndefined();
  });
});
