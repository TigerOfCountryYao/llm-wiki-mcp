import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { findProviderProfile } from "./config.js";
import { credentialStoreForProfile } from "./credentials.js";
import {
  createEmbeddingClient,
  embeddingProfileFingerprint,
  type EmbeddingClientFactory,
} from "./embedding.js";
import { LlmWikiError } from "./errors.js";
import { readJsonFile } from "./fs-utils.js";
import {
  catalogCompiledWikiPages,
  type CompiledWikiPage,
} from "./pages.js";
import { projectPaths } from "./paths.js";
import {
  rankSemanticIndex,
  readSemanticIndex,
} from "./semantic-cache.js";
import { readCurrent } from "./state.js";
import { getProjectStatus } from "./status.js";
import type {
  CompiledWikiPageCitation,
  ExploreEvidence,
  ExploreResult,
  FileLocator,
  GenerationManifest,
  ProxyRecord,
  SourceLocator,
} from "./types.js";

export interface ExploreOptions {
  maxResults?: number;
  environment?: NodeJS.ProcessEnv;
  embeddingClientFactory?: EmbeddingClientFactory;
}

interface RankedPageEvidence {
  pageId: string;
  exact: boolean;
  evidence: ExploreEvidence;
}

export async function exploreWiki(
  root: string,
  query: string,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    throw new LlmWikiError(
      "EMPTY_QUERY",
      "wiki_explore requires a non-empty query.",
    );
  }
  const maximum = Math.min(20, Math.max(1, options.maxResults ?? 8));
  const [current, projectStatus] = await Promise.all([
    readCurrent(root),
    getProjectStatus(root),
  ]);
  if (current === null) {
    return {
      query: trimmedQuery,
      status: {
        state: projectStatus.state,
        ...(projectStatus.reasonCode === undefined
          ? {}
          : { reasonCode: projectStatus.reasonCode }),
        ...(projectStatus.message === undefined
          ? {}
          : { message: projectStatus.message }),
        semantic: "disabled",
      },
      evidence: [],
      warnings: ["No successful Wiki generation is available."],
    };
  }

  const paths = projectPaths(root);
  const generationRoot = path.join(paths.generations, current.generation);
  const manifest = await readJsonFile<GenerationManifest>(
    path.join(generationRoot, "manifest.json"),
  );
  if (manifest.generation !== current.generation) {
    throw new LlmWikiError(
      "GENERATION_MISMATCH",
      "The current pointer does not match the generation manifest.",
    );
  }
  const pages = await catalogCompiledWikiPages(
    generationRoot,
    manifest.proxies,
    new Set(manifest.sources.map((source) => source.sourceId)),
    undefined,
    manifest.pages,
  );
  const lexical = lexicalPageEvidence(
    pages,
    manifest,
    current.generation,
    trimmedQuery,
  );
  const warnings: string[] = [];
  let semanticState: "disabled" | "available" | "unavailable" =
    manifest.semantic.enabled ? "unavailable" : "disabled";
  let semanticReasonCode = manifest.semantic.reasonCode;
  let semantic: RankedPageEvidence[] = [];
  if (manifest.semantic.enabled && manifest.semantic.available) {
    try {
      semantic = await semanticPageEvidence(
        root,
        pages,
        manifest,
        current.generation,
        trimmedQuery,
        maximum,
        options,
      );
      semanticState = "available";
      semanticReasonCode = "SEMANTIC_READY";
    } catch (error) {
      semanticState = "unavailable";
      semanticReasonCode =
        error instanceof LlmWikiError
          ? error.code
          : "SEMANTIC_QUERY_FAILED";
      warnings.push(
        `Semantic retrieval unavailable: ${semanticReasonCode}.`,
      );
    }
  }
  if (projectStatus.state !== "ready") {
    warnings.push(
      `Serving last-known-good generation ${current.generation}; project state is ${projectStatus.state}.`,
    );
  }
  if (manifest.semantic.enabled && !manifest.semantic.available) {
    warnings.push(
      `Semantic retrieval unavailable: ${manifest.semantic.reasonCode}.`,
    );
  }
  for (const source of manifest.unsupported.slice(0, 20)) {
    warnings.push(
      `Unsupported source ${source.relativePath}: ${source.reason}.`,
    );
  }
  if (manifest.unsupported.length > 20) {
    warnings.push(
      `${manifest.unsupported.length - 20} additional unsupported sources omitted.`,
    );
  }

  return {
    query: trimmedQuery,
    status: {
      state: projectStatus.state,
      generation: current.generation,
      builtAt: current.builtAt,
      ...(projectStatus.reasonCode === undefined
        ? {}
        : { reasonCode: projectStatus.reasonCode }),
      ...(projectStatus.message === undefined
        ? {}
        : { message: projectStatus.message }),
      semantic: semanticState,
      semanticReasonCode,
    },
    evidence: reciprocalRankEvidence(semantic, lexical, maximum),
    warnings,
  };
}

