import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LlmWikiError } from "./errors.js";
import { readJsonIfExists, writeJsonAtomic } from "./fs-utils.js";
import {
  STATE_SCHEMA_VERSION,
  type EmbeddingProviderKind,
  type ProviderProfile,
  type ProxyRecord,
  type SemanticIndex,
  type SemanticIndexEntry,
} from "./types.js";

const MAX_EMBEDDING_INPUT_CHARS = 6_000;
const MAX_BATCH_SIZE = 64;
const MAX_BATCH_INPUT_CHARS = 96_000;
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

export async function buildSemanticIndex(
  generationRoot: string,
  proxies: ProxyRecord[],
  profile: ProviderProfile,
  secret: string,
  options: {
    clientFactory?: EmbeddingClientFactory;
    previousIndex?: SemanticIndex | null;
  } = {},
): Promise<SemanticIndex> {
  const client = (options.clientFactory ?? createEmbeddingClient)(profile, secret);
  if (client.kind !== profile.kind || client.model !== profile.model) {
    throw new LlmWikiError(
      "EMBEDDING_CLIENT_PROFILE_MISMATCH",
      "Embedding client does not match the selected embedding profile.",
    );
  }
  const profileFingerprint = embeddingProfileFingerprint(profile);
  const previous =
    options.previousIndex?.profile === profile.name &&
    options.previousIndex.kind === client.kind &&
    options.previousIndex.model === client.model &&
    options.previousIndex.profileFingerprint === profileFingerprint
      ? new Map(
          options.previousIndex.entries.map((entry) => [
            semanticEntryKey(entry),
            entry,
          ]),
        )
      : new Map<string, SemanticIndexEntry>();
  const entries: SemanticIndexEntry[] = [];
  const pending: Array<{
    proxy: ProxyRecord;
    segmentIndex: number;
    startLineIndex: number;
    endLineIndex: number;
    text: string;
  }> = [];

  for (const proxy of proxies) {
    const body = await readFile(
      path.join(generationRoot, "proxy-inputs", proxy.proxyFile),
      "utf8",
    );
    for (const [segmentIndex, segment] of splitEmbeddingSegments(body).entries()) {
      const key = semanticEntryKey({
        proxyId: proxy.proxyId,
        bodyHash: proxy.bodyHash,
        segmentIndex,
        startLineIndex: segment.startLineIndex,
        endLineIndex: segment.endLineIndex,
      });
      const reusable = previous.get(key);
      if (reusable !== undefined) {
        entries.push(reusable);
      } else {
        pending.push({ proxy, segmentIndex, ...segment });
      }
    }
  }

  for (let offset = 0; offset < pending.length; ) {
    const batch: typeof pending = [];
    let batchCharacters = 0;
    while (offset < pending.length && batch.length < MAX_BATCH_SIZE) {
      const item = pending[offset]!;
      if (
        batch.length > 0 &&
        batchCharacters + item.text.length > MAX_BATCH_INPUT_CHARS
      ) {
        break;
      }
      batch.push(item);
      batchCharacters += item.text.length;
      offset += 1;
    }
    const vectors = await client.embedDocuments(batch.map((item) => item.text));
    if (vectors.length !== batch.length) {
      throw new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned an unexpected number of vectors.",
      );
    }
    for (const [index, item] of batch.entries()) {
      entries.push({
        proxyId: item.proxy.proxyId,
        bodyHash: item.proxy.bodyHash,
        segmentIndex: item.segmentIndex,
        startLineIndex: item.startLineIndex,
        endLineIndex: item.endLineIndex,
        vector: normalizeVector(vectors[index]),
      });
    }
  }

  entries.sort(
    (left, right) =>
      left.proxyId.localeCompare(right.proxyId) ||
      left.segmentIndex - right.segmentIndex,
  );
  const dimensions = entries[0]?.vector.length ?? 0;
  if (entries.some((entry) => entry.vector.length !== dimensions)) {
    throw new LlmWikiError(
      "EMBEDDING_DIMENSION_MISMATCH",
      "Embedding provider returned inconsistent vector dimensions.",
    );
  }
  const index: SemanticIndex = {
    schemaVersion: STATE_SCHEMA_VERSION,
    profile: profile.name,
    kind: client.kind,
    model: client.model,
    profileFingerprint,
    dimensions,
    createdAt: new Date().toISOString(),
    entries,
  };
  await mkdir(path.join(generationRoot, "semantic"), { recursive: true });
  await writeJsonAtomic(path.join(generationRoot, "semantic", "index.json"), index);
  return index;
}

