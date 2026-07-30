import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWiki, type ContextPack } from "llm-wiki-compiler";
import { findProviderProfile } from "./config.js";
import { credentialStoreForProfile } from "./credentials.js";
import {
  createEmbeddingClient,
  embeddingProfileFingerprint,
  rankSemanticIndex,
  readSemanticIndex,
  type EmbeddingClientFactory,
} from "./embedding.js";
import { LlmWikiError } from "./errors.js";
import { readJsonFile } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { readCurrent } from "./state.js";
import { getProjectStatus } from "./status.js";
import type {
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

export async function exploreWiki(
  root: string,
  query: string,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    throw new LlmWikiError("EMPTY_QUERY", "wiki_explore requires a non-empty query.");
  }
  const maxResults = Math.min(20, Math.max(1, options.maxResults ?? 8));
  const [current, projectStatus] = await Promise.all([readCurrent(root), getProjectStatus(root)]);
  const semantic = "disabled" as const;

  if (current === null) {
    return {
      query: trimmedQuery,
      status: {
        state: projectStatus.state,
        ...(projectStatus.reasonCode === undefined
          ? {}
          : { reasonCode: projectStatus.reasonCode }),
        ...(projectStatus.message === undefined ? {} : { message: projectStatus.message }),
        semantic,
      },
      evidence: [],
      warnings: ["No successful Wiki generation is available."],
    };
  }

  const generationRoot = path.join(projectPaths(root).generations, current.generation);
  const manifest = await readJsonFile<GenerationManifest>(
    path.join(generationRoot, "manifest.json"),
  );
  if (manifest.generation !== current.generation) {
    throw new LlmWikiError(
      "GENERATION_MISMATCH",
      "The current pointer does not match the generation manifest.",
    );
  }

  const queryTokens = tokenize(trimmedQuery);
  let lexicalEvidence: ExploreEvidence[];
  const retrievalWarnings: string[] = [];
  if (manifest.engine.name === "llm-wiki-compiler") {
    const pack = await createWiki({ root: path.join(generationRoot, "engine") }).getContextPack({
      prompt: trimmedQuery,
      budget: 8_000,
      topPages: maxResults,
      topChunks: 0,
    });
    const mapped = evidenceFromContextPack(pack, manifest, current.generation);
    lexicalEvidence = mapped.evidence;
    retrievalWarnings.push(...mapped.warnings);
  } else {
    const evidenceCandidates = await Promise.all(
      manifest.proxies.map((proxy) =>
        scoreProxy(generationRoot, proxy, queryTokens, current.generation),
      ),
    );
    lexicalEvidence = evidenceCandidates
      .filter((item): item is ExploreEvidence => item !== null)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, maxResults);
  }

  const warnings: string[] = [];
  warnings.push(...retrievalWarnings);
  let semanticState: "disabled" | "available" | "unavailable" =
    manifest.semantic.enabled ? "unavailable" : "disabled";
  let semanticReasonCode = manifest.semantic.reasonCode;
  let semanticEvidence: ExploreEvidence[] = [];
  if (manifest.semantic.enabled && manifest.semantic.available) {
    try {
      semanticEvidence = await retrieveSemanticEvidence(
        generationRoot,
        manifest,
        current.generation,
        trimmedQuery,
        maxResults,
        options,
      );
      semanticState = "available";
      semanticReasonCode = "SEMANTIC_READY";
    } catch (error) {
      semanticState = "unavailable";
      semanticReasonCode =
        error instanceof LlmWikiError ? error.code : "SEMANTIC_QUERY_FAILED";
      warnings.push(`Semantic retrieval unavailable: ${semanticReasonCode}.`);
    }
  }
  if (projectStatus.state !== "ready") {
    warnings.push(
      `Serving last-known-good generation ${current.generation}; project state is ${projectStatus.state}.`,
    );
  }
  if (manifest.semantic.enabled && !manifest.semantic.available) {
    warnings.push(
      `Semantic retrieval unavailable: ${manifest.semantic.reasonCode ?? "UNKNOWN_REASON"}.`,
    );
  }
  for (const source of manifest.unsupported.slice(0, 20)) {
    warnings.push(
      `Unsupported source ${source.relativePath}: ${source.reason}.`,
    );
  }
  if (manifest.unsupported.length > 20) {
    warnings.push(`${manifest.unsupported.length - 20} additional unsupported sources omitted.`);
  }
  const evidence = mergeEvidence(semanticEvidence, lexicalEvidence, maxResults);

  return {
    query: trimmedQuery,
    status: {
      state: projectStatus.state,
      generation: current.generation,
      builtAt: current.builtAt,
      ...(projectStatus.reasonCode === undefined
        ? {}
        : { reasonCode: projectStatus.reasonCode }),
      ...(projectStatus.message === undefined ? {} : { message: projectStatus.message }),
      semantic: semanticState,
      semanticReasonCode,
    },
    evidence,
    warnings,
  };
}

