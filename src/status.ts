import path from "node:path";
import {
  pathExists,
  readJsonFile,
  recoverOrphanedFileLock,
} from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { readConsent } from "./config.js";
import { enumerateAuthorizedSources } from "./scope.js";
import { readCurrent, readStoredStatus, writeStatus } from "./state.js";
import {
  STATE_SCHEMA_VERSION,
  type GenerationManifest,
  type GenerationProviderStatus,
  type GenerationSemanticStatus,
  type RuntimeStatus,
} from "./types.js";

export interface ProjectStatusResult extends RuntimeStatus {
  initialized: boolean;
  sourceCount: number;
  sourceDigest?: string;
  builtAt?: string;
  provider?: GenerationProviderStatus;
  semantic?: GenerationSemanticStatus;
}

export interface ProjectStatusOptions {
  verifySources?: boolean;
}

export async function getProjectStatus(
  root: string,
  options: ProjectStatusOptions = {},
): Promise<ProjectStatusResult> {
  const paths = projectPaths(root);
  if (!(await pathExists(paths.consent))) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      state: "uninitialized",
      updatedAt: new Date().toISOString(),
      initialized: false,
      sourceCount: 0,
      reasonCode: "NOT_INITIALIZED",
      message: "Run llm-wiki init for this project.",
    };
  }

  const verifySources = options.verifySources ?? true;
  const [consent, current, storedValue] = await Promise.all([
    verifySources ? readConsent(root) : Promise.resolve(null),
    readCurrent(root),
    readStoredStatus(root),
  ]);
  let stored = storedValue;
  if (stored?.state === "building") {
    const lockState = await recoverOrphanedFileLock(paths.buildLock);
    if (lockState !== "active") {
      stored = {
        schemaVersion: STATE_SCHEMA_VERSION,
        state: "stale",
        updatedAt: new Date().toISOString(),
        reasonCode: "BUILD_INTERRUPTED",
        message: "The previous Wiki build was interrupted and can be retried.",
        ...(current === null
          ? {}
          : { currentGeneration: current.generation }),
      };
      await writeStatus(root, stored);
    }
  }
  const enumerated =
    consent === null
      ? null
      : await enumerateAuthorizedSources(root, consent);
  const cachedBase = {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: stored?.updatedAt ?? new Date().toISOString(),
    initialized: true,
    sourceCount: enumerated?.sources.length ?? 0,
    ...(enumerated === null ? {} : { sourceDigest: enumerated.sourceDigest }),
  } as const;

  if (current === null) {
    const preservedState =
      stored?.state === "building" ||
      stored?.state === "error" ||
      stored?.state === "provider-unavailable"
        ? stored.state
        : "stale";
    return {
      ...cachedBase,
      state: preservedState,
      reasonCode: stored?.reasonCode ?? "NO_GENERATION",
      message: stored?.message ?? "No successful generation exists yet.",
      ...(stored?.buildStartedAt === undefined ? {} : { buildStartedAt: stored.buildStartedAt }),
    };
  }

  const manifest = await readJsonFile<GenerationManifest>(
    path.join(paths.generations, current.generation, "manifest.json"),
  );
  const base = {
    ...cachedBase,
    sourceCount: enumerated?.sources.length ?? manifest.sources.length,
    sourceDigest: enumerated?.sourceDigest ?? manifest.sourceDigest,
  } as const;
  const generationState = {
    currentGeneration: current.generation,
    builtAt: current.builtAt,
    provider: manifest.provider,
    semantic: manifest.semantic,
  } as const;
  const storedTargetsCurrent =
    stored?.currentGeneration === current.generation;
  const storedIsLater =
    stored !== null &&
    Date.parse(stored.updatedAt) > Date.parse(current.builtAt);
  const faultApplies =
    stored !== null &&
    storedTargetsCurrent &&
    storedIsLater &&
    (stored.state === "building" ||
      stored.state === "error" ||
      stored.state === "provider-unavailable");
  if (faultApplies && stored !== null) {
    return {
      ...base,
      state: stored.state,
      ...(stored.reasonCode === undefined ? {} : { reasonCode: stored.reasonCode }),
      ...(stored.message === undefined ? {} : { message: stored.message }),
      ...generationState,
      ...(stored.buildStartedAt === undefined ? {} : { buildStartedAt: stored.buildStartedAt }),
    };
  }

  const explicitStaleApplies =
    stored !== null &&
    storedTargetsCurrent &&
    stored.state === "stale" &&
    Date.parse(stored.updatedAt) >= Date.parse(current.builtAt);
  if (explicitStaleApplies && stored !== null) {
    return {
      ...base,
      state: "stale",
      ...(stored.reasonCode === undefined ? {} : { reasonCode: stored.reasonCode }),
      ...(stored.message === undefined ? {} : { message: stored.message }),
      ...generationState,
    };
  }

  if (
    enumerated !== null &&
    current.sourceDigest !== enumerated.sourceDigest
  ) {
    return {
      ...base,
      state: "stale",
      reasonCode: "SOURCES_CHANGED",
      message: "Authorized sources changed after the current generation was built.",
      ...generationState,
    };
  }

  return {
    ...base,
    state: "ready",
    updatedAt: current.builtAt,
    ...generationState,
  };
}
