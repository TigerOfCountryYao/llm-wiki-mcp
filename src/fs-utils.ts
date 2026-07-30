import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LlmWikiError } from "./errors.js";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export async function ensurePrivateDirectory(target: string): Promise<void> {
  await ensureDirectory(target);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LlmWikiError(
      "UNSAFE_LOCAL_STATE_DIRECTORY",
      `Local Wiki state directory is not a private directory: ${target}`,
    );
  }
  await chmod(target, 0o700);
}

export async function hardenPrivateTree(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    throw new LlmWikiError(
      "UNSAFE_LOCAL_STATE_SYMLINK",
      `Local Wiki state must not contain symbolic links: ${target}`,
    );
  }
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await hardenPrivateTree(path.join(target, entry));
    }
    return;
  }
  if (!info.isFile()) {
    throw new LlmWikiError(
      "UNSAFE_LOCAL_STATE_ENTRY",
      `Local Wiki state contains an unsupported filesystem entry: ${target}`,
    );
  }
  await chmod(target, 0o600);
}

export async function readJsonFile<T>(target: string): Promise<T> {
  const text = await readFile(target, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LlmWikiError(
      "INVALID_JSON",
      `Invalid JSON in ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readJsonIfExists<T>(target: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    throw new LlmWikiError("INVALID_SOURCE_PATH", `Invalid project-relative path: ${value}`);
  }
  return normalized;
}

export function hasDotSegment(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment.startsWith("."));
}

export function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new LlmWikiError("PATH_ESCAPE", `Path escapes the project root: ${candidate}`);
}

export async function resolveProjectRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const info = await stat(resolved).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new LlmWikiError("ROOT_NOT_FOUND", `Project root does not exist: ${resolved}`);
    }
    throw error;
  });
  if (!info.isDirectory()) {
    throw new LlmWikiError("ROOT_NOT_DIRECTORY", `Project root is not a directory: ${resolved}`);
  }
  return resolved;
}

export async function resolveRealPathWithin(root: string, candidate: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  assertWithin(realRoot, realCandidate);
  return realCandidate;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export interface FileLock {
  release(): Promise<void>;
}

export type FileLockState = "absent" | "active" | "recovered";

export async function acquireFileLock(
  lockPath: string,
  staleAfterMs = 30 * 60 * 1000,
): Promise<FileLock> {
  await ensurePrivateDirectory(path.dirname(lockPath));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) {
            return;
          }
          released = true;
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const state = await recoverOrphanedFileLock(lockPath, staleAfterMs);
      if (attempt === 0 && state !== "active") {
        continue;
      }
      throw new LlmWikiError("BUILD_LOCKED", "Another LLM Wiki build is already running.");
    }
  }

  throw new LlmWikiError("BUILD_LOCKED", "Another LLM Wiki build is already running.");
}

export async function recoverOrphanedFileLock(
  lockPath: string,
  staleAfterMs = 30 * 60 * 1000,
): Promise<FileLockState> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
  const ownerAlive = await lockOwnerIsAlive(lockPath);
  const malformedAndStale =
    ownerAlive === null && Date.now() - lockStat.mtimeMs > staleAfterMs;
  if (ownerAlive === false || malformedAndStale) {
    await rm(lockPath, { force: true });
    return "recovered";
  }
  return "active";
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) {
      return null;
    }
    try {
      process.kill(raw.pid, 0);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") {
        return false;
      }
      return true;
    }
  } catch {
    return null;
  }
}
