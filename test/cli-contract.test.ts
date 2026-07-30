import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { readProjectConfig, writeProjectConfig } from "../src/config.js";
import { initializeProject } from "../src/project.js";
import { PACKAGE_VERSION } from "../src/version.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI configuration contracts", () => {
  it("reports the package version in version and help output", async () => {
    const version = await invokeCli(["--version"]);
    expect(version).toEqual({
      exitCode: 0,
      stdout: `${PACKAGE_VERSION}\n`,
      stderr: "",
    });

    const help = await invokeCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toMatch(
      new RegExp(`^llm-wiki ${PACKAGE_VERSION.replaceAll(".", "\\.")}\\n`),
    );
  });

  it("reports both active project profiles from semantic status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-cli-contract-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "guide.md"), "project source\n");
    await initializeProject(root, ["docs"]);
    const config = await readProjectConfig(root);
    await writeProjectConfig(root, {
      ...config,
      providerProfile: "generation-profile",
      embeddingProfile: "embedding-profile",
    });

    const invocation = await invokeCli([
      "semantic",
      "status",
      "--root",
      root,
      "--json",
    ]);
    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout)).toMatchObject({
      ok: true,
      command: "semantic",
      data: {
        enabled: false,
        providerProfile: "generation-profile",
        embeddingProfile: "embedding-profile",
      },
    });
  });
});

async function invokeCli(
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const output = (destination: "stdout" | "stderr"): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        if (destination === "stdout") {
          stdout += String(chunk);
        } else {
          stderr += String(chunk);
        }
        callback();
      },
    });
  const io: CliIo = {
    stdin: Readable.from([]),
    stdout: output("stdout"),
    stderr: output("stderr"),
    environment: process.env,
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}
