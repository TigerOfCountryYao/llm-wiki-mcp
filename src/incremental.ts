import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EmbeddingClient } from "./embedding.js";
import { LlmWikiError } from "./errors.js";
import { rankSemanticIndex } from "./semantic-cache.js";
import type { CompiledWikiPage } from "./pages.js";
import type {
  IncrementalPageCandidate,
  ProxyRecord,
  SemanticIndex,
} from "./types.js";

const MAX_CHANGED_PROXIES = 32;
const MAX_QUERY_CHARS = 2_000;
const MAX_EVIDENCE_CHARS = 1_200;
const PER_QUERY_CANDIDATES = 8;
const MAX_TOTAL_CANDIDATES = 24;
const RRF_K = 60;
const FALLBACK_EMBEDDING_CODES = new Set([
  "EMBEDDING_AUTH_FAILED",
  "EMBEDDING_QUOTA_EXCEEDED",
  "EMBEDDING_MODEL_UNAVAILABLE",
  "EMBEDDING_NETWORK_FAILED",
  "EMBEDDING_REQUEST_FAILED",
  "EMBEDDING_RESPONSE_INVALID",
  "EMBEDDING_DIMENSION_MISMATCH",
]);

export interface IncrementalCandidateSelection {
  candidates: IncrementalPageCandidate[];
  semanticFailure: LlmWikiError | null;
  invalidateSemanticIndex: boolean;
}

export async function selectIncrementalPageCandidates(input: {
  generationRoot: string;
  currentProxies: readonly ProxyRecord[];
  previousProxies: readonly ProxyRecord[];
  previousPages: readonly CompiledWikiPage[];
  semanticIndex: SemanticIndex | null;
  embeddingClient: EmbeddingClient | null;
}): Promise<IncrementalCandidateSelection> {
  const previousBySourceChunk = new Map(
    input.previousProxies.map(
      (proxy) => [`${proxy.sourceId}\0${proxy.chunkIndex}`, proxy] as const,
    ),
  );
  const changed = input.currentProxies
    .filter(
      (proxy) =>
        previousBySourceChunk.get(`${proxy.sourceId}\0${proxy.chunkIndex}`)
          ?.bodyHash !== proxy.bodyHash,
    )
    .slice(0, MAX_CHANGED_PROXIES);
  if (changed.length === 0 || input.previousPages.length === 0) {
    return {
      candidates: [],
      semanticFailure: null,
      invalidateSemanticIndex: false,
    };
  }

  const accumulated = new Map<string, IncrementalPageCandidate>();
  let semanticCircuitOpen = false;
  let semanticFailure: LlmWikiError | null = null;
  let invalidateSemanticIndex = false;
  for (const proxy of changed) {
    const query = await incrementalQuery(input.generationRoot, proxy);
    const lexical = lexicalPageRanks(input.previousPages, query);
    let semantic: Array<{ pageId: string; score: number }> = [];
    if (
      !semanticCircuitOpen &&
      input.semanticIndex !== null &&
      input.embeddingClient !== null
    ) {
      try {
        const vector = await input.embeddingClient.embedQuery(query);
        const rankedSegments = rankSemanticIndex(
          input.semanticIndex,
          vector,
          PER_QUERY_CANDIDATES * 4,
        );
        const bestByPage = new Map<string, number>();
        for (const segment of rankedSegments) {
          bestByPage.set(
            segment.pageId,
            Math.max(bestByPage.get(segment.pageId) ?? -Infinity, segment.score),
          );
        }
        semantic = [...bestByPage]
          .map(([pageId, score]) => ({ pageId, score }))
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.pageId.localeCompare(right.pageId),
          )
          .slice(0, PER_QUERY_CANDIDATES);
      } catch (error) {
        if (
          !(error instanceof LlmWikiError) ||
          !FALLBACK_EMBEDDING_CODES.has(error.code)
        ) {
          throw error;
        }
        semanticCircuitOpen = true;
        if (error.code === "EMBEDDING_DIMENSION_MISMATCH") {
          invalidateSemanticIndex = true;
        } else {
          semanticFailure = error;
        }
      }
    }
    for (const candidate of reciprocalRankFusion(
      input.previousPages,
      query,
      lexical,
      semantic,
    ).slice(0, PER_QUERY_CANDIDATES)) {
      const prior = accumulated.get(candidate.pageId);
      if (prior === undefined || candidate.score > prior.score) {
        accumulated.set(candidate.pageId, candidate);
      }
    }
  }
  return {
    candidates: [...accumulated.values()]
      .sort(
        (left, right) =>
          right.score - left.score || left.pageId.localeCompare(right.pageId),
      )
      .slice(0, MAX_TOTAL_CANDIDATES),
    semanticFailure,
    invalidateSemanticIndex,
  };
}

