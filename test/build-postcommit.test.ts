import * as actualFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  failGarbageCollection: false,
  targetGeneration: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    async rm(target: Parameters<typeof original.rm>[0], options?: Parameters<typeof original.rm>[1]) {
      if (
        mockState.failGarbageCollection &&
        String(target).endsWith(mockState.targetGeneration)
      ) {
        throw Object.assign(new Error("injected garbage collection failure"), {
          code: "EACCES",
        });
      }
      return original.rm(target, options);
    },
  };
});

import { buildProject } from "../src/build.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { initializeProject } from "../src/project.js";
import { readCurrent } from "../src/state.js";
import { getProjectStatus } from "../src/status.js";

const roots: string[] = [];

afterEach(async () => {
  mockState.failGarbageCollection = false;
  mockState.targetGeneration = "";
  await Promise.all(
    roots.splice(0).map((root) =>
      actualFs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("post-commit build maintenance", () => {
  it("keeps the committed pointer successful when generation GC fails", async () => {
    const root = await actualFs.mkdtemp(
      path.join(os.tmpdir(), "llm-wiki-postcommit-"),
    );
    roots.push(root);
    await actualFs.mkdir(path.join(root, "docs"));
    const source = path.join(root, "docs", "guide.md");
    await actualFs.writeFile(source, "first version\n");
    await initializeProject(root, ["docs"]);
    const engine = new DeterministicSourceEngine();
    const first = await buildProject(root, { engine });
    await actualFs.writeFile(source, "second version\n");
    await buildProject(root, { engine });
    await actualFs.writeFile(source, "third version\n");

    mockState.targetGeneration = first.generation;
    mockState.failGarbageCollection = true;
    const third = await buildProject(root, { engine });

    expect((await readCurrent(root))?.generation).toBe(third.generation);
    expect(await getProjectStatus(root)).toMatchObject({
      state: "ready",
      currentGeneration: third.generation,
    });
  });
});
