import type { PaseoWorkspace } from "@getpaseo/client";
import type { PluginClientContext } from "@getpaseo/plugin";
import { claimExplorerSeed } from "./seed.shared";

/**
 * Puts the Usage Monitor panel into the Explorer sidebar without the user
 * opening a tab for it. See `seed.shared.ts` for the host constraint this works
 * around, and `seed.server.ts` for the durable claim that keeps it one-time.
 *
 * One workspace is seeded per client start, the most recently active unclaimed
 * one. Seeding every unclaimed workspace at once would route the app through
 * each of them and leave the user wherever the loop ended; the most recently
 * active workspace is the one Paseo restores on launch, so its navigation is
 * normally a no-op.
 */

const SEED_PANEL_ID = "limits";

/**
 * The seed inserts a tab into the persisted workspace layout, so it has to run
 * after that layout hydrates or hydration overwrites it. The layout store
 * exposes no readiness signal to plugins, hence a delay rather than a wait.
 */
const HYDRATION_DELAY_MS = 2_500;

export function contributeExplorerSeed(client: PluginClientContext) {
  let cancelled = false;

  async function seed(): Promise<void> {
    /**
     * `client.paseo` is typed as the host's `PaseoApi`, a name the pinned
     * `@getpaseo/client` does not export, so the workspace list arrives
     * untyped and the entries are named here instead.
     */
    const { entries }: { entries: PaseoWorkspace[] } = await client.paseo.workspaces.list();
    if (cancelled) return;
    const candidates = entries
      .filter((workspace) => workspace.archivingAt === null)
      .sort((left, right) => (right.activityAt ?? "").localeCompare(left.activityAt ?? ""));
    for (const workspace of candidates) {
      const { claimed } = await client.rpc(claimExplorerSeed, { workspaceId: workspace.id });
      if (cancelled) return;
      if (!claimed) continue;
      client.openPanel(SEED_PANEL_ID, { workspaceId: workspace.id, location: "explorer" });
      return;
    }
  }

  const timer = setTimeout(() => {
    seed().catch((error: unknown) => {
      // A failed seed is not worth a toast: the panel is still one palette
      // entry away, and the claim only advances on a successful write.
      console.warn("[usage-monitor] Explorer seed failed", error);
    });
  }, HYDRATION_DELAY_MS);

  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