async function incrementalQuery(
  generationRoot: string,
  proxy: ProxyRecord,
): Promise<string> {
  const evidence = await readFile(
    path.join(generationRoot, "proxy-inputs", proxy.proxyFile),
    "utf8",
  );
  const clippedEvidence = evidence.slice(0, MAX_EVIDENCE_CHARS);
  return [
    `Topic: ${proxy.title}`,
    `Source: ${JSON.stringify(proxy.locator)}`,
    `Evidence: ${clippedEvidence}`,
  ]
    .join("\n")
    .slice(0, MAX_QUERY_CHARS);
}

function lexicalPageRanks(
  pages: readonly CompiledWikiPage[],
  query: string,
): Array<{ pageId: string; score: number }> {
  const tokens = tokenize(query);
  return pages
    .map((page) => {
      const body = page.body.toLocaleLowerCase("en-US");
      const title = page.title.toLocaleLowerCase("en-US");
      const pageId = page.pageId.toLocaleLowerCase("en-US");
      let score = 0;
      for (const token of tokens) {
        score += countOccurrences(body, token);
        if (title.includes(token)) {
          score += 5;
        }
        if (pageId.includes(token)) {
          score += 7;
        }
      }
      return { pageId: page.pageId, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.pageId.localeCompare(right.pageId),
    );
}

function reciprocalRankFusion(
  pages: readonly CompiledWikiPage[],
  query: string,
  lexical: readonly { pageId: string; score: number }[],
  semantic: readonly { pageId: string; score: number }[],
): IncrementalPageCandidate[] {
  const lexicalRanks = new Map(
    lexical.map((candidate, index) => [candidate.pageId, index + 1]),
  );
  const semanticRanks = new Map(
    semantic.map((candidate, index) => [candidate.pageId, index + 1]),
  );
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return pages
    .filter(
      (page) =>
        lexicalRanks.has(page.pageId) || semanticRanks.has(page.pageId),
    )
    .map((page) => {
      const lexicalRank = lexicalRanks.get(page.pageId);
      const semanticRank = semanticRanks.get(page.pageId);
      const exact =
        normalizedQuery.includes(page.pageId.toLocaleLowerCase("en-US")) ||
        normalizedQuery.includes(page.title.toLocaleLowerCase("en-US"));
      return {
        pageId: page.pageId,
        relativePath: page.relativePath,
        title: page.title,
        retrieval:
          lexicalRank !== undefined && semanticRank !== undefined
            ? ("lexical+semantic" as const)
            : semanticRank !== undefined
              ? ("semantic" as const)
              : ("lexical" as const),
        score:
          (exact ? 1_000 : 0) +
          (lexicalRank === undefined ? 0 : 1 / (RRF_K + lexicalRank)) +
          (semanticRank === undefined ? 0 : 1 / (RRF_K + semanticRank)),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.pageId.localeCompare(right.pageId),
    );
}

function tokenize(value: string): string[] {
  const tokens = new Set<string>();
  for (const match of value
    .toLocaleLowerCase("en-US")
    .matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const token = match[0];
    if (/[\u3400-\u9fff]/u.test(token)) {
      const characters = [...token];
      for (const character of characters) {
        tokens.add(character);
      }
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`);
      }
    } else if (token.length > 1) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (needle.length > 0 && position < haystack.length) {
    const match = haystack.indexOf(needle, position);
    if (match === -1) {
      break;
    }
    count += 1;
    position = match + needle.length;
  }
  return count;
}
