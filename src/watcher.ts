import { utimes } from "node:fs/promises";
import { buildProject } from "./build.js";
import { LlmWikiError } from "./errors.js";
import { acquireFileLock, type FileLock } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { getProjectStatus } from "./status.js";

export interface WatcherHandle {
  leader: boolean;
  close(): Promise<void>;
}

export async function startWatcherLeader(
  root: string,
  options: {
    pollIntervalMs?: number;
    onWarning?: (message: string) => void;
  } = {},
): Promise<WatcherHandle> {
  let lock: FileLock;
  try {
    lock = await acquireFileLock(projectPaths(root).watcherLock);
  } catch (error) {
    if (error instanceof LlmWikiError && error.code === "BUILD_LOCKED") {
      return { leader: false, async close() {} };
    }
    throw error;
  }

  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000);
  let closed = false;
  let working = false;
  const tick = async (): Promise<void> => {
    if (closed || working) {
      return;
    }
    working = true;
    try {
      await utimes(projectPaths(root).watcherLock, new Date(), new Date()).catch(() => {});
      const status = await getProjectStatus(root);
      if (status.state === "stale") {
        await buildProject(root);
      }
    } catch (error) {
      options.onWarning?.(
        `Wiki watcher could not build: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      working = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return {
    leader: true,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      while (working) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await lock.release();
    },
  };
}
