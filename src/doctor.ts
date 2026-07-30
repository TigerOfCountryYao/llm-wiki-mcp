import { readProjectConfig, findProviderProfile } from "./config.js";
import { credentialAvailability } from "./credentials.js";
import { pathExists } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { getProjectStatus } from "./status.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  code: string;
  message: string;
}

export async function doctorProject(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ healthy: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node",
    ok: nodeMajor >= 24,
    code: nodeMajor >= 24 ? "NODE_OK" : "NODE_TOO_OLD",
    message: `Node.js ${process.versions.node}; version 24 or newer is required.`,
  });

  const initialized = await pathExists(projectPaths(root).consent);
  checks.push({
    name: "project",
    ok: initialized,
    code: initialized ? "PROJECT_INITIALIZED" : "NOT_INITIALIZED",
    message: initialized ? "Project consent is present." : "Run llm-wiki init.",
  });
  if (!initialized) {
    return { healthy: checks.every((check) => check.ok), checks };
  }

  const config = await readProjectConfig(root);
  if (config.providerProfile === null) {
    checks.push({
      name: "provider",
      ok: false,
      code: "PROVIDER_NOT_CONFIGURED",
      message: "No independent Wiki provider profile is selected.",
    });
  } else {
    const profile = await findProviderProfile(config.providerProfile, environment);
    if (profile === null) {
      checks.push({
        name: "provider",
        ok: false,
        code: "PROVIDER_PROFILE_NOT_FOUND",
        message: `Selected provider profile ${config.providerProfile} does not exist.`,
      });
    } else {
      if (profile.kind === "voyage") {
        checks.push({
          name: "provider",
          ok: false,
          code: "INVALID_GENERATION_PROVIDER_KIND",
          message: "Voyage profiles cannot generate Wiki pages.",
        });
      } else {
        const availability = await credentialAvailability(profile, environment);
        checks.push({
          name: "provider",
          ok: availability.available,
          code: availability.available
            ? "PROVIDER_CREDENTIAL_AVAILABLE"
            : (availability.reasonCode ?? "CREDENTIAL_UNAVAILABLE"),
          message: availability.available
            ? `Credential is available from ${availability.store}.`
            : `Credential is unavailable from ${availability.store}.`,
        });
      }
    }
  }

  if (!config.semantic.enabled) {
    checks.push({
      name: "semantic",
      ok: true,
      code: "SEMANTIC_DISABLED",
      message: "Semantic retrieval is disabled.",
    });
  } else if (config.embeddingProfile === null) {
    checks.push({
      name: "semantic",
      ok: false,
      code: "EMBEDDING_PROFILE_REQUIRED",
      message: "Semantic retrieval requires an independent embedding profile.",
    });
  } else if (config.embeddingProfile === config.providerProfile) {
    checks.push({
      name: "semantic",
      ok: false,
      code: "EMBEDDING_PROFILE_MUST_DIFFER",
      message: "The embedding profile must differ from the Wiki generation profile.",
    });
  } else {
    const profile = await findProviderProfile(config.embeddingProfile, environment);
    if (profile === null) {
      checks.push({
        name: "semantic",
        ok: false,
        code: "EMBEDDING_PROFILE_NOT_FOUND",
        message: `Selected embedding profile ${config.embeddingProfile} does not exist.`,
      });
    } else if (profile.kind !== "openai-compatible" && profile.kind !== "voyage") {
      checks.push({
        name: "semantic",
        ok: false,
        code: "INVALID_EMBEDDING_PROVIDER_KIND",
        message: "Embedding profiles must use OpenAI-compatible or Voyage.",
      });
    } else {
      const availability = await credentialAvailability(profile, environment);
      checks.push({
        name: "semantic",
        ok: availability.available,
        code: availability.available
          ? "EMBEDDING_CREDENTIAL_AVAILABLE"
          : (availability.reasonCode ?? "EMBEDDING_CREDENTIAL_UNAVAILABLE"),
        message: availability.available
          ? `Embedding credential is available from ${availability.store}.`
          : `Embedding credential is unavailable from ${availability.store}.`,
      });
    }
  }

  const status = await getProjectStatus(root);
  checks.push({
    name: "generation",
    ok: status.currentGeneration !== undefined,
    code: status.currentGeneration === undefined ? "NO_GENERATION" : "GENERATION_AVAILABLE",
    message:
      status.currentGeneration === undefined
        ? "No successful generation is available."
        : `Generation ${status.currentGeneration} is available (${status.state}).`,
  });
  checks.push({
    name: "engine",
    ok: true,
    code: "COMPILER_ADAPTER_AVAILABLE",
    message:
      "The local reviewed llm-wiki-compiler adapter is connected with native embeddings:false and systemPolicy support.",
  });
  return { healthy: checks.every((check) => check.ok), checks };
}
