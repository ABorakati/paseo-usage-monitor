import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  consumeCodexBankedReset as consumeCodexBankedResetHandler,
  readConfig,
  readHistory,
  readCodexBankedReset as readCodexBankedResetHandler,
  readLimits,
  removeProvider,
  testProvider,
  writeProvider,
} from "./server/handlers.server";
import { consumeCodexBankedReset, readCodexBankedReset } from "./shared/codex-reset.shared";
import {
  readUsageConfig,
  removeUsageProvider,
  testUsageProvider,
  writeUsageProvider,
} from "./shared/config.shared";
import { readUsageHistory } from "./shared/history.shared";
import { readUsageLimits } from "./shared/limits.shared";

export default function contribute(server: PluginServerContext) {
  server.handle(readUsageLimits, readLimits);
  server.handle(readUsageHistory, readHistory);
  server.handle(readUsageConfig, readConfig);
  server.handle(writeUsageProvider, writeProvider);
  server.handle(removeUsageProvider, removeProvider);
  server.handle(testUsageProvider, testProvider);
  server.handle(readCodexBankedReset, readCodexBankedResetHandler);
  server.handle(consumeCodexBankedReset, consumeCodexBankedResetHandler);

  const removeTurnListener = server.on("agent.turn_ended", async (event) => {
    if (event.outcome.kind === "canceled") {
      return;
    }
    try {
      await readLimits({ refresh: true });
    } catch {
      // Ignore background refresh errors; regular poll will retry
    }
  });

  return () => {
    removeTurnListener();
  };
}
