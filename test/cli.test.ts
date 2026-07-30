import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

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
