import type { PluginContext } from "@getpaseo/plugin";
import {
  readUsageConfig,
  removeUsageProvider,
  testUsageProvider,
  writeUsageProvider,
} from "./config.shared";
import {
  claimSeed,
  readConfig,
  readHistory,
  readLimits,
  removeProvider,
  testProvider,
  writeProvider,
} from "./handlers.server";
import { UsageHistoryPanel, UsageHistorySurface } from "./history.client";
import { readUsageHistory } from "./history.shared";
import { UsageLimitsPanel, UsageLimitsSurface } from "./limits.client";
import { readUsageLimits } from "./limits.shared";
import { contributeExplorerSeed } from "./seed.client";
import { claimExplorerSeed } from "./seed.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(readUsageLimits, readLimits);
  plugin.handle(readUsageHistory, readHistory);
  plugin.handle(readUsageConfig, readConfig);
  plugin.handle(writeUsageProvider, writeProvider);
  plugin.handle(removeUsageProvider, removeProvider);
  plugin.handle(testUsageProvider, testProvider);
  plugin.handle(claimExplorerSeed, claimSeed);
  plugin.addClientSide(contributeExplorerSeed);
  plugin.addSurface("limits", UsageLimitsSurface);
  plugin.addSurface("history", UsageHistorySurface);
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
