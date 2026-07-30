import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { cp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readProjectConfig, readConsent, findProviderProfile } from "./config.js";
import { credentialStoreForProfile } from "./credentials.js";
import {
  createEmbeddingClient,
  embeddingProfileFingerprint,
  type EmbeddingClient,
  type EmbeddingClientFactory,
} from "./embedding.js";
import { asLlmWikiError, LlmWikiError } from "./errors.js";
import {
  acquireFileLock,
  ensurePrivateDirectory,
  hardenPrivateTree,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { selectIncrementalPageCandidates } from "./incremental.js";
import {
  catalogCompiledWikiPages,
  type CompiledWikiPage,
} from "./pages.js";
import { prepareSourceProxies } from "./proxy.js";
import { enumerateAuthorizedSources } from "./scope.js";
import {
  buildSemanticIndex,
  readSemanticIndex,
  type SemanticIndexIdentity,
} from "./semantic-cache.js";
import { readCurrent, writeCurrent, writeStatus } from "./state.js";
import {
  STATE_SCHEMA_VERSION,
  type CurrentPointer,
  type GenerationManifest,
  type ProviderProfile,
  type ProxyRecord,
  type SemanticIndex,
  type WikiEngine,
} from "./types.js";
import { CompilerWikiEngine } from "./engine.js";

export interface BuildOptions {
  engine?: WikiEngine;
  environment?: NodeJS.ProcessEnv;
  embeddingClientFactory?: EmbeddingClientFactory;
  signal?: AbortSignal;
}

export interface BuildResult {
  generation: string;
  sourceDigest: string;
  sourceCount: number;
  proxyCount: number;
  unsupportedCount: number;
  pageCount: number;
  replacedGeneration: string | null;
}

export async function buildProject(
  root: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const paths = projectPaths(root);
  if (!(await pathExists(paths.consent))) {
    throw new LlmWikiError("NOT_INITIALIZED", "Run llm-wiki init before building.");
  }
  await Promise.all([
    ensurePrivateDirectory(paths.localRoot),
    ensurePrivateDirectory(paths.managed),
    ensurePrivateDirectory(paths.locks),
    ensurePrivateDirectory(paths.builds),
    ensurePrivateDirectory(paths.generations),
    ensurePrivateDirectory(paths.semantic),
  ]);
  const lock = await acquireFileLock(paths.buildLock);
  let currentBefore: CurrentPointer | null = null;
  let stagingRoot: string | null = null;
  let uncommittedPublishedRoot: string | null = null;
  try {
    let committed:
      | {
          pointer: CurrentPointer;
          result: BuildResult;
        }
      | null = null;
    try {
      currentBefore = await readCurrent(root);
      const buildStartedAt = new Date().toISOString();
      await writeStatus(root, {
        schemaVersion: STATE_SCHEMA_VERSION,
        state: "building",
        updatedAt: buildStartedAt,
        buildStartedAt,
        ...(currentBefore === null
          ? {}
          : { currentGeneration: currentBefore.generation }),
      });

      stagingRoot = path.join(paths.builds, randomUUID());
      const [consent, config] = await Promise.all([
        readConsent(root),
        readProjectConfig(root),
      ]);
      const { sources, sourceDigest } = await enumerateAuthorizedSources(
        root,
        consent,
      );
      const generation = await nextGenerationId(root, sourceDigest);
      await ensurePrivateDirectory(stagingRoot);
      let previousProxies: ProxyRecord[] | undefined;
      let previousPages: CompiledWikiPage[] = [];
      if (currentBefore !== null) {
        const previousRoot = path.join(
          paths.generations,
          currentBefore.generation,
        );
        const previousManifest = await readJsonFile<GenerationManifest>(
          path.join(previousRoot, "manifest.json"),
        );
        previousProxies = previousManifest.proxies;
        previousPages = await catalogCompiledWikiPages(
          previousRoot,
          previousManifest.proxies,
          new Set(sources.map((source) => source.sourceId)),
          undefined,
          previousManifest.pages,
        );
        const previousEngine = path.join(previousRoot, "engine");
        if (await pathExists(previousEngine)) {
          await cp(previousEngine, path.join(stagingRoot, "engine"), {
            recursive: true,
            force: true,
            mode: fsConstants.COPYFILE_FICLONE,
          });
        }
      }
      const prepared = await prepareSourceProxies(stagingRoot, sources);
      const environment = options.environment ?? process.env;
      const provider =
        config.providerProfile === null
          ? null
          : await findProviderProfile(config.providerProfile, environment);
      const embeddingProfile =
        config.embeddingProfile === null
          ? null
          : await findProviderProfile(config.embeddingProfile, environment);
      const semanticSetup = config.semantic.enabled
        ? await resolveSemanticSetup(
            provider,
            embeddingProfile,
            config.providerProfile,
            config.embeddingProfile,
            environment,
          )
        : null;
      let embeddingClient: EmbeddingClient | null = null;
      let previousSemanticIndex: SemanticIndex | null = null;
      if (
        semanticSetup !== null &&
        semanticSetup.embeddingSecret !== null
      ) {
        embeddingClient = (
          options.embeddingClientFactory ?? createEmbeddingClient
        )(
          semanticSetup.embeddingProfile,
          semanticSetup.embeddingSecret,
        );
        if (
          embeddingClient.kind !== semanticSetup.embeddingProfile.kind ||
          embeddingClient.model !== semanticSetup.embeddingProfile.model
        ) {
          throw new LlmWikiError(
            "EMBEDDING_CLIENT_PROFILE_MISMATCH",
            "Embedding client does not match the selected embedding profile.",
          );
        }
        if (previousPages.length > 0) {
          const identity = semanticIdentity(semanticSetup.embeddingProfile);
          try {
            previousSemanticIndex = await readSemanticIndex(
              paths.semanticIndex,
              previousPages,
              identity,
            );
          } catch (error) {
            if (
              !(
                error instanceof LlmWikiError &&
                error.code === "SEMANTIC_INDEX_INVALID"
              )
            ) {
              throw error;
            }
          }
        }
      }
      let engine = options.engine;
      if (engine === undefined) {
        if (provider === null) {
          throw new LlmWikiError(
            "PROVIDER_UNAVAILABLE",
            config.providerProfile === null
              ? "Select an independent Wiki provider profile before building."
              : `Provider profile not found: ${config.providerProfile}`,
          );
        }
        if (provider.kind === "voyage") {
          throw new LlmWikiError(
            "INVALID_GENERATION_PROVIDER_KIND",
            "Voyage profiles cannot generate Wiki pages.",
          );
        }
        const secret =
          semanticSetup?.generationSecret ??
          (await requireProfileCredential(
            provider,
            environment,
            "GENERATION_CREDENTIAL_UNAVAILABLE",
            "generation",
          ));
        engine = new CompilerWikiEngine(provider, secret);
      }
      const candidateSelection =
        previousProxies === undefined
          ? {
              candidates: [],
              semanticFailure: null,
              invalidateSemanticIndex: false,
            }
          : await selectIncrementalPageCandidates({
              generationRoot: stagingRoot,
              currentProxies: prepared.proxies,
              previousProxies,
              previousPages,
              semanticIndex: previousSemanticIndex,
              embeddingClient,
            });
      const engineResult = await engine.build({
        generationRoot: stagingRoot,
        proxies: prepared.proxies,
        ...(previousProxies === undefined ? {} : { previousProxies }),
        ...(candidateSelection.candidates.length === 0
          ? {}
          : { previousPageCandidates: candidateSelection.candidates }),
      });
      const mappingByProxy = new Map(
        engineResult.sourceMappings.map(
          (mapping) => [mapping.proxyId, mapping] as const,
        ),
      );
      const mappedProxies = prepared.proxies.map((proxy) => {
        const mapping = mappingByProxy.get(proxy.proxyId);
        if (mapping === undefined) {
          throw new LlmWikiError(
            "ENGINE_SOURCE_MAPPING_MISSING",
            `Engine did not return a source mapping for proxy ${proxy.proxyId}.`,
          );
        }
        return {
          ...proxy,
          engineSourceFile: mapping.engineSourceFile,
          engineBodyStartLine: mapping.engineBodyStartLine,
        };
      });
      const pages = await catalogCompiledWikiPages(
        stagingRoot,
        mappedProxies,
        new Set(sources.map((source) => source.sourceId)),
        engineResult.compiledPages,
      );
      let semanticIndex: SemanticIndex | null = null;
      let semanticUnavailable =
        candidateSelection.semanticFailure ??
        semanticSetup?.unavailable ??
        null;
      if (
        semanticSetup !== null &&
        semanticSetup.embeddingSecret !== null &&
        embeddingClient !== null &&
        semanticUnavailable === null
      ) {
        try {
          semanticIndex = await buildSemanticIndex(
            paths.semanticIndex,
            pages,
            semanticSetup.embeddingProfile,
            semanticSetup.embeddingSecret,
            {
              clientFactory: () => embeddingClient,
              recoverCorrupt: true,
              forceRebuild: candidateSelection.invalidateSemanticIndex,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            },
          );
        } catch (error) {
          const normalized = asLlmWikiError(error);
          if (!isExpectedSemanticUnavailable(normalized)) {
            throw normalized;
          }
          semanticUnavailable = normalized;
        }
      }
      const createdAt = new Date().toISOString();
      const semanticAvailable =
        semanticUnavailable === null &&
        (semanticIndex?.entries.length ?? 0) > 0;
      const manifest: GenerationManifest = {
        schemaVersion: STATE_SCHEMA_VERSION,
        generation,
        createdAt,
        sourceDigest,
        engine: {
          name: engineResult.name,
          version: engineResult.version,
        },
        provider: {
          profile: config.providerProfile,
          ...(provider === null
            ? {}
            : { kind: provider.kind, model: provider.model }),
        },
        semantic: config.semantic.enabled
          ? {
              enabled: true,
              available: semanticAvailable,
              profile: semanticSetup!.embeddingProfile.name,
              kind: semanticSetup!.embeddingProfile.kind,
              model: semanticSetup!.embeddingProfile.model,
              profileFingerprint: embeddingProfileFingerprint(
                semanticSetup!.embeddingProfile,
              ),
              reasonCode:
                semanticUnavailable?.code ??
                (semanticAvailable
                  ? "SEMANTIC_READY"
                  : "SEMANTIC_EMPTY_INDEX"),
              reason:
                semanticUnavailable === null
                  ? semanticAvailable
                    ? "Semantic index is available."
                    : "No embeddable compiled Wiki pages were produced."
                  : semanticUnavailableReason(semanticUnavailable.code),
            }
          : {
              enabled: false,
              available: false,
              profile: config.embeddingProfile,
              ...(embeddingProfile?.kind === "openai-compatible" ||
              embeddingProfile?.kind === "voyage"
                ? {
                    kind: embeddingProfile.kind,
                    model: embeddingProfile.model,
                    profileFingerprint:
                      embeddingProfileFingerprint(embeddingProfile),
                  }
                : {}),
              reasonCode: "SEMANTIC_DISABLED",
              reason: "Semantic retrieval is disabled.",
            },
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          kind: source.kind,
          contentHash: source.contentHash,
          ...(source.relativePath === undefined
            ? {}
            : { relativePath: source.relativePath }),
          size: source.size,
        })),
        unsupported: prepared.unsupported,
        proxies: mappedProxies,
        pages: pages.map(({ body: _body, ...page }) => page),
      };
      await writeJsonAtomic(path.join(stagingRoot, "manifest.json"), manifest);
      await hardenPrivateTree(stagingRoot);
      await validateGeneration(stagingRoot);

      uncommittedPublishedRoot = path.join(paths.generations, generation);
      await ensurePrivateDirectory(paths.generations);
      await rename(stagingRoot, uncommittedPublishedRoot);
      stagingRoot = null;
      const pointer: CurrentPointer = {
        schemaVersion: STATE_SCHEMA_VERSION,
        generation,
        builtAt: createdAt,
        sourceDigest,
      };
      await writeCurrent(root, pointer);
      uncommittedPublishedRoot = null;
      committed = {
        pointer,
        result: {
          generation,
          sourceDigest,
          sourceCount: sources.length,
          proxyCount: prepared.proxies.length,
          unsupportedCount: prepared.unsupported.length,
          pageCount: engineResult.pageCount,
          replacedGeneration: currentBefore?.generation ?? null,
        },
      };
    } catch (error) {
      const normalized = asLlmWikiError(error);
      const providerUnavailable = PROVIDER_UNAVAILABLE_CODES.has(
        normalized.code,
      );
      const cleanup: Array<Promise<unknown>> = [
        writeStatus(root, {
          schemaVersion: STATE_SCHEMA_VERSION,
          state: providerUnavailable ? "provider-unavailable" : "error",
          updatedAt: new Date().toISOString(),
          reasonCode: normalized.code,
          message: normalized.message,
          ...(currentBefore === null
            ? {}
            : { currentGeneration: currentBefore.generation }),
        }),
      ];
      if (stagingRoot !== null) {
        cleanup.push(rm(stagingRoot, { recursive: true, force: true }));
      }
      if (uncommittedPublishedRoot !== null) {
        cleanup.push(
          rm(uncommittedPublishedRoot, { recursive: true, force: true }),
        );
      }
      await Promise.allSettled(cleanup);
      throw normalized;
    }

    if (committed === null) {
      throw new LlmWikiError(
        "INTERNAL_ERROR",
        "Build completed without committing a generation.",
      );
    }
    await Promise.allSettled([
      writeStatus(root, {
        schemaVersion: STATE_SCHEMA_VERSION,
        state: "ready",
        updatedAt: committed.pointer.builtAt,
        currentGeneration: committed.pointer.generation,
      }),
      garbageCollectGenerations(
        root,
        committed.pointer.generation,
        currentBefore?.generation ?? null,
      ),
    ]);
    return committed.result;
  } finally {
    await lock.release();
  }
}