async function scoreProxy(
  generationRoot: string,
  proxy: ProxyRecord,
  queryTokens: string[],
  generation: string,
): Promise<ExploreEvidence | null> {
  const proxyInput = path.join(generationRoot, "proxy-inputs", proxy.proxyFile);
  const markdown = await readFile(proxyInput, "utf8");
  const bodyLines = markdown.replaceAll("\r\n", "\n").split("\n");
  const body = bodyLines.join("\n");
  const lowerBody = body.toLocaleLowerCase("en-US");
  const lowerTitle = proxy.title.toLocaleLowerCase("en-US");
  let score = 0;
  let bestLineIndex = 0;
  let bestLineScore = -1;

  for (const token of queryTokens) {
    score += countOccurrences(lowerBody, token);
    if (lowerTitle.includes(token)) {
      score += 5;
    }
  }
  for (const [index, line] of bodyLines.entries()) {
    const lowerLine = line.toLocaleLowerCase("en-US");
    const lineScore = queryTokens.reduce(
      (total, token) => total + countOccurrences(lowerLine, token),
      0,
    );
    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLineIndex = index;
    }
  }
  if (score <= 0) {
    return null;
  }

  const snippetStart = Math.max(0, bestLineIndex - 2);
  const snippetEndExclusive = Math.min(bodyLines.length, bestLineIndex + 3);
  const snippet = clipSnippet(
    bodyLines.slice(snippetStart, snippetEndExclusive).join("\n"),
  );
  return {
    title: proxy.title,
    snippet,
    score,
    retrieval: "lexical",
    citation: {
      locator: narrowLocator(proxy, bestLineIndex, bestLineIndex + 1),
      sourceHash: proxy.sourceHash,
      generation,
    },
  };
}

function narrowLocator(
  proxy: ProxyRecord,
  snippetStart: number,
  snippetEndExclusive: number,
): SourceLocator {
  if (proxy.locator.kind !== "file") {
    return proxy.locator;
  }
  const mappedLines = proxy.lineMap?.slice(snippetStart, snippetEndExclusive);
  if (mappedLines === undefined || mappedLines.length === 0) {
    return proxy.locator;
  }
  const narrowed: FileLocator = {
    kind: "file",
    path: proxy.locator.path,
    lineStart: Math.min(...mappedLines),
    lineEnd: Math.max(...mappedLines),
  };
  return narrowed;
}

function evidenceFromContextPack(
  pack: ContextPack,
  manifest: GenerationManifest,
  generation: string,
): { evidence: ExploreEvidence[]; warnings: string[] } {
  const byEngineSource = new Map(
    manifest.proxies
      .filter((proxy): proxy is ProxyRecord & { engineSourceFile: string } =>
        proxy.engineSourceFile !== undefined,
      )
      .map((proxy) => [path.basename(proxy.engineSourceFile), proxy] as const),
  );
  const evidence: ExploreEvidence[] = [];
  const warnings = pack.warnings.map((warning) => `${warning.code}: ${warning.message}`);
  for (const primary of pack.primary) {
    const citation = primary.citations
      .map((candidate) => ({
        citation: candidate,
        proxy: byEngineSource.get(path.basename(candidate.file)),
      }))
      .find(
        (
          candidate,
        ): candidate is {
          citation: (typeof primary.citations)[number];
          proxy: ProxyRecord & { engineSourceFile: string };
        } => candidate.proxy !== undefined,
      );
    if (citation === undefined) {
      warnings.push(`Skipped ungrounded compiled page ${primary.id}; no proxy citation mapped.`);
      continue;
    }
    evidence.push({
      title: primary.title,
      snippet:
        primary.chunks[0]?.text.trim() ||
        primary.summary.trim(),
      score: primary.score,
      retrieval: "lexical",
      citation: {
        locator: mapCompilerCitation(citation.proxy, citation.citation.start, citation.citation.end),
        sourceHash: citation.proxy.sourceHash,
        generation,
      },
    });
  }
  return { evidence, warnings };
}

