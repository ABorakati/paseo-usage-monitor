import type { PluginContext } from "@getpaseo/plugin";
import {
  readUsageConfig,
  removeUsageProvider,
  testUsageProvider,
  writeUsageProvider,
} from "./config.shared";
import {
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

export default function contribute(plugin: PluginContext) {
  plugin.handle(readUsageLimits, readLimits);
  plugin.handle(readUsageHistory, readHistory);
  plugin.handle(readUsageConfig, readConfig);
  plugin.handle(writeUsageProvider, writeProvider);
  plugin.handle(removeUsageProvider, removeProvider);
  plugin.handle(testUsageProvider, testProvider);
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
    locations: ["workspace", "explorer"],
    Component: UsageLimitsPanel,
  });
  plugin.addWorkspacePanel({
    id: "history",
    title: "Usage history",
    icon: "ChartColumn",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: UsageHistoryPanel,
  });
  plugin.addCommandCenterItem({
    id: "open-limits-explorer",
    title: "Open Usage Monitor in Explorer",
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
    id: "open-history-explorer",
    title: "Open usage history in Explorer",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend", "explorer"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history", { location: "explorer" });
    },
  });
  plugin.addCommandCenterItem({
    id: "open-limits",
    title: "Open Usage Monitor",
    icon: "Gauge",
    keywords: ["usage monitor", "monitor", "usage", "limits", "quota", "balance", "rate"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("limits");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-history",
    title: "Open usage history",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history");
    },
  });
  return () => {};
}