function lexicalPageEvidence(
  pages: readonly CompiledWikiPage[],
  manifest: GenerationManifest,
  generation: string,
  query: string,
): RankedPageEvidence[] {
  const tokens = tokenize(query);
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return pages
    .map((page): RankedPageEvidence | null => {
      const lines = normalizedLines(page.body);
      const lowerBody = page.body.toLocaleLowerCase("en-US");
      const lowerTitle = page.title.toLocaleLowerCase("en-US");
      const lowerId = page.pageId.toLocaleLowerCase("en-US");
      let score = 0;
      let bestLineIndex = 0;
      let bestLineScore = -1;
      for (const token of tokens) {
        score += countOccurrences(lowerBody, token);
        if (lowerTitle.includes(token)) {
          score += 5;
        }
        if (lowerId.includes(token)) {
          score += 7;
        }
      }
      for (const [lineIndex, line] of lines.entries()) {
        const lowerLine = line.toLocaleLowerCase("en-US");
        const lineScore = tokens.reduce(
          (total, token) =>
            total + countOccurrences(lowerLine, token),
          0,
        );
        if (lineScore > bestLineScore) {
          bestLineIndex = lineIndex;
          bestLineScore = lineScore;
        }
      }
      const exact =
        normalizedQuery.includes(lowerTitle) ||
        normalizedQuery.includes(lowerId);
      if (score <= 0 && !exact) {
        return null;
      }
      if (exact && bestLineScore <= 0) {
        bestLineIndex =
          page.citations.find(
            (citation) => citation.pageLineIndex !== undefined,
          )?.pageLineIndex ?? bestLineIndex;
      }
      const start = Math.max(0, bestLineIndex - 2);
      const end = Math.min(lines.length, bestLineIndex + 3);
      const citation = evidenceCitation(
        page,
        manifest,
        generation,
        bestLineIndex,
        bestLineIndex + 1,
      );
      if (citation === null) {
        return null;
      }
      return {
        pageId: page.pageId,
        exact,
        evidence: {
          title: page.title,
          snippet: clipSnippet(lines.slice(start, end).join("\n")),
          score: exact ? score + 1_000 : score,
          retrieval: "lexical",
          citation,
        },
      };
    })
    .filter((item): item is RankedPageEvidence => item !== null)
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.evidence.score - left.evidence.score ||
        left.pageId.localeCompare(right.pageId),
    );
}

