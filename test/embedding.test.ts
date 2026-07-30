import { describe, expect, it, vi } from "vitest";
import { createEmbeddingClient } from "../src/embedding.js";
import type { ProviderProfile } from "../src/types.js";

describe("embedding HTTP clients", () => {
  it("uses the configured OpenAI-compatible endpoint and embedding credential", async () => {
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
    const fetchImplementation = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;
    const client = createEmbeddingClient(
      profile("embedding-openai", "openai-compatible", "embed-model", {
        baseUrl: "https://embedding.example.test/v1",
      }),
      "embedding-secret",
      fetchImplementation,
    );

    await expect(client.embedDocuments(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(String(requests[0]?.input)).toBe(
      "https://embedding.example.test/v1/embeddings",
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer embedding-secret",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: "embed-model",
      input: ["first", "second"],
    });
  });

  it("sends Voyage's document and query input types", async () => {
    const requestBodies: unknown[] = [];
    const fetchImplementation = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;
    const client = createEmbeddingClient(
      profile("embedding-voyage", "voyage", "voyage-3"),
      "voyage-secret",
      fetchImplementation,
    );

    await client.embedDocuments(["document"]);
    await client.embedQuery("query");
    expect(requestBodies).toEqual([
      { model: "voyage-3", input: ["document"], input_type: "document" },
      { model: "voyage-3", input: ["query"], input_type: "query" },
    ]);
  });

  it.each([
    [401, "EMBEDDING_AUTH_FAILED"],
    [429, "EMBEDDING_QUOTA_EXCEEDED"],
    [404, "EMBEDDING_MODEL_UNAVAILABLE"],
    [500, "EMBEDDING_REQUEST_FAILED"],
  ])("classifies HTTP %s without exposing provider response bodies", async (status, code) => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response("response contains secret-value", {
          status,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;
    const client = createEmbeddingClient(
      profile("embedding", "openai-compatible", "model"),
      "embedding-secret",
      fetchImplementation,
    );
    const rejected = await client.embedQuery("query").catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code });
    expect(String((rejected as Error).message)).not.toContain("secret-value");
  });
});

function profile(
  name: string,
  kind: "openai-compatible" | "voyage",
  model: string,
  options: { baseUrl?: string } = {},
): ProviderProfile {
  const now = new Date().toISOString();
  return {
    name,
    kind,
    model,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    credential: { store: "env", envName: `${name.toUpperCase()}_KEY` },
    createdAt: now,
    updatedAt: now,
  };
}
