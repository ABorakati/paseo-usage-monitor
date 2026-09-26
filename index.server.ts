import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelLimitAlertResume as cancelLimitAlertResumeHandler,
  closeLimitAlerts,
  closeLiveFileWatcher,
  consumeCodexBankedReset as consumeCodexBankedResetHandler,
  dismissLimitAlert as dismissLimitAlertHandler,
  handOffLimitAlert as handOffLimitAlertHandler,
  installStatusLine,
  readConfig,
  readHistory,
  readLimitAlertSettings as readLimitAlertSettingsHandler,
  readLimitAlerts as readLimitAlertsHandler,
  readCodexBankedReset as readCodexBankedResetHandler,
  readLimits,
  readStatusLine,
  recordLimitAlert,
  removeProvider,
  scheduleLimitAlertResume as scheduleLimitAlertResumeHandler,
  testProvider,
  uninstallStatusLine,
  writeLimitAlertSettings as writeLimitAlertSettingsHandler,
  writeProvider,
} from "./server/handlers.server";
import { consumeCodexBankedReset, readCodexBankedReset } from "./shared/codex-reset.shared";
import {
  cancelLimitAlertResume,
  dismissLimitAlert,
  handOffLimitAlert,
  readLimitAlertSettings,
  readLimitAlerts,
  scheduleLimitAlertResume,
  writeLimitAlertSettings,
} from "./shared/limit-alerts.shared";
import {
  installClaudeStatusLine,
  readClaudeStatusLine,
  uninstallClaudeStatusLine,
} from "./shared/claude-hook.shared";
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
  server.handle(readClaudeStatusLine, readStatusLine);
  server.handle(installClaudeStatusLine, installStatusLine);
  server.handle(uninstallClaudeStatusLine, uninstallStatusLine);
  server.handle(readLimitAlerts, (input, context) => readLimitAlertsHandler(input, context.paseo));
  server.handle(dismissLimitAlert, (input, context) =>
    dismissLimitAlertHandler(input, context.paseo),
  );
  server.handle(readLimitAlertSettings, (_input, context) =>
    readLimitAlertSettingsHandler(context.paseo),
  );
  server.handle(writeLimitAlertSettings, (input, context) =>
    writeLimitAlertSettingsHandler(input, context.paseo),
  );
  server.handle(scheduleLimitAlertResume, (input, context) =>
    scheduleLimitAlertResumeHandler(input, context.paseo),
  );
  server.handle(cancelLimitAlertResume, (input, context) =>
    cancelLimitAlertResumeHandler(input, context.paseo),
  );
  server.handle(handOffLimitAlert, (input, context) =>
    handOffLimitAlertHandler(input, context.paseo),
  );

  const removeTurnListener = server.on("agent.turn_ended", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }
    try {
      await readLimits({ refresh: true });
    } catch {
      // Ignore background refresh errors; regular poll will retry
    }
    try {
      await recordLimitAlert(event, context.paseo);
    } catch {
      // A failed alert write must not break the turn hook; the next turn retries.
    }
  });

  return () => {
    removeTurnListener();
    closeLiveFileWatcher();
    closeLimitAlerts();
  };
}
