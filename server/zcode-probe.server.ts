import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { UsageSourceError } from "./errors.server";

export type ZCodeUsageProviders = Pick<PluginHandlerContext["paseo"]["providers"], "listUsage">;

export async function probeZCodeUsage(providers: ZCodeUsageProviders) {
  const reports = await providers.listUsage().catch(() => {
    throw new UsageSourceError(
      "Could not read Paseo's Usage reports. Check that Usage is enabled and supported on this host",
    );
  });
  const zcodeReports = reports.providers.filter((report) => report.providerId === "zcode");
  if (zcodeReports.length === 0) {
    throw new UsageSourceError(
      "Paseo has no ZCode Usage report on this host. Check that its built-in Usage screen shows the ZCode quota",
    );
  }

  const availableReports = zcodeReports.filter((report) => report.status === "available");
  const windows = availableReports.flatMap((report, index) =>
    report.windows.map(({ id, label, resetsAt, usedPct, remainingPct }) => ({
      id: availableReports.length > 1 ? `${index + 1}-${id}` : id,
      label,
      resetsAt,
      usedPct,
      remainingPct,
      ...(availableReports.length > 1 ? { group: report.displayName } : {}),
    })),
  );
  if (windows.length === 0) {
    throw new UsageSourceError(
      "Paseo has no available ZCode quota windows on this host. Check the ZCode card in its built-in Usage screen",
    );
  }
  return { windows };
}
