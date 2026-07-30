import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyRecord } from "../src/types.js";

const compile = vi.fn(async () => ({
  compiled: 1,
  skipped: 0,
  deleted: 0,
  concepts: ["test"],
  pages: ["test"],
  errors: [] as string[],
}));
const lint = vi.fn(async () => ({ errors: 0, warnings: 0, info: 0, results: [] }));
const ingestText = vi.fn(async () => ({
  filename: "new-source.md",
  charCount: 4,
  truncated: false,
  source: "llm-wiki-proxy:new",
  writeStatus: "created" as const,
}));
const deleteSource = vi.fn(async () => true);
const listPages = vi.fn(async () => ({
  pages: [{ slug: "one" }, { slug: "two" }],
  profile: {
    entityPages: [],
    total: 3,
  },
}));
const createWiki = vi.fn(() => ({
  compile,
  lint,
  ingestText,
  deleteSource,
  listPages,
}));

vi.mock("llm-wiki-compiler", () => ({ createWiki }));

const roots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  compile.mockResolvedValue({
    compiled: 1,
    skipped: 0,
    deleted: 0,
    concepts: ["test"],
    pages: ["test"],
    errors: [],
  });
  listPages.mockResolvedValue({
    pages: [{ slug: "one" }, { slug: "two" }],
    profile: {
      entityPages: [],
      total: 3,
    },
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiler adapter", () => {
  it("uses native embeddings:false, adds policy, and reconciles deleted sources", async () => {
    const { CompilerWikiEngine } = await import("../src/engine.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-engine-"));
    roots.push(root);
    await mkdir(path.join(root, "proxy-inputs"), { recursive: true });
    await mkdir(path.join(root, "engine", "sources"), { recursive: true });
    await writeFile(path.join(root, "proxy-inputs", "new.md"), "body");
    await writeFile(
      path.join(root, "engine", "sources", "new-source.md"),
      "---\ntitle: New\n---\n\nbody",
    );
    const current = proxy("new", "new.md");
    const previous = {
      ...proxy("old", "old.md"),
      engineSourceFile: "old-source.md",
      engineBodyStartLine: 5,
    };
    const engine = new CompilerWikiEngine(
      {
        name: "generation",
        kind: "openai-compatible",
        model: "model",
        baseUrl: "https://example.test/v1",
        credential: { store: "env", envName: "TEST_GENERATION_KEY" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "generation-secret",
    );
    const result = await engine.build({
      generationRoot: root,
      proxies: [current],
      previousProxies: [previous],
    });

    expect(deleteSource).toHaveBeenCalledWith("old-source.md");
    expect(compile).toHaveBeenCalledWith({
      embeddings: false,
      systemPolicy: expect.stringContaining("Never reproduce credentials"),
    });
    expect(result.sourceMappings).toEqual([
      {
        proxyId: "new",
        engineSourceFile: "new-source.md",
        engineBodyStartLine: 5,
      },
    ]);
    expect(result.pageCount).toBe(5);
    expect(process.env["OPENAI_API_KEY"]).not.toBe("generation-secret");
  });

  it("serializes compiler environment mutations and restores exact prior values", async () => {
    const { CompilerWikiEngine } = await import("../src/engine.js");
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observed: string[] = [];
    compile
      .mockImplementationOnce(async () => {
        observed.push(`first:${process.env["OPENAI_API_KEY"] ?? "missing"}`);
        firstStarted();
        await firstGate;
        observed.push(`first-end:${process.env["OPENAI_API_KEY"] ?? "missing"}`);
        return {
          compiled: 0,
          skipped: 0,
          deleted: 0,
          concepts: [],
          pages: [],
          errors: [],
        };
      })
      .mockImplementationOnce(async () => {
        observed.push(`second:${process.env["OPENAI_API_KEY"] ?? "missing"}`);
        return {
          compiled: 0,
          skipped: 0,
          deleted: 0,
          concepts: [],
          pages: [],
          errors: [],
        };
      });
    const first = new CompilerWikiEngine(
      {
        name: "generation-one",
        kind: "openai-compatible",
        model: "model-one",
        baseUrl: "https://one.example.test/v1",
        credential: { store: "env", envName: "TEST_GENERATION_KEY" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "secret-one",
    );
    const second = new CompilerWikiEngine(
      {
        name: "generation-two",
        kind: "openai-compatible",
        model: "model-two",
        baseUrl: "https://two.example.test/v1",
        credential: { store: "env", envName: "TEST_GENERATION_KEY" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "secret-two",
    );
    const originalPresent = Object.hasOwn(process.env, "OPENAI_API_KEY");
    const originalValue = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "outer-value";
    try {
      const firstBuild = first.build({ generationRoot: "first", proxies: [] });
      await firstStartedPromise;
      const secondBuild = second.build({ generationRoot: "second", proxies: [] });
      await Promise.resolve();
      expect(observed).toEqual(["first:secret-one"]);
      releaseFirst();
      await Promise.all([firstBuild, secondBuild]);
      expect(observed).toEqual([
        "first:secret-one",
        "first-end:secret-one",
        "second:secret-two",
      ]);
      expect(process.env["OPENAI_API_KEY"]).toBe("outer-value");
    } finally {
      if (originalPresent) {
        process.env["OPENAI_API_KEY"] = originalValue;
      } else {
        delete process.env["OPENAI_API_KEY"];
      }
    }
  });

  it.each([
    [Object.assign(new Error("secret credential rejected"), { status: 401 }), "PROVIDER_AUTH_FAILED"],
    [Object.assign(new Error("quota exceeded"), { status: 429 }), "PROVIDER_QUOTA_EXCEEDED"],
    [Object.assign(new Error("model not found"), { status: 404 }), "PROVIDER_MODEL_UNAVAILABLE"],
    [new TypeError("fetch failed"), "PROVIDER_NETWORK_FAILED"],
  ])("classifies provider failures without leaking details", async (failure, code) => {
    const { CompilerWikiEngine } = await import("../src/engine.js");
    compile.mockRejectedValueOnce(failure);
    const engine = new CompilerWikiEngine(
      {
        name: "generation",
        kind: "openai-compatible",
        model: "model",
        credential: { store: "env", envName: "TEST_GENERATION_KEY" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "secret-generation-value",
    );
    const rejected = await engine
      .build({ generationRoot: "unused", proxies: [] })
      .catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code });
    expect(String((rejected as Error).message)).not.toContain("secret");
  });

  it("classifies provider failures returned in compile results without retaining raw text", async () => {
    const { CompilerWikiEngine } = await import("../src/engine.js");
    compile.mockResolvedValueOnce({
      compiled: 0,
      skipped: 0,
      deleted: 0,
      concepts: [],
      pages: [],
      errors: ["401 unauthorized: secret-provider-detail"],
    });
    const engine = new CompilerWikiEngine(
      {
        name: "generation",
        kind: "openai-compatible",
        model: "model",
        credential: { store: "env", envName: "TEST_GENERATION_KEY" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "secret-generation-value",
    );
    const rejected = await engine
      .build({ generationRoot: "unused", proxies: [] })
      .catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
    expect(String((rejected as Error).message)).not.toContain(
      "secret-provider-detail",
    );
    expect((rejected as { details?: unknown }).details).toBeUndefined();
  });
});

function proxy(proxyId: string, proxyFile: string): ProxyRecord {
  return {
    proxyId,
    proxyFile,
    sourceId: `file:${proxyFile}`,
    sourceKind: "file",
    sourceHash: "a".repeat(64),
    title: proxyFile,
    chunkIndex: 0,
    originalStartLine: 1,
    originalEndLine: 1,
    lineMap: [1],
    locator: { kind: "file", path: proxyFile, lineStart: 1, lineEnd: 1 },
    bodyHash: "b".repeat(64),
  };
}
