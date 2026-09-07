import type { PluginContext } from "@getpaseo/plugin";
import {
  readUsageConfig,
  removeUsageProvider,
  testUsageProvider,
  writeUsageProvider,
} from "./shared/config.shared";
import {
  readConfig,
  readHistory,
  readLimits,
  removeProvider,
  testProvider,
  writeProvider,
} from "./server/handlers.server";
import { UsageHistoryPanel, UsageHistorySurface } from "./client/history.client";
import { readUsageHistory } from "./shared/history.shared";
import { UsageLimitsPanel, UsageLimitsSurface } from "./client/limits.client";
import { readUsageLimits } from "./shared/limits.shared";
import { contributeComposerPills } from "./client/pills.client";
import { UsageSettingsSurface } from "./client/settings.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(readUsageLimits, readLimits);
  plugin.handle(readUsageHistory, readHistory);
  plugin.handle(readUsageConfig, readConfig);
  plugin.handle(writeUsageProvider, writeProvider);
  plugin.handle(removeUsageProvider, removeProvider);
  plugin.handle(testUsageProvider, testProvider);
  plugin.addClientSide(contributeComposerPills);
  plugin.addSurface("limits", UsageLimitsSurface);
  plugin.addSurface("history", UsageHistorySurface);
  // Reachable on its own so a composer pill can send the reader straight to the
  // settings that govern it, without routing through the dashboard's tab bar.
  plugin.addSurface("settings", UsageSettingsSurface);
  plugin.addSidebarItem({ id: "limits", title: "Usage Monitor", icon: "Gauge", surface: "limits" });
  plugin.addSidebarItem({
    id: "history",
    title: "Usage history",
    icon: "ChartColumn",
    surface: "history",
  });
  plugin.addWorkspacePanel({
    id: "limits",
    title: "Usage Monitor",
    icon: "Gauge",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageLimitsPanel,
  });
  plugin.addWorkspacePanel({
    id: "history",
    title: "Usage history",
    icon: "ChartColumn",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageHistoryPanel,
  });
  plugin.addCommandCenterItem({
    id: "open-limits",
    title: "Open Usage Monitor",
    icon: "Gauge",
    keywords: [
      "usage monitor",
      "monitor",
      "usage",
      "limits",
      "quota",
      "balance",
      "rate",
      "explorer",
    ],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("limits", { location: "explorer" });
    },
  });
  plugin.addCommandCenterItem({
    id: "open-history",
    title: "Open usage history",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend", "explorer"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history", { location: "explorer" });
    },
  });
  plugin.addCommandCenterItem({
    id: "open-limits-workspace",
    title: "Open Usage Monitor as workspace tab",
    icon: "Gauge",
    keywords: ["usage monitor", "usage", "limits", "quota", "tab", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("limits", { location: "workspace" });
    },
  });
  plugin.addCommandCenterItem({
    id: "open-history-workspace",
    title: "Open usage history as workspace tab",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend", "tab", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history", { location: "workspace" });
    },
  });
  return () => {};
}