export async function readSemanticIndex(
  generationRoot: string,
): Promise<SemanticIndex | null> {
  const raw = await readJsonIfExists<unknown>(
    path.join(generationRoot, "semantic", "index.json"),
  );
  if (raw === null) {
    return null;
  }
  const parsed = semanticIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmWikiError(
      "SEMANTIC_INDEX_INVALID",
      "The current generation semantic index is invalid.",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function rankSemanticIndex(
  index: SemanticIndex,
  queryVector: number[],
  maximum: number,
): Array<SemanticIndexEntry & { score: number }> {
  const normalizedQuery = normalizeVector(queryVector);
  if (normalizedQuery.length !== index.dimensions) {
    throw new LlmWikiError(
      "EMBEDDING_DIMENSION_MISMATCH",
      "Query vector dimensions do not match the semantic index.",
    );
  }
  return index.entries
    .map((entry) => ({
      ...entry,
      score: dotProduct(normalizedQuery, entry.vector),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.proxyId.localeCompare(right.proxyId) ||
        left.segmentIndex - right.segmentIndex,
    )
    .slice(0, Math.max(0, maximum));
}

function splitEmbeddingSegments(text: string): Array<{
  text: string;
  startLineIndex: number;
  endLineIndex: number;
}> {
  if (text.trim().length === 0) {
    return [];
  }
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const units = lines.flatMap((line, lineIndex) => {
    if (line.length <= MAX_EMBEDDING_INPUT_CHARS) {
      return [{ text: line, lineIndex }];
    }
    const result: Array<{ text: string; lineIndex: number }> = [];
    for (let offset = 0; offset < line.length; offset += MAX_EMBEDDING_INPUT_CHARS) {
      result.push({
        text: line.slice(offset, offset + MAX_EMBEDDING_INPUT_CHARS),
        lineIndex,
      });
    }
    return result;
  });
  const segments: Array<{
    text: string;
    startLineIndex: number;
    endLineIndex: number;
  }> = [];
  let current: Array<{ text: string; lineIndex: number }> = [];
  let length = 0;
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    segments.push({
      text: current.map((unit) => unit.text).join("\n"),
      startLineIndex: current[0]!.lineIndex,
      endLineIndex: current.at(-1)!.lineIndex,
    });
    current = [];
    length = 0;
  };
  for (const unit of units) {
    const nextLength = length + (current.length === 0 ? 0 : 1) + unit.text.length;
    if (current.length > 0 && nextLength > MAX_EMBEDDING_INPUT_CHARS) {
      flush();
    }
    current.push(unit);
    length += (current.length === 1 ? 0 : 1) + unit.text.length;
    if (length === MAX_EMBEDDING_INPUT_CHARS) {
      flush();
    }
  }
  flush();
  return segments;
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

function normalizeVector(value: number[] | undefined): number[] {
  const vector = validateVector(value);
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new LlmWikiError(
      "EMBEDDING_RESPONSE_INVALID",
      "Embedding provider returned a zero or invalid vector.",
    );
  }
  return vector.map((item) => item / magnitude);
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

function dotProduct(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

function semanticEntryKey(
  value: Pick<
    SemanticIndexEntry,
    | "proxyId"
    | "bodyHash"
    | "segmentIndex"
    | "startLineIndex"
    | "endLineIndex"
  >,
): string {
  return `${value.proxyId}\0${value.bodyHash}\0${value.segmentIndex}\0${value.startLineIndex}\0${value.endLineIndex}`;
}

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
});

const semanticIndexSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    profile: z.string().min(1),
    kind: z.enum(["openai-compatible", "voyage"]),
    model: z.string().min(1),
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    dimensions: z.number().int().nonnegative().max(MAX_VECTOR_DIMENSIONS),
    createdAt: z.iso.datetime(),
    entries: z.array(
      z.object({
        proxyId: z.string().min(1),
        bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
        segmentIndex: z.number().int().nonnegative(),
        startLineIndex: z.number().int().nonnegative(),
        endLineIndex: z.number().int().nonnegative(),
        vector: z.array(z.number()),
      }),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const entry of value.entries) {
      if (
        entry.endLineIndex < entry.startLineIndex ||
        entry.vector.length !== value.dimensions
      ) {
        context.addIssue({
          code: "custom",
          message: "Semantic index entry boundaries or dimensions are invalid.",
        });
      }
      const magnitude = Math.sqrt(
        entry.vector.reduce((sum, item) => sum + item * item, 0),
      );
      if (!Number.isFinite(magnitude) || Math.abs(magnitude - 1) > 1e-6) {
        context.addIssue({
          code: "custom",
          message: "Semantic index entry vector is not normalized.",
        });
      }
      const key = semanticEntryKey(entry);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Semantic index contains duplicate entries.",
        });
      }
      seen.add(key);
    }
  });
