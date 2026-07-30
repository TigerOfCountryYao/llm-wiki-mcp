import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { runCli, type CliIo } from "../src/cli.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { upsertKnowledge, type UpsertKnowledgeInput } from "../src/managed.js";
import { initializeProject } from "../src/project.js";
import { getProjectStatus } from "../src/status.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed knowledge idempotency", () => {
  it("does not rewrite or mark stale for an equivalent upsert", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-managed-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "guide.md"), "project source\n");
    await initializeProject(root, ["docs"]);
    const input: UpsertKnowledgeInput = {
      id: "conversation:1",
      title: "Decision",
      text: "Keep this stable.",
      provenance: { messageId: "m1", conversationId: "c1" },
      metadata: { z: "last", a: "first" },
    };
    expect(await upsertKnowledge(root, input)).toMatchObject({
      changed: true,
      status: "stale",
    });
    await buildProject(root, { engine: new DeterministicSourceEngine() });
    const managedDirectory = path.join(root, ".llm-wiki", "managed");
    const [recordName] = await readdir(managedDirectory);
    const recordPath = path.join(managedDirectory, recordName!);
    const beforeBytes = await readFile(recordPath);
    const beforeStat = await stat(recordPath);

    const invocation = await invokeCli(
      ["upsert", "--root", root, "--json"],
      {
        ...input,
        provenance: { conversationId: "c1", messageId: "m1" },
        metadata: { a: "first", z: "last" },
      },
    );
    const afterBytes = await readFile(recordPath);
    const afterStat = await stat(recordPath);

    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout)).toMatchObject({
      ok: true,
      data: { id: input.id, changed: false, status: "unchanged" },
    });
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await getProjectStatus(root)).toMatchObject({ state: "ready" });
  });
});

async function invokeCli(
  argv: string[],
  stdinJson: unknown,
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
    stdin: Readable.from([JSON.stringify(stdinJson)]),
    stdout: output("stdout"),
    stderr: output("stderr"),
    environment: process.env,
  };
  const exitCode = await runCli(argv, io);
  return { exitCode, stdout, stderr };
}