interface SemanticSetup {
  generationSecret: string;
  embeddingSecret: string | null;
  embeddingProfile: ProviderProfile & {
    kind: "openai-compatible" | "voyage";
  };
  unavailable: LlmWikiError | null;
}

const PROVIDER_UNAVAILABLE_CODES = new Set([
  "GENERATION_CREDENTIAL_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_MODEL_UNAVAILABLE",
  "PROVIDER_NETWORK_FAILED",
  "PROVIDER_REQUEST_FAILED",
]);

const EXPECTED_SEMANTIC_UNAVAILABLE_CODES = new Set([
  "EMBEDDING_CREDENTIAL_UNAVAILABLE",
  "EMBEDDING_AUTH_FAILED",
  "EMBEDDING_QUOTA_EXCEEDED",
  "EMBEDDING_MODEL_UNAVAILABLE",
  "EMBEDDING_NETWORK_FAILED",
  "EMBEDDING_REQUEST_FAILED",
  "EMBEDDING_RESPONSE_INVALID",
  "EMBEDDING_DIMENSION_MISMATCH",
]);

async function resolveSemanticSetup(
  generationProfile: ProviderProfile | null,
  embeddingProfile: ProviderProfile | null,
  generationProfileName: string | null,
  embeddingProfileName: string | null,
  environment: NodeJS.ProcessEnv,
): Promise<SemanticSetup> {
  if (generationProfileName === null || generationProfile === null) {
    throw new LlmWikiError(
      "PROVIDER_UNAVAILABLE",
      generationProfileName === null
        ? "Select an independent Wiki generation profile before building."
        : `Generation provider profile not found: ${generationProfileName}`,
    );
  }
  if (generationProfile.kind === "voyage") {
    throw new LlmWikiError(
      "INVALID_GENERATION_PROVIDER_KIND",
      "Voyage profiles cannot generate Wiki pages.",
    );
  }
  if (embeddingProfileName === null) {
    throw new LlmWikiError(
      "EMBEDDING_PROFILE_REQUIRED",
      "Select an independent embedding profile before enabling semantic retrieval.",
    );
  }
  if (embeddingProfileName === generationProfileName) {
    throw new LlmWikiError(
      "EMBEDDING_PROFILE_MUST_DIFFER",
      "The embedding profile must differ from the Wiki generation profile.",
    );
  }
  if (embeddingProfile === null) {
    throw new LlmWikiError(
      "EMBEDDING_PROFILE_NOT_FOUND",
      `Embedding profile not found: ${embeddingProfileName}`,
    );
  }
  if (embeddingProfile.kind !== "openai-compatible" && embeddingProfile.kind !== "voyage") {
    throw new LlmWikiError(
      "INVALID_EMBEDDING_PROVIDER_KIND",
      "Embedding profiles must use openai-compatible or voyage.",
    );
  }
  const generationSecret = await requireProfileCredential(
    generationProfile,
    environment,
    "GENERATION_CREDENTIAL_UNAVAILABLE",
    "generation",
  );
  let embeddingSecret: string;
  try {
    embeddingSecret = await requireProfileCredential(
      embeddingProfile,
      environment,
      "EMBEDDING_CREDENTIAL_UNAVAILABLE",
      "embedding",
    );
  } catch (error) {
    const normalized = asLlmWikiError(error);
    if (!isExpectedSemanticUnavailable(normalized)) {
      throw normalized;
    }
    return {
      generationSecret,
      embeddingSecret: null,
      embeddingProfile: {
        ...embeddingProfile,
        kind: embeddingProfile.kind,
      },
      unavailable: normalized,
    };
  }
  if (secretsMatch(generationSecret, embeddingSecret)) {
    throw new LlmWikiError(
      "EMBEDDING_CREDENTIAL_MUST_DIFFER",
      "The embedding credential must differ from the Wiki generation credential.",
    );
  }
  return {
    generationSecret,
    embeddingSecret,
    embeddingProfile: {
      ...embeddingProfile,
      kind: embeddingProfile.kind,
    },
    unavailable: null,
  };
}

