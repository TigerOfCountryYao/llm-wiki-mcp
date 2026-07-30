import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];
const itPosix = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local state permissions", () => {
  itPosix("keeps every local state directory private and content file owner-only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mode-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "secret.md"), "source-derived content\n");
    await initializeProject(root, ["docs"]);
    await buildProject(root, { engine: new DeterministicSourceEngine() });

    const entries = await walk(path.join(root, ".llm-wiki"));
    for (const entry of entries) {
      const info = await lstat(entry);
      expect(info.mode & 0o777, entry).toBe(info.isDirectory() ? 0o700 : 0o600);
    }
  });
});

async function walk(target: string): Promise<string[]> {
  const result = [target];
  const info = await lstat(target);
  if (!info.isDirectory()) {
    return result;
  }
  for (const entry of await readdir(target)) {
    result.push(...(await walk(path.join(target, entry))));
  }
  return result;
}
