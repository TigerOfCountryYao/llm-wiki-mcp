import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProject } from "../src/build.js";
import {
  readProjectConfig,
  writeProjectConfig,
  writeProviderProfiles,
} from "../src/config.js";
import type {
  EmbeddingClient,
  EmbeddingClientFactory,
} from "../src/embedding.js";
import { doctorProject } from "../src/doctor.js";
import { DeterministicSourceEngine } from "../src/engine.js";
import { LlmWikiError } from "../src/errors.js";
import { exploreWiki } from "../src/explore.js";
import { initializeProject } from "../src/project.js";
import { getProjectStatus } from "../src/status.js";
import type {
  GenerationManifest,
  ProviderProfile,
  ProviderProfilesFile,
} from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("semantic build boundary", () => {
  it("builds a real index with a distinct embedding profile and key", async () => {
    const fixture = await semanticProject();
    const observedSecrets: string[] = [];
    const factory = semanticFactory(observedSecrets);
    const result = await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });
    const generationRoot = path.join(
      fixture.root,
      ".llm-wiki",
      "generations",
      result.generation,
    );
    const manifest = JSON.parse(
      await readFile(path.join(generationRoot, "manifest.json"), "utf8"),
    ) as GenerationManifest;
    const semanticIndex = JSON.parse(
      await readFile(path.join(generationRoot, "semantic", "index.json"), "utf8"),
    ) as { entries: unknown[] };

    expect(observedSecrets).toEqual(["embedding-secret"]);
    expect(manifest.semantic).toMatchObject({
      enabled: true,
      available: true,
      profile: "embedding",
      kind: "voyage",
      model: "voyage-3",
      reasonCode: "SEMANTIC_READY",
      reason: "Semantic index is available.",
    });
    expect(manifest.semantic.profileFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(semanticIndex.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest)).not.toContain("generation-secret");
    expect(JSON.stringify(manifest)).not.toContain("embedding-secret");
    expect(await getProjectStatus(fixture.root)).toMatchObject({
      state: "ready",
      semantic: {
        enabled: true,
        available: true,
        profile: "embedding",
        reasonCode: "SEMANTIC_READY",
      },
    });
  });

  it("rejects invalid or reused embedding configuration", async () => {
    const fixture = await semanticProject();
    const original = await readProjectConfig(fixture.root);

    await writeProjectConfig(fixture.root, {
      ...original,
      embeddingProfile: null,
    });
    await expect(
      buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROFILE_REQUIRED" });

    await writeProjectConfig(fixture.root, {
      ...original,
      embeddingProfile: "generation",
    });
    await expect(
      buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROFILE_MUST_DIFFER" });

    await writeProjectConfig(fixture.root, {
      ...original,
      embeddingProfile: "not-present",
    });
    await expect(
      buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROFILE_NOT_FOUND" });

    await writeProjectConfig(fixture.root, original);
    const reusedEnvironment = {
      ...fixture.environment,
      EMBEDDING_TEST_KEY: "generation-secret",
    };
    await expect(
      buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment: reusedEnvironment,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_CREDENTIAL_MUST_DIFFER" });
  });

  it.each([
    [
      "missing credential",
      "EMBEDDING_CREDENTIAL_UNAVAILABLE",
      undefined,
    ],
    [
      "network failure",
      "EMBEDDING_NETWORK_FAILED",
      new LlmWikiError(
        "EMBEDDING_NETWORK_FAILED",
        "The embedding provider could not be reached.",
      ),
    ],
    [
      "authentication failure",
      "EMBEDDING_AUTH_FAILED",
      new LlmWikiError(
        "EMBEDDING_AUTH_FAILED",
        "The embedding provider rejected its credential.",
      ),
    ],
    [
      "invalid provider response",
      "EMBEDDING_RESPONSE_INVALID",
      new LlmWikiError(
        "EMBEDDING_RESPONSE_INVALID",
        "Embedding provider returned an invalid response shape.",
      ),
    ],
  ])(
    "publishes a lexical generation when semantic build has a %s",
    async (_label, reasonCode, semanticFailure) => {
      const fixture = await semanticProject();
      const environment =
        semanticFailure === undefined
          ? { ...fixture.environment, EMBEDDING_TEST_KEY: undefined }
          : fixture.environment;
      const embeddingClientFactory: EmbeddingClientFactory | undefined =
        semanticFailure === undefined
          ? undefined
          : (profile): EmbeddingClient => ({
              kind:
                profile.kind === "voyage"
                  ? "voyage"
                  : "openai-compatible",
              model: profile.model,
              async embedDocuments() {
                throw semanticFailure;
              },
              async embedQuery() {
                throw new Error("query embedding must not run without an index");
              },
            });

      const built = await buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment,
        ...(embeddingClientFactory === undefined
          ? {}
          : { embeddingClientFactory }),
      });
      const manifest = JSON.parse(
        await readFile(
          path.join(
            fixture.root,
            ".llm-wiki",
            "generations",
            built.generation,
            "manifest.json",
          ),
          "utf8",
        ),
      ) as GenerationManifest;
      const status = await getProjectStatus(fixture.root);
      const explored = await exploreWiki(
        fixture.root,
        "stable lexical marker",
        { environment },
      );

      expect(manifest.semantic).toMatchObject({
        enabled: true,
        available: false,
        profile: "embedding",
        reasonCode,
      });
      expect(status).toMatchObject({
        state: "ready",
        semantic: {
          enabled: true,
          available: false,
          reasonCode,
        },
      });
      expect(explored.status.semantic).toBe("unavailable");
      expect(explored.status.semanticReasonCode).toBe(reasonCode);
      expect(explored.evidence[0]?.retrieval).toBe("lexical");
    },
  );

  it("still fails a lexical generation on an unexpected semantic implementation error", async () => {
    const fixture = await semanticProject();
    await expect(
      buildProject(fixture.root, {
        engine: new DeterministicSourceEngine(),
        environment: fixture.environment,
        embeddingClientFactory() {
          throw new Error("unexpected semantic implementation bug");
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await getProjectStatus(fixture.root)).toMatchObject({
      state: "error",
      reasonCode: "INTERNAL_ERROR",
    });
  });

  it("does not read the embedding credential while semantic retrieval is disabled", async () => {
    const fixture = await semanticProject({ semanticEnabled: false });
    let embeddingCredentialRead = false;
    const guardedEnvironment = new Proxy(fixture.environment, {
      get(target, property, receiver) {
        if (property === "EMBEDDING_TEST_KEY") {
          embeddingCredentialRead = true;
          throw new Error("embedding credential must not be read");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: guardedEnvironment,
    });
    const doctor = await doctorProject(fixture.root, guardedEnvironment);
    const manifest = JSON.parse(
      await readFile(
        path.join(
          fixture.root,
          ".llm-wiki",
          "generations",
          result.generation,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as GenerationManifest;
    expect(embeddingCredentialRead).toBe(false);
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({
        name: "semantic",
        ok: true,
        code: "SEMANTIC_DISABLED",
      }),
    );
    expect(manifest.semantic).toMatchObject({
      enabled: false,
      available: false,
      profile: "embedding",
      kind: "voyage",
      model: "voyage-3",
      reasonCode: "SEMANTIC_DISABLED",
      reason: "Semantic retrieval is disabled.",
    });
  });
});

describe("semantic query path", () => {
  it("uses the generation's embedding profile and returns semantic evidence first", async () => {
    const fixture = await semanticProject();
    const observedSecrets: string[] = [];
    const factory = semanticFactory(observedSecrets);
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });

    const result = await exploreWiki(fixture.root, "conceptually related", {
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });
    expect(observedSecrets).toEqual(["embedding-secret", "embedding-secret"]);
    expect(result.status.semantic).toBe("available");
    expect(result.status.semanticReasonCode).toBe("SEMANTIC_READY");
    expect(result.evidence[0]).toMatchObject({
      retrieval: "semantic",
      citation: {
        locator: {
          kind: "file",
          path: "docs/target.md",
        },
      },
    });
  });

  it("degrades to lexical evidence with a stable reason when the embedding key is missing", async () => {
    const fixture = await semanticProject();
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: semanticFactory(),
    });
    const queryEnvironment = {
      LLM_WIKI_CONFIG_HOME: fixture.configRoot,
      GENERATION_TEST_KEY: "generation-secret",
    };

    const result = await exploreWiki(fixture.root, "stable lexical marker", {
      environment: queryEnvironment,
      embeddingClientFactory: vi.fn(() => {
        throw new Error("client must not be constructed without a credential");
      }),
    });
    expect(result.status.semantic).toBe("unavailable");
    expect(result.status.semanticReasonCode).toBe(
      "SEMANTIC_CREDENTIAL_UNAVAILABLE",
    );
    expect(result.evidence[0]?.retrieval).toBe("lexical");
    expect(result.evidence[0]?.citation.locator).toMatchObject({
      kind: "file",
      path: "docs/lexical.md",
    });
    expect(result.warnings).toContain(
      "Semantic retrieval unavailable: SEMANTIC_CREDENTIAL_UNAVAILABLE.",
    );
  });

  it("refuses a rotated embedding credential that now matches the generation key", async () => {
    const fixture = await semanticProject();
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: semanticFactory(),
    });
    const queryEnvironment = {
      ...fixture.environment,
      EMBEDDING_TEST_KEY: "generation-secret",
    };
    const clientFactory = vi.fn(() => {
      throw new Error("matching credentials must be rejected before client creation");
    });

    const result = await exploreWiki(fixture.root, "stable lexical marker", {
      environment: queryEnvironment,
      embeddingClientFactory: clientFactory,
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(result.status.semantic).toBe("unavailable");
    expect(result.status.semanticReasonCode).toBe(
      "SEMANTIC_CREDENTIAL_MUST_DIFFER",
    );
    expect(result.evidence[0]?.retrieval).toBe("lexical");
  });

  it("rejects endpoint drift before sending the embedding credential", async () => {
    const fixture = await semanticProject();
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: semanticFactory(),
    });
    const changedProfiles = providerProfiles();
    changedProfiles.profiles = changedProfiles.profiles.map((profile) =>
      profile.name === "embedding"
        ? { ...profile, baseUrl: "https://changed.example.test/v1" }
        : profile,
    );
    await writeProviderProfiles(changedProfiles, fixture.environment);
    const clientFactory = vi.fn(() => {
      throw new Error("profile drift must be rejected before client creation");
    });

    const result = await exploreWiki(fixture.root, "stable lexical marker", {
      environment: fixture.environment,
      embeddingClientFactory: clientFactory,
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(result.status.semantic).toBe("unavailable");
    expect(result.status.semanticReasonCode).toBe("SEMANTIC_PROFILE_CHANGED");
    expect(result.evidence[0]?.retrieval).toBe("lexical");
  });
});

async function semanticProject(
  options: { semanticEnabled?: boolean } = {},
): Promise<{
  root: string;
  configRoot: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-semantic-project-"));
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-semantic-config-"));
  roots.push(root, configRoot);
  await mkdir(path.join(root, "docs"));
  await Promise.all([
    writeFile(
      path.join(root, "docs", "target.md"),
      "A quiet semantic target about distributed orchids.\n",
    ),
    writeFile(
      path.join(root, "docs", "lexical.md"),
      "stable lexical marker for fallback evidence\n",
    ),
  ]);
  await initializeProject(root, ["docs"]);
  const environment: NodeJS.ProcessEnv = {
    LLM_WIKI_CONFIG_HOME: configRoot,
    GENERATION_TEST_KEY: "generation-secret",
    EMBEDDING_TEST_KEY: "embedding-secret",
  };
  await writeProviderProfiles(providerProfiles(), environment);
  const config = await readProjectConfig(root);
  await writeProjectConfig(root, {
    ...config,
    providerProfile: "generation",
    embeddingProfile: "embedding",
    semantic: { enabled: options.semanticEnabled ?? true },
  });
  return { root, configRoot, environment };
}

function providerProfiles(): ProviderProfilesFile {
  return {
    schemaVersion: 1,
    profiles: [
      provider(
        "generation",
        "openai-compatible",
        "generation-model",
        "GENERATION_TEST_KEY",
      ),
      provider("embedding", "voyage", "voyage-3", "EMBEDDING_TEST_KEY"),
    ],
  };
}

function provider(
  name: string,
  kind: ProviderProfile["kind"],
  model: string,
  envName: string,
): ProviderProfile {
  const now = new Date().toISOString();
  return {
    name,
    kind,
    model,
    credential: { store: "env", envName },
    createdAt: now,
    updatedAt: now,
  };
}

function semanticFactory(observedSecrets: string[] = []): EmbeddingClientFactory {
  return (profile, secret): EmbeddingClient => {
    observedSecrets.push(secret);
    if (profile.kind !== "openai-compatible" && profile.kind !== "voyage") {
      throw new Error("invalid embedding profile");
    }
    return {
      kind: profile.kind,
      model: profile.model,
      async embedDocuments(inputs) {
        return inputs.map((input) =>
          input.includes("distributed orchids") ? [1, 0] : [0, 1],
        );
      },
      async embedQuery() {
        return [1, 0];
      },
    };
  };
}