async function semanticPageEvidence(
  root: string,
  pages: readonly CompiledWikiPage[],
  manifest: GenerationManifest,
  generation: string,
  query: string,
  maximum: number,
  options: ExploreOptions,
): Promise<RankedPageEvidence[]> {
  const profileName = manifest.semantic.profile;
  if (profileName === null) {
    throw new LlmWikiError(
      "SEMANTIC_PROFILE_UNAVAILABLE",
      "Current generation does not name an embedding profile.",
    );
  }
  if (profileName === manifest.provider.profile) {
    throw new LlmWikiError(
      "SEMANTIC_PROFILE_MUST_DIFFER",
      "Current generation incorrectly reuses its generation profile for embeddings.",
    );
  }
  const environment = options.environment ?? process.env;
  const profile = await findProviderProfile(profileName, environment);
  if (
    profile === null ||
    (profile.kind !== "openai-compatible" && profile.kind !== "voyage") ||
    profile.kind !== manifest.semantic.kind ||
    profile.model !== manifest.semantic.model ||
    manifest.semantic.profileFingerprint === undefined ||
    embeddingProfileFingerprint(profile) !==
      manifest.semantic.profileFingerprint
  ) {
    throw new LlmWikiError(
      profile === null
        ? "SEMANTIC_PROFILE_UNAVAILABLE"
        : "SEMANTIC_PROFILE_CHANGED",
      profile === null
        ? `Embedding profile is unavailable: ${profileName}`
        : "Embedding profile changed after this generation was built.",
    );
  }
  let secret: string | null;
  try {
    secret = await credentialStoreForProfile(profile, environment).get(profile);
  } catch {
    secret = null;
  }
  if (secret === null) {
    throw new LlmWikiError(
      "SEMANTIC_CREDENTIAL_UNAVAILABLE",
      `Credential is unavailable for embedding profile ${profile.name}.`,
    );
  }
  await assertCredentialIsIndependent(manifest, secret, environment);
  const index = await readSemanticIndex(
    projectPaths(root).semanticIndex,
    pages,
    {
      profile: profile.name,
      kind: profile.kind,
      model: profile.model,
      profileFingerprint: manifest.semantic.profileFingerprint,
    },
  );
  if (index === null) {
    throw new LlmWikiError(
      "SEMANTIC_INDEX_UNAVAILABLE",
      "Current compiled Wiki pages have no semantic index.",
    );
  }
  const client = (options.embeddingClientFactory ?? createEmbeddingClient)(
    profile,
    secret,
  );
  if (client.kind !== profile.kind || client.model !== profile.model) {
    throw new LlmWikiError(
      "SEMANTIC_CLIENT_PROFILE_MISMATCH",
      "Embedding client does not match the current generation profile.",
    );
  }
  const ranked = rankSemanticIndex(
    index,
    await client.embedQuery(query),
    maximum * 4,
  );
  const byPage = new Map(pages.map((page) => [page.pageId, page] as const));
  const best = new Map<string, RankedPageEvidence>();
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  for (const match of ranked) {
    const page = byPage.get(match.pageId);
    if (page === undefined || page.contentHash !== match.contentHash) {
      continue;
    }
    const lines = normalizedLines(page.body);
    const start = match.startLineIndex;
    const end = Math.min(
      lines.length,
      Math.min(match.endLineIndex + 1, match.startLineIndex + 5),
    );
    const citation = evidenceCitation(page, manifest, generation, start, end);
    if (citation === null) {
      continue;
    }
    const candidate: RankedPageEvidence = {
      pageId: page.pageId,
      exact:
        normalizedQuery.includes(page.title.toLocaleLowerCase("en-US")) ||
        normalizedQuery.includes(page.pageId.toLocaleLowerCase("en-US")),
      evidence: {
        title: page.title,
        snippet: clipSnippet(lines.slice(start, end).join("\n")),
        score: match.score,
        retrieval: "semantic",
        citation,
      },
    };
    const prior = best.get(page.pageId);
    if (
      prior === undefined ||
      candidate.evidence.score > prior.evidence.score
    ) {
      best.set(page.pageId, candidate);
    }
  }
  return [...best.values()].sort(
    (left, right) =>
      right.evidence.score - left.evidence.score ||
      left.pageId.localeCompare(right.pageId),
  );
}

