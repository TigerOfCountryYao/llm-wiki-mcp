import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildProject } from "../src/build.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { initializeProject } from "../src/project.js";
import { PACKAGE_VERSION } from "../src/version.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stdio MCP surface", () => {
  it("exposes exactly wiki_explore and fixes root at process launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcp-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "architecture.md"), "The runtime uses stdio.\n");
    await initializeProject(root, ["docs"]);
    await buildProject(root, { engine: new DeterministicSourceEngine() });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist", "cli.js"), "serve", "--root", root],
    });
    const client = new Client({ name: "llm-wiki-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({
        name: "llm-wiki",
        version: PACKAGE_VERSION,
      });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["wiki_explore"]);
      expect(Object.keys(listed.tools[0]!.inputSchema.properties ?? {}).sort()).toEqual([
        "maxResults",
        "query",
      ]);
      const result = await client.callTool({
        name: "wiki_explore",
        arguments: { query: "stdio", maxResults: 3 },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<
        { type: "text"; text: string } | { type: string }
      >;
      const text = content.find(
        (item): item is { type: "text"; text: string } => item.type === "text",
      );
      expect(text).toMatchObject({ type: "text" });
      if (text?.type === "text") {
        const parsed = JSON.parse(text.text) as {
          evidence: Array<{ citation: { locator: { path?: string } } }>;
        };
        expect(parsed.evidence[0]?.citation.locator.path).toBe("docs/architecture.md");
      }
    } finally {
      await client.close();
    }
  }, 20_000);
});
