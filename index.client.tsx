import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, type ReactElement } from "react";
import { UsageHistoryPanel, UsageHistorySurface } from "./client/history.client";
import { contributeLimitAlerts } from "./client/limit-alerts.client";
import { UsageLimitsPanel, UsageLimitsSurface } from "./client/limits.client";
import { contributeComposerPills } from "./client/pills.client";
import { UsageSettingsSurface } from "./client/settings.client";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "limits", title: "Usage Monitor", Component: UsageLimitsSurface });
  client.addScreen({ id: "history", title: "Usage history", Component: UsageHistorySurface });
  client.addScreen({ id: "settings", title: "Usage Monitor", Component: UsageSettingsSurface });

  client.addSettingsScreen({
    id: "settings",
    title: "Usage Monitor",
    icon: "Settings2",
    Component: UsageSettingsSurface,
  });

  client.addSidebarHeaderItem({
    id: "limits",
    title: "Usage Monitor",
    Component: sidebarRow("limits", "Gauge"),
  });
  client.addSidebarHeaderItem({
    id: "history",
    title: "Usage history",
    Component: sidebarRow("history", "ChartColumn"),
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
  const removeLimitAlerts = contributeLimitAlerts(client);

  return () => {
    removePills();
    removeLimitAlerts();
  };
}

/** One sidebar row that opens its screen and shows as active while it is open. */
function sidebarRow(screenId: string, icon: string) {
  return function UsageSidebarRow({
    currentScreen,
    openScreen,
  }: PluginSidebarItemProps): ReactElement {
    const open = useCallback(() => openScreen({ screenId }), [openScreen]);
    return <SidebarRow icon={icon} active={currentScreen?.screenId === screenId} onPress={open} />;
  };
}
