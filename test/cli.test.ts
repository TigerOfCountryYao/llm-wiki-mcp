import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { initializeProject } from "../src/project.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("management CLI", () => {
  it("uses one JSON envelope and requires explicit scope when non-interactive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-cli-"));
    roots.push(root);
    await writeFile(path.join(root, "note.md"), "note\n");
    const cli = path.join(process.cwd(), "dist", "cli.js");

    const catalog = await execFileAsync(
      process.execPath,
      [cli, "catalog", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    const catalogLines = catalog.stdout.trim().split(/\r?\n/u);
    expect(catalogLines).toHaveLength(1);
    expect(JSON.parse(catalogLines[0]!)).toMatchObject({
      ok: true,
      command: "catalog",
      data: { entries: [{ path: "note.md", selected: true }] },
    });

    const failed = await runExpectingFailure(process.execPath, [
      cli,
      "init",
      "--root",
      root,
      "--yes",
      "--json",
    ]);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      error: { code: "EXPLICIT_SCOPE_REQUIRED" },
    });

    const initialized = await execFileAsync(
      process.execPath,
      [
        cli,
        "init",
        "--root",
        root,
        "--select",
        "note.md",
        "--yes",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      ok: true,
      command: "init",
      data: { selectedPaths: ["note.md"] },
    });

    const buildFailure = await runExpectingFailure(process.execPath, [
      cli,
      "build",
      "--root",
      root,
      "--json",
    ]);
    expect(JSON.parse(buildFailure.stdout)).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
    const status = await execFileAsync(
      process.execPath,
      [cli, "status", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      data: { state: "provider-unavailable" },
    });
  }, 20_000);

  it("supports a fast status read from the committed generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-cli-fast-"));
    roots.push(root);
    await writeFile(path.join(root, "note.md"), "committed fact\n");
    await initializeProject(root, ["note.md"]);
    const built = await buildProject(root, {
      engine: new DeterministicSourceEngine(),
    });
    await writeFile(path.join(root, "note.md"), "changed fact\n");
    const cli = path.join(process.cwd(), "dist", "cli.js");

    const fast = await execFileAsync(
      process.execPath,
      [cli, "status", "--root", root, "--fast", "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(fast.stdout)).toMatchObject({
      ok: true,
      command: "status",
      data: {
        state: "ready",
        sourceCount: 1,
        sourceDigest: built.sourceDigest,
        currentGeneration: built.generation,
      },
    });

    const verified = await execFileAsync(
      process.execPath,
      [cli, "status", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      data: { state: "stale", reasonCode: "SOURCES_CHANGED" },
    });
  });
});

async function runExpectingFailure(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    await execFileAsync(executable, args, { encoding: "utf8" });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
  throw new Error("Expected command to fail.");
}