async function retrieveSemanticEvidence(
  generationRoot: string,
  manifest: GenerationManifest,
  generation: string,
  query: string,
  maximum: number,
  options: ExploreOptions,
): Promise<ExploreEvidence[]> {
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
  if (profile === null) {
    throw new LlmWikiError(
      "SEMANTIC_PROFILE_UNAVAILABLE",
      `Embedding profile is unavailable: ${profileName}`,
    );
  }
  if (
    (profile.kind !== "openai-compatible" && profile.kind !== "voyage") ||
    profile.kind !== manifest.semantic.kind ||
    profile.model !== manifest.semantic.model ||
    manifest.semantic.profileFingerprint === undefined ||
    embeddingProfileFingerprint(profile) !== manifest.semantic.profileFingerprint
  ) {
    throw new LlmWikiError(
      "SEMANTIC_PROFILE_CHANGED",
      "Embedding profile changed after this generation was built.",
    );
  }
  let secret: string | null;
  try {
    secret = await credentialStoreForProfile(profile, environment).get(profile);
  } catch {
    throw new LlmWikiError(
      "SEMANTIC_CREDENTIAL_UNAVAILABLE",
      `Credential is unavailable for embedding profile ${profile.name}.`,
    );
  }
  if (secret === null) {
    throw new LlmWikiError(
      "SEMANTIC_CREDENTIAL_UNAVAILABLE",
      `Credential is unavailable for embedding profile ${profile.name}.`,
    );
  }
  const generationProfileName = manifest.provider.profile;
  if (generationProfileName !== null) {
    const generationProfile = await findProviderProfile(
      generationProfileName,
      environment,
    );
    if (generationProfile !== null) {
      let generationSecret: string | null = null;
      try {
        generationSecret = await credentialStoreForProfile(
          generationProfile,
          environment,
        ).get(generationProfile);
      } catch {
        // Generation credentials are not required for read-only retrieval.
      }
      if (
        generationSecret !== null &&
        secretsMatch(generationSecret, secret)
      ) {
        throw new LlmWikiError(
          "SEMANTIC_CREDENTIAL_MUST_DIFFER",
          "The embedding credential must differ from the Wiki generation credential.",
        );
      }
    }
  }
  const index = await readSemanticIndex(generationRoot);
  if (index === null) {
    throw new LlmWikiError(
      "SEMANTIC_INDEX_UNAVAILABLE",
      "Current generation has no semantic index.",
    );
  }
  if (
    index.profile !== profile.name ||
    index.kind !== profile.kind ||
    index.model !== profile.model ||
    index.profileFingerprint !== manifest.semantic.profileFingerprint
  ) {
    throw new LlmWikiError(
      "SEMANTIC_INDEX_PROFILE_MISMATCH",
      "Semantic index does not match its embedding profile.",
    );
  }
  const client = (options.embeddingClientFactory ?? createEmbeddingClient)(profile, secret);
  if (client.kind !== profile.kind || client.model !== profile.model) {
    throw new LlmWikiError(
      "SEMANTIC_CLIENT_PROFILE_MISMATCH",
      "Embedding client does not match the current generation profile.",
    );
  }
  const vector = await client.embedQuery(query);
  const ranked = rankSemanticIndex(index, vector, maximum);
  const byProxy = new Map(manifest.proxies.map((proxy) => [proxy.proxyId, proxy] as const));
  const results: ExploreEvidence[] = [];
  for (const match of ranked) {
    const proxy = byProxy.get(match.proxyId);
    if (proxy === undefined || proxy.bodyHash !== match.bodyHash) {
      continue;
    }
    const lines = (
      await readFile(path.join(generationRoot, "proxy-inputs", proxy.proxyFile), "utf8")
    )
      .replaceAll("\r\n", "\n")
      .split("\n");
    const snippet = clipSnippet(
      lines
        .slice(
          match.startLineIndex,
          Math.min(match.endLineIndex + 1, match.startLineIndex + 5),
        )
        .join("\n"),
    );
    results.push({
      title: proxy.title,
      snippet,
      score: match.score,
      retrieval: "semantic",
      citation: {
        locator: narrowLocator(proxy, match.startLineIndex, match.endLineIndex + 1),
        sourceHash: proxy.sourceHash,
        generation,
      },
    });
  }
  return results;
}

function mergeEvidence(
  semantic: ExploreEvidence[],
  lexical: ExploreEvidence[],
  maximum: number,
): ExploreEvidence[] {
  const merged: ExploreEvidence[] = [];
  const seen = new Set<string>();
  for (const candidate of [...semantic, ...lexical]) {
    const key = JSON.stringify(candidate.citation.locator);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(candidate);
    if (merged.length >= maximum) {
      break;
    }
  }
  return merged;
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
  return {
    kind: "file",
    path: proxy.locator.path,
    lineStart: Math.min(...mapped),
    lineEnd: Math.max(...mapped),
  };
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
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let position = 0;
  while (position < haystack.length) {
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
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 1_999)}…`;
}

function secretsMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
