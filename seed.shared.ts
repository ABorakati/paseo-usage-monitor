import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Seeding the Explorer sidebar is a one-time act per workspace.
 *
 * `openPanel(id, { location: "explorer" })` is the only way a plugin can put a
 * panel into the Explorer sidebar, and the host implements it as a workspace
 * navigation: it routes the app to that workspace as well as inserting the
 * tab. Paying that once per workspace is acceptable; paying it on every client
 * start is not. Paseo persists Explorer sidebar tabs per workspace (only
 * `new_tab` and `commit_diff` tabs are stripped before the layout is saved), so
 * after the single seed the panel comes back on its own with no navigation.
 *
 * The claim therefore has to outlive the client, the plugin process and the
 * app, which makes it daemon-side state rather than anything a client can hold.
 */

export const claimExplorerSeed = defineRpc({
  name: "usage.explorer-seed.claim",
  input: z.object({ workspaceId: z.string().min(1) }),
  /** True only for the caller that claimed the workspace first. */
  output: z.object({ claimed: z.boolean() }),
});
