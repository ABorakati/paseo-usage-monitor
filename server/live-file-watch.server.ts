import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * A file source is only as fresh as its writer, and the writer is another
 * program: Claude Code's statusline hook rewrites its document at the end of
 * every turn. Waiting for the provider's refresh interval would show numbers up
 * to a minute old, so the daemon watches the directory instead and drops the
 * cached reading the moment the file lands.
 *
 * The directory is watched, not the file, because the hook writes through a
 * temporary file and renames it into place — a watch on the old inode would
 * stop seeing changes after the first one.
 */
export interface LiveFileTarget {
  providerId: string;
  path: string;
}

export interface LiveFileWatchAdapters {
  watch(directory: string, onChange: (filename: string | null) => void): { close(): void };
  directoryExists(directory: string): boolean;
}

export function createNodeLiveFileWatchAdapters(): LiveFileWatchAdapters {
  return {
    watch(directory, onChange) {
      const watcher = watch(directory, (_event, filename) => {
        onChange(filename === null ? null : filename.toString());
      });
      return {
        close() {
          watcher.close();
        },
      };
    },
    directoryExists(directory) {
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export interface LiveFileWatcher {
  sync(targets: readonly LiveFileTarget[]): void;
  close(): void;
}

export function createLiveFileWatcher(input: {
  adapters: LiveFileWatchAdapters;
  onChanged(providerIds: readonly string[]): void;
  debounceMs?: number;
}): LiveFileWatcher {
  const debounceMs = input.debounceMs ?? 200;
  let watchers: { close(): void }[] = [];
  let signature = "";
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    timer = undefined;
    const providerIds = [...pending].sort();
    pending.clear();
    if (providerIds.length > 0) input.onChanged(providerIds);
  }

  function schedule(providerIds: Iterable<string>): void {
    for (const providerId of providerIds) pending.add(providerId);
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function closeWatchers(): void {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // A directory removed under us is already closed.
      }
    }
    watchers = [];
  }

  return {
    sync(targets) {
      const next = targets
        .filter((target) => target.path !== "")
        .slice()
        .sort(
          (left, right) =>
            left.providerId.localeCompare(right.providerId) || left.path.localeCompare(right.path),
        );
      const nextSignature = next
        .map((target) => target.providerId + "\u0000" + target.path)
        .join("\u0001");
      if (nextSignature === signature) return;
      signature = nextSignature;
      closeWatchers();

      const filesByDirectory = new Map<string, Map<string, Set<string>>>();
      for (const target of next) {
        const directory = dirname(target.path);
        let files = filesByDirectory.get(directory);
        if (files === undefined) {
          files = new Map();
          filesByDirectory.set(directory, files);
        }
        const name = basename(target.path);
        let providerIds = files.get(name);
        if (providerIds === undefined) {
          providerIds = new Set();
          files.set(name, providerIds);
        }
        providerIds.add(target.providerId);
      }

      for (const [directory, files] of filesByDirectory) {
        if (!input.adapters.directoryExists(directory)) continue;
        try {
          watchers.push(
            input.adapters.watch(directory, (filename) => {
              if (filename === null) {
                // Some platforms report no name; the whole directory is one
                // provider's config directory in practice, so refresh them all.
                for (const providerIds of files.values()) schedule(providerIds);
                return;
              }
              const providerIds = files.get(filename);
              if (providerIds !== undefined) schedule(providerIds);
            }),
          );
        } catch {
          // The directory can disappear between the check and the watch.
        }
      }
    },

    close() {
      closeWatchers();
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
      signature = "";
    },
  };
}
