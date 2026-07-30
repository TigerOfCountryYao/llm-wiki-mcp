import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { readConsent, readProjectConfig, writeProjectConfig } from "../src/config.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { exploreWiki } from "../src/explore.js";
import { initializeProject } from "../src/project.js";
import { catalogProject, enumerateAuthorizedSources } from "../src/scope.js";
import { getProjectStatus } from "../src/status.js";
import type { GenerationManifest } from "../src/types.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("source scope", () => {
  it("excludes Git ignored and dot paths and enforces config ∩ consent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-scope-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    await mkdir(path.join(root, "src", ".cache"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "readme\n");
    await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "src", ".cache", "hidden.txt"), "hidden\n");
    await writeFile(path.join(root, ".secret"), "not eligible\n");
    await writeFile(path.join(root, "ignored.log"), "ignored\n");
    await writeFile(path.join(root, ".gitignore"), "*.log\n");

    const catalog = await catalogProject(root);
    expect(catalog.entries.map((entry) => entry.path)).toEqual(["README.md", "src"]);
    expect(catalog.entries.every((entry) => entry.selected)).toBe(true);

    await initializeProject(root, ["README.md", "src"]);
    const config = await readProjectConfig(root);
    await writeProjectConfig(root, { ...config, sources: ["src"] });
    const consent = await readConsent(root);
    await writeFile(path.join(root, "src", "new.ts"), "export const next = 2;\n");
    await writeFile(path.join(root, "NEW_ROOT.md"), "not consented\n");
    const enumerated = await enumerateAuthorizedSources(root, consent);
    expect(enumerated.sources.map((source) => source.relativePath)).toEqual([
      "src/main.ts",
      "src/new.ts",
    ]);
  });

  it("treats a deleted tracked file as a source deletion instead of a scan failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-git-delete-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "LLM Wiki Test"]);
    await mkdir(path.join(root, "docs"));
    const deletedSource = path.join(root, "docs", "deleted.md");
    await writeFile(deletedSource, "knowledge that must disappear after deletion\n");
    await execFileAsync("git", ["-C", root, "add", "docs/deleted.md"]);
    await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);

    await initializeProject(root, ["docs"]);
    await buildProject(root, { engine: new DeterministicSourceEngine() });
    await unlink(deletedSource);

    expect(await getProjectStatus(root)).toMatchObject({
      state: "stale",
      reasonCode: "SOURCES_CHANGED",
      sourceCount: 0,
    });
    const rebuilt = await buildProject(root, {
      engine: new DeterministicSourceEngine(),
    });
    const manifest = JSON.parse(
      await readFile(
        path.join(
          root,
          ".llm-wiki",
          "generations",
          rebuilt.generation,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as GenerationManifest;
    const explored = await exploreWiki(root, "knowledge disappear");

    expect(manifest.sources).toEqual([]);
    expect(manifest.proxies).toEqual([]);
    expect(explored.evidence).toEqual([]);
  });

  it("fails closed when Git scope cannot be verified inside a repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-git-unavailable-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, ".gitignore"), "docs/ignored.secret\n");
    await writeFile(path.join(root, "docs", "guide.md"), "approved knowledge\n");
    await writeFile(path.join(root, "docs", "ignored.secret"), "must never expand scope\n");
    await initializeProject(root, ["docs"]);
    await buildProject(root, { engine: new DeterministicSourceEngine() });
    const consent = await readConsent(root);
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(catalogProject(root)).rejects.toMatchObject({
        code: "GIT_SCOPE_UNAVAILABLE",
      });
      await expect(enumerateAuthorizedSources(root, consent)).rejects.toMatchObject({
        code: "GIT_SCOPE_UNAVAILABLE",
      });
      await expect(getProjectStatus(root)).rejects.toMatchObject({
        code: "GIT_SCOPE_UNAVAILABLE",
      });
      await expect(
        buildProject(root, { engine: new DeterministicSourceEngine() }),
      ).rejects.toMatchObject({
        code: "GIT_SCOPE_UNAVAILABLE",
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("still supports a true non-Git directory when Git is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-nongit-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "guide.md"), "local knowledge\n");
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const catalog = await catalogProject(root);
      expect(catalog.entries.map((entry) => entry.path)).toEqual(["docs"]);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});
