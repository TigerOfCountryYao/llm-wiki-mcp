import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { LlmWikiError } from "../src/errors.js";
import { exploreWiki } from "../src/explore.js";
import { initializeProject } from "../src/project.js";
import { markStale, readCurrent, writeStatus } from "../src/state.js";
import { getProjectStatus } from "../src/status.js";
import {
  STATE_SCHEMA_VERSION,
  type EngineBuildInput,
  type EngineBuildResult,
  type WikiEngine,
} from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable generation builds", () => {
  it("keeps deterministic generation pages exactly aligned with current proxies", async () => {
    const root = await projectWithSource();
    await writeFile(
      path.join(root, "docs", "remove.md"),
      "obsolete-zebra should disappear\n",
    );
    const engine = new DeterministicSourceEngine();
    await buildProject(root, { engine });

    await writeFile(
      path.join(root, "docs", "guide.md"),
      "beta-orchid is the revised architecture marker\n",
    );
    await writeFile(
      path.join(root, "docs", "new.md"),
      "gamma-otter is newly added knowledge\n",
    );
    await rm(path.join(root, "docs", "remove.md"), { force: true });

    const rebuilt = await buildProject(root, { engine });
    const generationRoot = path.join(
      root,
      ".llm-wiki",
      "generations",
      rebuilt.generation,
    );
    const manifest = JSON.parse(
      await readFile(path.join(generationRoot, "manifest.json"), "utf8"),
    ) as { proxies: Array<{ proxyFile: string }> };
    const pageFiles = (await readdir(
      path.join(generationRoot, "engine", "wiki", "pages"),
    )).sort();

    expect(rebuilt.pageCount).toBe(2);
    expect(pageFiles).toEqual(
      manifest.proxies.map((proxy) => proxy.proxyFile).sort(),
    );
    expect((await exploreWiki(root, "stable")).evidence).toEqual([]);
    expect((await exploreWiki(root, "obsolete-zebra")).evidence).toEqual([]);
    expect(
      (await exploreWiki(root, "beta-orchid")).evidence[0]?.citation.locator,
    ).toMatchObject({ kind: "file", path: "docs/guide.md" });
    expect(
      (await exploreWiki(root, "gamma-otter")).evidence[0]?.citation.locator,
    ).toMatchObject({ kind: "file", path: "docs/new.md" });
  });

  it("publishes atomically, retains current + previous, and serves stale last-good evidence", async () => {
    const root = await projectWithSource();
    const engine = new DeterministicSourceEngine();
    const first = await buildProject(root, { engine });
    expect((await readCurrent(root))?.generation).toBe(first.generation);

    await writeFile(path.join(root, "docs", "new.md"), "new project fact\n");
    const second = await buildProject(root, { engine });
    await writeFile(path.join(root, "docs", "guide.md"), "updated stable project fact\n");
    const third = await buildProject(root, { engine });
    const generations = await readdir(path.join(root, ".llm-wiki", "generations"));
    expect(generations.sort()).toEqual([second.generation, third.generation].sort());

    await writeFile(path.join(root, "docs", "guide.md"), "unbuilt change\n");
    const result = await exploreWiki(root, "stable");
    expect(result.status.state).toBe("stale");
    expect(result.status.generation).toBe(third.generation);
    expect(result.evidence[0]?.citation.locator).toMatchObject({
      kind: "file",
      path: "docs/guide.md",
      lineStart: 1,
      lineEnd: 1,
    });
  });

  it("keeps the previous pointer when an engine crashes", async () => {
    const root = await projectWithSource();
    const first = await buildProject(root, { engine: new DeterministicSourceEngine() });
    await writeFile(path.join(root, "docs", "guide.md"), "changed\n");
    const failing: WikiEngine = {
      async build(_input: EngineBuildInput): Promise<EngineBuildResult> {
        throw new LlmWikiError("TEST_ENGINE_CRASH", "simulated crash");
      },
    };
    await expect(buildProject(root, { engine: failing })).rejects.toMatchObject({
      code: "TEST_ENGINE_CRASH",
    });
    expect((await readCurrent(root))?.generation).toBe(first.generation);
    expect((await getProjectStatus(root)).state).toBe("error");
  });

  it("serializes concurrent builds with one build lock", async () => {
    const root = await projectWithSource();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WikiEngine = {
      async build(input): Promise<EngineBuildResult> {
        await gate;
        return new DeterministicSourceEngine().build(input);
      },
    };
    const first = buildProject(root, { engine: slow });
    await waitForFile(path.join(root, ".llm-wiki", "locks", "build.lock"));
    await expect(
      buildProject(root, { engine: new DeterministicSourceEngine() }),
    ).rejects.toMatchObject({ code: "BUILD_LOCKED" });
    release();
    await first;
  });

  it("releases the build lock when current state cannot be read", async () => {
    const root = await projectWithSource();
    await writeFile(
      path.join(root, ".llm-wiki", "current.json"),
      "{ malformed current pointer",
    );

    await expect(
      buildProject(root, { engine: new DeterministicSourceEngine() }),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(
      readFile(path.join(root, ".llm-wiki", "locks", "build.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the build lock when the building status cannot be written", async () => {
    const root = await projectWithSource();
    const statusPath = path.join(root, ".llm-wiki", "status.json");
    await rm(statusPath, { force: true });
    await mkdir(statusPath);

    await expect(
      buildProject(root, { engine: new DeterministicSourceEngine() }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      readFile(path.join(root, ".llm-wiki", "locks", "build.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a config-only stale marker when source content is unchanged", async () => {
    const root = await projectWithSource();
    await buildProject(root, { engine: new DeterministicSourceEngine() });
    await markStale(
      root,
      "SEMANTIC_CONFIG_CHANGED",
      "Semantic retrieval configuration changed.",
    );

    expect(await getProjectStatus(root)).toMatchObject({
      state: "stale",
      reasonCode: "SEMANTIC_CONFIG_CHANGED",
      message: "Semantic retrieval configuration changed.",
    });
  });

  it("can read the committed status without rescanning changed sources", async () => {
    const root = await projectWithSource();
    const built = await buildProject(root, {
      engine: new DeterministicSourceEngine(),
    });
    await writeFile(
      path.join(root, "docs", "guide.md"),
      "changed after the committed generation\n",
    );

    expect(
      await getProjectStatus(root, { verifySources: false }),
    ).toMatchObject({
      state: "ready",
      sourceCount: 1,
      sourceDigest: built.sourceDigest,
      currentGeneration: built.generation,
    });
    expect(await getProjectStatus(root)).toMatchObject({
      state: "stale",
      reasonCode: "SOURCES_CHANGED",
    });
  });

  it("ignores a stored build failure older than the current commit", async () => {
    const root = await projectWithSource();
    const built = await buildProject(root, {
      engine: new DeterministicSourceEngine(),
    });
    const current = await readCurrent(root);
    expect(current?.generation).toBe(built.generation);
    const oldTime = new Date(
      Date.parse(current!.builtAt) - 1_000,
    ).toISOString();
    await writeStatus(root, {
      schemaVersion: STATE_SCHEMA_VERSION,
      state: "error",
      updatedAt: oldTime,
      currentGeneration: current!.generation,
      reasonCode: "OLD_FAILURE",
      message: "This failure predates the committed generation.",
    });

    expect(await getProjectStatus(root)).toMatchObject({
      state: "ready",
      currentGeneration: current!.generation,
    });
  });
});

async function projectWithSource(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-build-"));
  roots.push(root);
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "guide.md"), "stable project fact\n");
  await initializeProject(root, ["docs"]);
  return root;
}

async function waitForFile(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}
