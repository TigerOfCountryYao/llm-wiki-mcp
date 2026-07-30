import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exploreWiki } from "./explore.js";
import { PACKAGE_VERSION } from "./version.js";

export async function startMcpServer(root: string): Promise<void> {
  const server = new McpServer({
    name: "llm-wiki",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "wiki_explore",
    {
      title: "Explore the project Wiki",
      description:
        "Search the last-known-good project Wiki and return grounded evidence with original-source locators. This tool is read-only.",
      inputSchema: {
        query: z.string().trim().min(1).max(10_000),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, maxResults }) => {
      const result = await exploreWiki(root, query, {
        ...(maxResults === undefined ? {} : { maxResults }),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
