import { createHash } from "node:crypto";
import { z } from "zod";
import { LlmWikiError } from "./errors.js";
import type {
  EmbeddingProviderKind,
  ProviderProfile,
} from "./types.js";

const MAX_VECTOR_DIMENSIONS = 32_768;

export interface EmbeddingClient {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  embedDocuments(inputs: string[]): Promise<number[][]>;
  embedQuery(input: string): Promise<number[]>;
}

export type EmbeddingClientFactory = (
  profile: ProviderProfile,
  secret: string,
) => EmbeddingClient;

export function createEmbeddingClient(
  profile: ProviderProfile,
  secret: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): EmbeddingClient {
  if (profile.kind !== "openai-compatible" && profile.kind !== "voyage") {
    throw new LlmWikiError(
      "INVALID_EMBEDDING_PROVIDER_KIND",
      "Embedding profiles must use openai-compatible or voyage.",
    );
  }
  if (secret.length === 0) {
    throw new LlmWikiError(
      "EMBEDDING_CREDENTIAL_UNAVAILABLE",
      `Embedding credential is unavailable for profile ${profile.name}.`,
    );
  }
  return new HttpEmbeddingClient(profile, secret, fetchImplementation);
}

export function embeddingProfileFingerprint(profile: ProviderProfile): string {
  if (profile.kind !== "openai-compatible" && profile.kind !== "voyage") {
    throw new LlmWikiError(
      "INVALID_EMBEDDING_PROVIDER_KIND",
      "Embedding profiles must use openai-compatible or voyage.",
    );
  }
  const canonical = JSON.stringify({
    name: profile.name,
    kind: profile.kind,
    model: profile.model,
    endpoint: new URL(embeddingEndpoint(profile)).href,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function normalizeEmbeddingVector(
  value: number[] | undefined,
): number[] {
  const vector = validateVector(value);
  const magnitude = Math.sqrt(
    vector.reduce((sum, item) => sum + item * item, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new LlmWikiError(
      "EMBEDDING_RESPONSE_INVALID",
      "Embedding provider returned a zero or invalid vector.",
    );
  }
  return vector.map((item) => item / magnitude);
}

export function embeddingDotProduct(
  left: readonly number[],
  right: readonly number[],
): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

class HttpEmbeddingClient implements EmbeddingClient {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  private readonly endpoint: string;

  constructor(
    profile: ProviderProfile,
    private readonly secret: string,
    private readonly fetchImplementation: typeof fetch,
  ) {
    if (profile.kind !== "openai-compatible" && profile.kind !== "voyage") {
      throw new LlmWikiError(
        "INVALID_EMBEDDING_PROVIDER_KIND",
        "Embedding profiles must use openai-compatible or voyage.",
      );
    }
    this.kind = profile.kind;
    this.model = profile.model;
    this.endpoint = embeddingEndpoint(profile);
  }

  async embedDocuments(inputs: string[]): Promise<number[][]> {
    return this.request(inputs, "document");
  }

  async embedQuery(input: string): Promise<number[]> {
    const vectors = await this.request([input], "query");
    const vector = vectors[0];
    if (vector === undefined) {
      throw new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned no query vector.",
      );
    }
    return vector;
  }

  private async request(
    inputs: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          ...(this.kind === "voyage" ? { input_type: inputType } : {}),
        }),
      });
    } catch {
      throw new LlmWikiError(
        "EMBEDDING_NETWORK_FAILED",
        "The embedding provider could not be reached.",
      );
    }
    if (!response.ok) {
      throw embeddingHttpError(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned invalid JSON.",
      );
    }
    const parsed = embeddingResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned an invalid response shape.",
      );
    }
    const ordered = parsed.data.data
      .sort((left, right) => left.index - right.index)
      .map((item) => validateVector(item.embedding));
    if (
      ordered.length !== inputs.length ||
      parsed.data.data.some((item, index) => item.index !== index)
    ) {
      throw new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned unexpected vector indexes.",
      );
    }
    return ordered;
  }
}

function embeddingEndpoint(profile: ProviderProfile): string {
  const defaultBase =
    profile.kind === "voyage"
      ? "https://api.voyageai.com/v1"
      : "https://api.openai.com/v1";
  const base = (profile.baseUrl ?? defaultBase).replace(/\/+$/u, "");
  return base.toLocaleLowerCase("en-US").endsWith("/embeddings")
    ? base
    : `${base}/embeddings`;
}

function embeddingHttpError(status: number): LlmWikiError {
  if (status === 401 || status === 403) {
    return new LlmWikiError(
      "EMBEDDING_AUTH_FAILED",
      "The embedding provider rejected its credential.",
    );
  }
  if (status === 402 || status === 429) {
    return new LlmWikiError(
      "EMBEDDING_QUOTA_EXCEEDED",
      "The embedding provider reported an exhausted quota or rate limit.",
    );
  }
  if (status === 404) {
    return new LlmWikiError(
      "EMBEDDING_MODEL_UNAVAILABLE",
      "The configured embedding model or endpoint is unavailable.",
    );
  }
  return new LlmWikiError(
    "EMBEDDING_REQUEST_FAILED",
    `The embedding provider request failed with HTTP ${status}.`,
  );
}

function validateVector(value: number[] | undefined): number[] {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_VECTOR_DIMENSIONS ||
    value.some((item) => !Number.isFinite(item))
  ) {
    throw new LlmWikiError(
      "EMBEDDING_RESPONSE_INVALID",
      "Embedding provider returned an invalid vector.",
    );
  }
  return value;
}

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
});
