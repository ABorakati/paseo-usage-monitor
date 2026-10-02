import type { UsageDisplay } from "./limits.shared";

/**
 * Presets whose vendor quota Paseo 0.11+ already reports through a built-in
 * usage source (`claude`, `codex`, `copilot`, `cursor`, `grok`, `kimi`,
 * `minimax`, `opencode-go`, `zai`). Publishing them again would put a second,
 * identical card in Paseo's usage tracker, and the tracker has no way to hide
 * one, so they stay out unless the user turns `display.native` on.
 */
export const NATIVE_COVERED_PRESETS: Readonly<Record<string, true>> = {
  claude: true,
  "claude-statusline": true,
  codex: true,
  "github-copilot": true,
  cursor: true,
  grok: true,
  kimi: true,
  minimax: true,
  "minimax-cn": true,
  "opencode-go": true,
  zai: true,
  "zai-coding-plan": true,
};

/** What an absent `display.native` means for a provider built from `preset`. */
export function nativeUsageDefault(preset: string | null | undefined): boolean {
  return preset == null || !Object.hasOwn(NATIVE_COVERED_PRESETS, preset);
}

/** Whether the provider is published to Paseo's usage tracker. */
export function publishesNativeUsage(
  preset: string | null | undefined,
  display: Pick<UsageDisplay, "native">,
): boolean {
  return display.native ?? nativeUsageDefault(preset);
}
