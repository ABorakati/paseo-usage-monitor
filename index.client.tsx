import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageHistoryPanel, UsageHistorySurface } from "./client/history.client";
import { UsageLimitsPanel, UsageLimitsSurface } from "./client/limits.client";
import { contributeComposerPills } from "./client/pills.client";
import { UsageSettingsSurface } from "./client/settings.client";

export default function contribute(client: PluginClientContext) {
  client.addSurface("limits", UsageLimitsSurface);
  client.addSurface("history", UsageHistorySurface);
  client.addSurface("settings", UsageSettingsSurface);

  client.addSettingsScreen({
    id: "settings",
    title: "Usage Monitor",
    icon: "Settings2",
    Component: UsageSettingsSurface,
  });

  client.addSidebarItem({
    id: "limits",
    title: "Usage Monitor",
    icon: "Gauge",
    surface: "limits",
  });
  client.addSidebarItem({
    id: "history",
    title: "Usage history",
    icon: "ChartColumn",
    surface: "history",
  });

  client.addWorkspacePanel({
    id: "limits",
    title: "Usage Monitor",
    icon: "Gauge",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageLimitsPanel,
  });
  client.addWorkspacePanel({
    id: "history",
    title: "Usage history",
    icon: "ChartColumn",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageHistoryPanel,
  });

  client.addCommandCenterItem({
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
  client.addCommandCenterItem({
    id: "open-history",
    title: "Open usage history",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend", "explorer"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history", { location: "explorer" });
    },
  });
  client.addCommandCenterItem({
    id: "open-limits-workspace",
    title: "Open Usage Monitor as workspace tab",
    icon: "Gauge",
    keywords: ["usage monitor", "usage", "limits", "quota", "tab", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("limits", { location: "workspace" });
    },
  });
  client.addCommandCenterItem({
    id: "open-history-workspace",
    title: "Open usage history as workspace tab",
    icon: "ChartColumn",
    keywords: ["usage", "history", "tokens", "cost", "spend", "tab", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("history", { location: "workspace" });
    },
  });

  client.addSlashCommand({
    name: "usage",
    description: "Open Usage Monitor or history",
    argumentHint: "[limits|history]",
    context: "workspace",
    onSubmit({ args, openPanel }) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === "history") {
        openPanel("history", { location: "workspace" });
      } else {
        openPanel("limits", { location: "workspace" });
      }
    },
  });

  const removePills = contributeComposerPills(client);

  return () => {
    removePills();
  };
}
