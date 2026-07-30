import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isNodeError, pathExists } from "./fs-utils.js";

const execFileAsync = promisify(execFile);
const EXCLUDE_START = "# >>> llm-wiki managed exclude >>>";
const EXCLUDE_RULE = "/.llm-wiki/";
const EXCLUDE_END = "# <<< llm-wiki managed exclude <<<";

async function git(
  root: string,
  args: string[],
  encoding: BufferEncoding | "buffer" = "utf8",
): Promise<string | Buffer> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: encoding === "buffer" ? "buffer" : encoding,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

export async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return String(result).trim() === "true";
  } catch {
    return false;
  }
}

export async function gitEligibleFiles(root: string): Promise<string[] | null> {
  if (!(await isGitWorkTree(root))) {
    return null;
  }
  const output = (await git(root, [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
    "--",
    ".",
  ], "buffer")) as Buffer;
  return output
    .toString("utf8")
    .split("\0")
    .filter((item) => item !== "")
    .map((item) => item.replaceAll("\\", "/"));
}

export async function localGitExcludePath(root: string): Promise<string | null> {
  if (!(await isGitWorkTree(root))) {
    return null;
  }
  try {
    const raw = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
    const value = String(raw).trim();
    return path.isAbsolute(value) ? value : path.resolve(root, value);
  } catch {
    return null;
  }
}

export async function installLocalExclude(root: string): Promise<{
  changed: boolean;
  path: string | null;
  warning?: string;
}> {
  const excludePath = await localGitExcludePath(root);
  if (excludePath === null) {
    return { changed: false, path: null };
  }

  try {
    const existing = (await pathExists(excludePath)) ? await readFile(excludePath, "utf8") : "";
    if (existing.includes(EXCLUDE_START) || hasEquivalentRule(existing)) {
      return { changed: false, path: excludePath };
    }
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await appendFile(
      excludePath,
      `${prefix}${EXCLUDE_START}\n${EXCLUDE_RULE}\n${EXCLUDE_END}\n`,
      "utf8",
    );
    return { changed: true, path: excludePath };
  } catch (error) {
    return {
      changed: false,
      path: excludePath,
      warning: `Could not update local Git exclude: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function uninstallLocalExclude(root: string): Promise<{
  changed: boolean;
  path: string | null;
  warning?: string;
}> {
  const excludePath = await localGitExcludePath(root);
  if (excludePath === null || !(await pathExists(excludePath))) {
    return { changed: false, path: excludePath };
  }
  try {
    const existing = await readFile(excludePath, "utf8");
    const pattern = new RegExp(
      `${escapeRegExp(EXCLUDE_START)}\\r?\\n${escapeRegExp(EXCLUDE_RULE)}\\r?\\n${escapeRegExp(
        EXCLUDE_END,
      )}\\r?\\n?`,
      "g",
    );
    const updated = existing.replace(pattern, "");
    if (updated === existing) {
      return { changed: false, path: excludePath };
    }
    await writeFile(excludePath, updated, "utf8");
    return { changed: true, path: excludePath };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { changed: false, path: excludePath };
    }
    return {
      changed: false,
      path: excludePath,
      warning: `Could not update local Git exclude: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function hasEquivalentRule(existing: string): boolean {
  return existing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === EXCLUDE_RULE || line === ".llm-wiki/" || line === "/.llm-wiki");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
