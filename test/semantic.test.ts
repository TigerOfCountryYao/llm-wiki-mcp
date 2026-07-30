import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { catalogCompiledWikiPages } from "../src/pages.js";
import { projectPaths } from "../src/paths.js";
import { initializeProject } from "../src/project.js";
import { readSemanticIndex } from "../src/semantic-cache.js";
import { getProjectStatus } from "../src/status.js";
import type {
  EngineBuildInput,
  EngineBuildResult,
  GenerationManifest,
  ProviderProfile,
  ProviderProfilesFile,
  WikiEngine,
} from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("semantic build boundary", () => {
  it("sends compiled Wiki pages, never proxy inputs, to document embeddings", async () => {
    const fixture = await semanticProject();
    const rawMarker = "RAW-SOURCE-ONLY-MARKER-9f7c";
    const compiledMarker = "COMPILED-WIKI-ONLY-MARKER-31ab";
    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      `${rawMarker}\n`,
    );
    const observedDocuments: string[] = [];
    const engine = new CompiledPageEngine([
      {
        pageId: "concepts/compiled-summary",
        title: "Compiled summary",
        body: compiledMarker,
      },
    ]);

    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory(observedDocuments),
    });

    expect(observedDocuments.join("\n")).toContain(compiledMarker);
    expect(observedDocuments.join("\n")).not.toContain(rawMarker);
    const explored = await exploreWiki(fixture.root, compiledMarker, {
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory([]),
    });
    expect(explored.evidence[0]?.snippet).toContain(compiledMarker);
    expect(JSON.stringify(explored.evidence)).not.toContain(rawMarker);
  });

  it("uses semantic recall to select old Wiki pages for an incremental build", async () => {
    const fixture = await semanticProject();
    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      "initial evidence with no legacy page wording\n",
    );
    const engine = new CompiledPageEngine([
      {
        pageId: "concepts/legacy-checkout",
        title: "Legacy checkout coordinator",
        body: "Historical coordinator details.",
      },
    ]);
    const factory = directionalSemanticFactory();
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });

    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      "跨语言结算编排新证据 semantic-recall-probe\n",
    );
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });

    const candidates = engine.inputs[1]?.previousPageCandidates ?? [];
    expect(candidates).toContainEqual(
      expect.objectContaining({
        pageId: "concepts/legacy-checkout",
        retrieval: expect.stringMatching(/semantic/u),
      }),
    );
  });

  it("circuit-breaks remaining semantic requests after an incremental query failure", async () => {
    const fixture = await semanticProject();
    const engine = new CompiledPageEngine([
      {
        pageId: "concepts/circuit-page",
        title: "Circuit page",
        body: "Previously compiled circuit content.",
      },
    ]);
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory([]),
    });
    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      "changed evidence that starts an incremental lookup\n",
    );
    let documentCalls = 0;
    let queryCalls = 0;
    const failingFactory: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        documentCalls += 1;
        return inputs.map(() => [1, 0]);
      },
      async embedQuery() {
        queryCalls += 1;
        throw new LlmWikiError(
          "EMBEDDING_NETWORK_FAILED",
          "The embedding provider could not be reached.",
        );
      },
    });

    const built = await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: failingFactory,
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
    expect(queryCalls).toBe(1);
    expect(documentCalls).toBe(0);
    expect(manifest.semantic).toMatchObject({
      available: false,
      reasonCode: "EMBEDDING_NETWORK_FAILED",
    });
  });

  it("does not disguise an incremental implementation bug as provider fallback", async () => {
    const fixture = await semanticProject();
    const engine = new CompiledPageEngine([
      {
        pageId: "concepts/incremental-bug",
        title: "Incremental bug",
        body: "Historical compiled evidence.",
      },
    ]);
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory([]),
    });
    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      "changed evidence that triggers incremental recall\n",
    );
    const buggyFactory: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        return inputs.map(() => [1, 0]);
      },
      async embedQuery() {
        throw new Error("unexpected injected implementation failure");
      },
    });

    await expect(
      buildProject(fixture.root, {
        engine,
        environment: fixture.environment,
        embeddingClientFactory: buggyFactory,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rebuilds the page cache when a provider changes vector dimensions", async () => {
    const fixture = await semanticProject();
    const engine = new CompiledPageEngine([
      {
        pageId: "concepts/dimension-drift",
        title: "Dimension drift",
        body: "Compiled dimension evidence.",
      },
    ]);
    const twoDimensions: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        return inputs.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    });
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: twoDimensions,
    });
    await writeFile(
      path.join(fixture.root, "docs", "target.md"),
      "changed evidence triggers the old two-dimensional cache\n",
    );
    let rebuiltDocuments = 0;
    const threeDimensions: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        rebuiltDocuments += inputs.length;
        return inputs.map(() => [1, 0, 0]);
      },
      async embedQuery() {
        return [1, 0, 0];
      },
    });

    const result = await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: threeDimensions,
    });
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
    const explored = await exploreWiki(fixture.root, "dimension evidence", {
      environment: fixture.environment,
      embeddingClientFactory: threeDimensions,
    });

    expect(rebuiltDocuments).toBeGreaterThan(0);
    expect(manifest.semantic.available).toBe(true);
    expect(explored.status.semantic).toBe("available");
  });

  it("persists completed page batches and resumes after a provider failure", async () => {
    const fixture = await semanticProject();
    const pages = Array.from({ length: 9 }, (_, index) => ({
      pageId: `concepts/page-${String(index).padStart(2, "0")}`,
      title: `Page ${index}`,
      body: `Compiled page batch marker ${index}.`,
    }));
    const engine = new CompiledPageEngine(pages);
    let firstBuildBatch = 0;
    const firstFactory: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        firstBuildBatch += 1;
        if (firstBuildBatch === 2) {
          throw new LlmWikiError(
            "EMBEDDING_NETWORK_FAILED",
            "The embedding provider could not be reached.",
          );
        }
        return inputs.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    });
    const first = await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: firstFactory,
    });
    const firstManifest = JSON.parse(
      await readFile(
        path.join(
          fixture.root,
          ".llm-wiki",
          "generations",
          first.generation,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as GenerationManifest;
    expect(firstBuildBatch).toBe(2);
    expect(firstManifest.semantic.available).toBe(false);
    const firstGenerationRoot = path.join(
      fixture.root,
      ".llm-wiki",
      "generations",
      first.generation,
    );
    const partialPages = await catalogCompiledWikiPages(
      firstGenerationRoot,
      firstManifest.proxies,
      new Set(firstManifest.sources.map((source) => source.sourceId)),
      undefined,
      firstManifest.pages,
    );
    await expect(
      readSemanticIndex(
        projectPaths(fixture.root).semanticIndex,
        partialPages,
        {
          profile: "embedding",
          kind: "voyage",
          model: "voyage-3",
          profileFingerprint: firstManifest.semantic.profileFingerprint!,
        },
      ),
    ).resolves.toBeNull();

    const resumedDocuments: string[] = [];
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory(resumedDocuments),
    });
    expect(resumedDocuments).toHaveLength(1);
    expect(resumedDocuments[0]).toContain("Compiled page batch marker 8.");
    expect(resumedDocuments[0]).not.toContain("Compiled page batch marker 7.");
  });

  it("keeps completed page batches when a build is cancelled", async () => {
    const fixture = await semanticProject();
    const pages = Array.from({ length: 9 }, (_, index) => ({
      pageId: `concepts/cancel-page-${String(index).padStart(2, "0")}`,
      title: `Cancel page ${index}`,
      body: `Compiled cancellation marker ${index}.`,
    }));
    const engine = new CompiledPageEngine(pages);
    const controller = new AbortController();
    let batchCalls = 0;
    const cancellingFactory: EmbeddingClientFactory = (profile) => ({
      kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
      model: profile.model,
      async embedDocuments(inputs) {
        batchCalls += 1;
        controller.abort();
        return inputs.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    });

    await expect(
      buildProject(fixture.root, {
        engine,
        environment: fixture.environment,
        embeddingClientFactory: cancellingFactory,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "BUILD_CANCELLED" });
    expect(batchCalls).toBe(1);

    const resumedDocuments: string[] = [];
    await buildProject(fixture.root, {
      engine,
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory(resumedDocuments),
    });
    expect(resumedDocuments).toHaveLength(1);
    expect(resumedDocuments[0]).toContain("Compiled cancellation marker 8.");
  });

  it("recovers a zero-byte cache left by a hard interruption", async () => {
    const fixture = await semanticProject();
    const indexFile = projectPaths(fixture.root).semanticIndex;
    await mkdir(path.dirname(indexFile), { recursive: true });
    await writeFile(indexFile, "");
    const observedDocuments: string[] = [];

    const result = await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: recordingSemanticFactory(observedDocuments),
    });
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

    expect(observedDocuments.length).toBeGreaterThan(0);
    expect(manifest.semantic.available).toBe(true);
  });

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
    expect(manifest.pages?.length).toBeGreaterThan(0);
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
  it("does not create or initialize a missing cache during a read", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "llm-wiki-semantic-readonly-"),
    );
    roots.push(root);
    const indexFile = projectPaths(root).semanticIndex;

    await expect(
      readSemanticIndex(indexFile, [], {
        profile: "embedding",
        kind: "voyage",
        model: "voyage-3",
        profileFingerprint: "f".repeat(64),
      }),
    ).resolves.toBeNull();
    await expect(readFile(indexFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses the generation's embedding profile and returns semantic evidence first", async () => {
    const fixture = await semanticProject();
    const observedSecrets: string[] = [];
    const factory = semanticFactory(observedSecrets);
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });

    const semanticDirectory = path.dirname(
      projectPaths(fixture.root).semanticIndex,
    );
    const filesBeforeRead = (await readdir(semanticDirectory)).sort();
    const result = await exploreWiki(fixture.root, "conceptually related", {
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });
    const filesAfterRead = (await readdir(semanticDirectory)).sort();
    expect(observedSecrets).toEqual(["embedding-secret", "embedding-secret"]);
    expect(filesAfterRead).toEqual(filesBeforeRead);
    expect(
      filesAfterRead.some((file) => /-(?:journal|shm|wal)$/u.test(file)),
    ).toBe(false);
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

  it("rejects a sidecar symlink without modifying its target", async () => {
    const fixture = await semanticProject();
    const factory = semanticFactory();
    await buildProject(fixture.root, {
      engine: new DeterministicSourceEngine(),
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });
    const indexFile = projectPaths(fixture.root).semanticIndex;
    const sentinel = path.join(fixture.root, "sidecar-sentinel.txt");
    const sidecar = `${indexFile}-shm`;
    await writeFile(sentinel, "safe");
    await symlink(sentinel, sidecar, "file");

    const result = await exploreWiki(fixture.root, "stable lexical marker", {
      environment: fixture.environment,
      embeddingClientFactory: factory,
    });

    expect(result.status.semantic).toBe("unavailable");
    expect(result.status.semanticReasonCode).toBe("SEMANTIC_INDEX_INVALID");
    expect(result.evidence[0]?.retrieval).toBe("lexical");
    expect(await readFile(sentinel, "utf8")).toBe("safe");
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

interface TestCompiledPage {
  pageId: string;
  title: string;
  body: string;
}

class CompiledPageEngine implements WikiEngine {
  readonly inputs: EngineBuildInput[] = [];

  constructor(private readonly pages: TestCompiledPage[]) {}

  async build(input: EngineBuildInput): Promise<EngineBuildResult> {
    this.inputs.push(input);
    const wikiRoot = path.join(input.generationRoot, "engine", "wiki");
    await mkdir(wikiRoot, { recursive: true });
    const source = input.proxies[0];
    if (source === undefined) {
      throw new Error("test engine requires one source proxy");
    }
    const engineSourceFile = `${source.proxyId}.md`;
    for (const page of this.pages) {
      const target = path.join(wikiRoot, `${page.pageId}.md`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        `---\ntitle: ${page.title}\n---\n\n${page.body} ^[${engineSourceFile}:1]\n`,
      );
    }
    await writeFile(path.join(wikiRoot, "index.md"), "# Wiki index\n");
    return {
      name: "test-compiled-page-engine",
      version: "1",
      pageCount: this.pages.length,
      sourceMappings: input.proxies.map((proxy) => ({
        proxyId: proxy.proxyId,
        engineSourceFile,
        engineBodyStartLine: 1,
      })),
      compiledPages: this.pages.map((page) => ({
        ...page,
        relativePath: `wiki/${page.pageId}.md`,
      })),
    };
  }
}

function recordingSemanticFactory(
  observedDocuments: string[],
): EmbeddingClientFactory {
  return (profile): EmbeddingClient => ({
    kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
    model: profile.model,
    async embedDocuments(inputs) {
      observedDocuments.push(...inputs);
      return inputs.map(() => [1, 0]);
    },
    async embedQuery() {
      return [1, 0];
    },
  });
}

function directionalSemanticFactory(): EmbeddingClientFactory {
  return (profile): EmbeddingClient => ({
    kind: profile.kind === "voyage" ? "voyage" : "openai-compatible",
    model: profile.model,
    async embedDocuments(inputs) {
      return inputs.map((input) =>
        input.includes("Historical coordinator details") ? [1, 0] : [0, 1],
      );
    },
    async embedQuery(input) {
      return input.includes("semantic-recall-probe") ? [1, 0] : [0, 1];
    },
  });
}
