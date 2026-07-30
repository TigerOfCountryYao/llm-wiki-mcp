import path from "node:path";
import { pathExists, readJsonFile } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { readConsent } from "./config.js";
import { enumerateAuthorizedSources } from "./scope.js";
import { readCurrent, readStoredStatus } from "./state.js";
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

export async function getProjectStatus(root: string): Promise<ProjectStatusResult> {
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

  const [consent, current, stored] = await Promise.all([
    readConsent(root),
    readCurrent(root),
    readStoredStatus(root),
  ]);
  const enumerated = await enumerateAuthorizedSources(root, consent);
  const base = {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: stored?.updatedAt ?? new Date().toISOString(),
    initialized: true,
    sourceCount: enumerated.sources.length,
    sourceDigest: enumerated.sourceDigest,
  } as const;

  if (current === null) {
    const preservedState =
      stored?.state === "building" ||
      stored?.state === "error" ||
      stored?.state === "provider-unavailable"
        ? stored.state
        : "stale";
    return {
      ...base,
      state: preservedState,
      reasonCode: stored?.reasonCode ?? "NO_GENERATION",
      message: stored?.message ?? "No successful generation exists yet.",
      ...(stored?.buildStartedAt === undefined ? {} : { buildStartedAt: stored.buildStartedAt }),
    };
  }

  const manifest = await readJsonFile<GenerationManifest>(
    path.join(paths.generations, current.generation, "manifest.json"),
  );
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
    storedTargetsCurrent &&
    storedIsLater &&
    (stored.state === "building" ||
      stored.state === "error" ||
      stored.state === "provider-unavailable");
  if (faultApplies) {
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
    storedTargetsCurrent &&
    stored?.state === "stale" &&
    Date.parse(stored.updatedAt) >= Date.parse(current.builtAt);
  if (explicitStaleApplies) {
    return {
      ...base,
      state: "stale",
      ...(stored.reasonCode === undefined ? {} : { reasonCode: stored.reasonCode }),
      ...(stored.message === undefined ? {} : { message: stored.message }),
      ...generationState,
    };
  }

  if (current.sourceDigest !== enumerated.sourceDigest) {
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