function isExpectedSemanticUnavailable(error: LlmWikiError): boolean {
  return EXPECTED_SEMANTIC_UNAVAILABLE_CODES.has(error.code);
}

function semanticUnavailableReason(code: string): string {
  switch (code) {
    case "EMBEDDING_CREDENTIAL_UNAVAILABLE":
      return "The embedding credential is unavailable.";
    case "EMBEDDING_AUTH_FAILED":
      return "The embedding provider rejected its credential.";
    case "EMBEDDING_QUOTA_EXCEEDED":
      return "The embedding provider reported an exhausted quota or rate limit.";
    case "EMBEDDING_MODEL_UNAVAILABLE":
      return "The configured embedding model or endpoint is unavailable.";
    case "EMBEDDING_NETWORK_FAILED":
      return "The embedding provider could not be reached.";
    case "EMBEDDING_REQUEST_FAILED":
      return "The embedding provider request failed.";
    case "EMBEDDING_RESPONSE_INVALID":
      return "The embedding provider returned an invalid response.";
    case "EMBEDDING_DIMENSION_MISMATCH":
      return "The embedding provider returned inconsistent vector dimensions.";
    default:
      return "Semantic indexing is unavailable.";
  }
}

async function requireProfileCredential(
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv,
  code: "GENERATION_CREDENTIAL_UNAVAILABLE" | "EMBEDDING_CREDENTIAL_UNAVAILABLE",
  role: "generation" | "embedding",
): Promise<string> {
  let value: string | null;
  try {
    value = await credentialStoreForProfile(profile, environment).get(profile);
  } catch {
    throw new LlmWikiError(
      code,
      `Credential is unavailable for ${role} profile ${profile.name}.`,
    );
  }
  if (value === null) {
    throw new LlmWikiError(
      code,
      `Credential is unavailable for ${role} profile ${profile.name}.`,
    );
  }
  return value;
}

function secretsMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function nextGenerationId(root: string, sourceDigest: string): Promise<string> {
  const paths = projectPaths(root);
  await ensurePrivateDirectory(paths.generations);
  const names = await readdir(paths.generations, { withFileTypes: true });
  const highest = names
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number.parseInt(entry.name.split("-")[0] ?? "0", 10))
    .filter(Number.isFinite)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return `${String(highest + 1).padStart(8, "0")}-${sourceDigest.slice(0, 12)}`;
}

async function validateGeneration(
  generationRoot: string,
): Promise<void> {
  const required = [
    path.join(generationRoot, "manifest.json"),
    path.join(generationRoot, "engine", "wiki", "index.md"),
  ];
  for (const target of required) {
    if (!(await pathExists(target))) {
      throw new LlmWikiError("INVALID_GENERATION", `Generation is missing ${path.basename(target)}.`);
    }
  }
}

function semanticIdentity(
  profile: ProviderProfile & {
    kind: "openai-compatible" | "voyage";
  },
): SemanticIndexIdentity {
  return {
    profile: profile.name,
    kind: profile.kind,
    model: profile.model,
    profileFingerprint: embeddingProfileFingerprint(profile),
  };
}

async function garbageCollectGenerations(
  root: string,
  current: string,
  previous: string | null,
): Promise<void> {
  const directory = projectPaths(root).generations;
  const keep = new Set([current, ...(previous === null ? [] : [previous])]);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
      .map((entry) => rm(path.join(directory, entry.name), { recursive: true, force: true })),
  );
}
