import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Which workspaces have already had the Explorer sidebar panel seeded, kept on
 * disk beside the reading store. See `seed.shared.ts` for why the claim has to
 * be durable.
 *
 * A claim is a write-once record. Re-seeding a workspace would fight the user:
 * closing the Explorer tab is a decision, and a stored claim is what keeps that
 * decision. An unreadable or corrupt file therefore cannot silently re-seed
 * everything — it is treated as empty, which is the only recoverable reading,
 * and the seed then happens at most one more time per workspace.
 */

const STORE_VERSION = 1;

const SeedStoreFileSchema = z.object({
  version: z.literal(STORE_VERSION),
  workspaceIds: z.array(z.string().min(1)),
});

export interface SeedStoreAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
  writeTextFile(path: string, content: string): void;
}

export interface SeedStore {
  /** Records the workspace, answering whether this call is the one that claimed it. */
  claim(workspaceId: string): boolean;
}

export function seedStorePath(adapters: SeedStoreAdapters): string {
  const paseoHome = adapters.env.PASEO_HOME ?? join(adapters.homeDir, ".paseo");
  return join(paseoHome, "usage-limits", "explorer-seeds.json");
}

/**
 * A test run must never claim the developer's own workspaces: a claim written
 * there suppresses the seed they are trying to get. A test that wants the
 * on-disk store has to point `PASEO_HOME` at a temp directory.
 */
function refuseWriteOutsideTempDuringTests(path: string): void {
  if (process.env.VITEST === undefined) return;
  if (path.startsWith(tmpdir())) return;
  throw new Error(
    `refusing to write the explorer seed store to ${path} during a test run: point PASEO_HOME at a temp directory or inject a SeedStore`,
  );
}

export function createNodeSeedStoreAdapters(): SeedStoreAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    readTextFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // An absent store is the normal first-run state, not a failure.
        return null;
      }
    },
    writeTextFile(path: string, content: string): void {
      refuseWriteOutsideTempDuringTests(path);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true });
      const temporary = join(directory, `.explorer-seeds.${process.pid}.tmp`);
      writeFileSync(temporary, content, "utf8");
      renameSync(temporary, path);
    },
  };
}

function parseStoreFile(text: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = SeedStoreFileSchema.safeParse(document);
  return parsed.success ? parsed.data.workspaceIds : [];
}

export function createSeedStore(adapters: SeedStoreAdapters): SeedStore {
  const path = seedStorePath(adapters);
  let claimed: Set<string> | null = null;

  function loaded(): Set<string> {
    if (claimed !== null) return claimed;
    const text = adapters.readTextFile(path);
    claimed = new Set(text === null ? [] : parseStoreFile(text));
    return claimed;
  }

  return {
    claim(workspaceId: string): boolean {
      const workspaces = loaded();
      if (workspaces.has(workspaceId)) return false;
      workspaces.add(workspaceId);
      const document = {
        version: STORE_VERSION,
        workspaceIds: [...workspaces],
      } satisfies z.infer<typeof SeedStoreFileSchema>;
      adapters.writeTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
      return true;
    },
  };
}