function reciprocalRankEvidence(
  semantic: readonly RankedPageEvidence[],
  lexical: readonly RankedPageEvidence[],
  maximum: number,
): ExploreEvidence[] {
  const semanticRank = new Map(
    semantic.map((candidate, index) => [candidate.pageId, index + 1]),
  );
  const lexicalRank = new Map(
    lexical.map((candidate, index) => [candidate.pageId, index + 1]),
  );
  const byPage = new Map<string, RankedPageEvidence>();
  for (const candidate of [...semantic, ...lexical]) {
    const prior = byPage.get(candidate.pageId);
    if (
      prior === undefined ||
      (candidate.evidence.retrieval === "semantic" &&
        prior.evidence.retrieval !== "semantic")
    ) {
      byPage.set(candidate.pageId, candidate);
    }
  }
  return [...byPage.values()]
    .map((candidate) => {
      const semanticPosition = semanticRank.get(candidate.pageId);
      const lexicalPosition = lexicalRank.get(candidate.pageId);
      return {
        candidate,
        score:
          (candidate.exact ? 1_000 : 0) +
          (semanticPosition === undefined
            ? 0
            : 1 / (60 + semanticPosition)) +
          (lexicalPosition === undefined
            ? 0
            : 1 / (60 + lexicalPosition)),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.pageId.localeCompare(right.candidate.pageId),
    )
    .slice(0, maximum)
    .map(({ candidate, score }) => ({
      ...candidate.evidence,
      score,
    }));
}

function evidenceCitation(
  page: CompiledWikiPage,
  manifest: GenerationManifest,
  generation: string,
  startLineIndex: number,
  endLineIndex: number,
): ExploreEvidence["citation"] | null {
  const citation = nearestCitation(
    page.citations,
    startLineIndex,
    endLineIndex,
  );
  if (citation === undefined) {
    return null;
  }
  const proxy = manifest.proxies.find(
    (candidate) => candidate.proxyId === citation.proxyId,
  );
  if (proxy === undefined) {
    return null;
  }
  return {
    locator:
      citation.engineStartLine === undefined &&
      citation.pageLineIndex === undefined
        ? narrowProxyLocator(proxy, startLineIndex, endLineIndex)
        : mapCompilerCitation(
            proxy,
            citation.engineStartLine,
            citation.engineEndLine,
          ),
    sourceHash: proxy.sourceHash,
    generation,
  };
}

function narrowProxyLocator(
  proxy: ProxyRecord,
  startLineIndex: number,
  endLineIndex: number,
): SourceLocator {
  if (proxy.locator.kind !== "file") {
    return proxy.locator;
  }
  const mapped = proxy.lineMap?.slice(startLineIndex, endLineIndex);
  if (mapped === undefined || mapped.length === 0) {
    return proxy.locator;
  }
  return {
    kind: "file",
    path: proxy.locator.path,
    lineStart: Math.min(...mapped),
    lineEnd: Math.max(...mapped),
  };
}

function nearestCitation(
  citations: readonly CompiledWikiPageCitation[],
  startLineIndex: number,
  endLineIndex: number,
): CompiledWikiPageCitation | undefined {
  const best = [...citations].sort((left, right) => {
    const leftDistance = citationDistance(
      left.pageLineIndex,
      startLineIndex,
      endLineIndex,
    );
    const rightDistance = citationDistance(
      right.pageLineIndex,
      startLineIndex,
      endLineIndex,
    );
    return leftDistance - rightDistance;
  })[0];
  if (
    best?.pageLineIndex !== undefined &&
    citationDistance(best.pageLineIndex, startLineIndex, endLineIndex) > 2
  ) {
    return undefined;
  }
  return best;
}

function citationDistance(
  line: number | undefined,
  start: number,
  end: number,
): number {
  if (line === undefined || (line >= start && line < end)) {
    return 0;
  }
  return line < start ? start - line : line - end + 1;
}

async function assertCredentialIsIndependent(
  manifest: GenerationManifest,
  embeddingSecret: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const generationProfileName = manifest.provider.profile;
  if (generationProfileName === null) {
    return;
  }
  const generationProfile = await findProviderProfile(
    generationProfileName,
    environment,
  );
  if (generationProfile === null) {
    return;
  }
  let generationSecret: string | null = null;
  try {
    generationSecret = await credentialStoreForProfile(
      generationProfile,
      environment,
    ).get(generationProfile);
  } catch {
    return;
  }
  if (
    generationSecret !== null &&
    secretsMatch(generationSecret, embeddingSecret)
  ) {
    throw new LlmWikiError(
      "SEMANTIC_CREDENTIAL_MUST_DIFFER",
      "The embedding credential must differ from the Wiki generation credential.",
    );
  }
}

export function mapCompilerCitation(
  proxy: ProxyRecord,
  start: number | undefined,
  end: number | undefined,
): SourceLocator {
  if (
    proxy.locator.kind !== "file" ||
    start === undefined ||
    end === undefined ||
    proxy.engineBodyStartLine === undefined ||
    proxy.lineMap === undefined
  ) {
    return proxy.locator;
  }
  const startIndex = start - proxy.engineBodyStartLine;
  const endIndex = end - proxy.engineBodyStartLine;
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex
  ) {
    return proxy.locator;
  }
  const mapped = proxy.lineMap.slice(startIndex, endIndex + 1);
  if (mapped.length === 0) {
    return proxy.locator;
  }
  const locator: FileLocator = {
    kind: "file",
    path: proxy.locator.path,
    lineStart: Math.min(...mapped),
    lineEnd: Math.max(...mapped),
  };
  return locator;
}

function normalizedLines(value: string): string[] {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function tokenize(value: string): string[] {
  const lower = value.toLocaleLowerCase("en-US");
  const tokens = new Set<string>();
  for (const match of lower.matchAll(/[\p{L}\p{N}_-]+/gu)) {
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
  if (tokens.size === 0) {
    tokens.add(lower);
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

function clipSnippet(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 2_000
    ? trimmed
    : `${trimmed.slice(0, 1_999)}…`;
}

function secretsMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
