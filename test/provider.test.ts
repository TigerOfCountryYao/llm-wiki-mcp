import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentCredentialStore } from "../src/credentials.js";
import { withScopedProcessEnvironment } from "../src/process-environment.js";
import { setProviderProfile } from "../src/provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider credential boundary", () => {
  it("stores only an environment variable name, never its secret value", async () => {
    const configRoot = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-provider-"));
    roots.push(configRoot);
    const environment = {
      LLM_WIKI_CONFIG_HOME: configRoot,
      TEST_WIKI_KEY: "super-secret-value",
    };
    const profile = await setProviderProfile(
      {
        name: "test",
        kind: "openai-compatible",
        model: "model",
        credentialStore: "env",
        envName: "TEST_WIKI_KEY",
      },
      environment,
    );
    expect(await new EnvironmentCredentialStore(environment).get(profile)).toBe(
      "super-secret-value",
    );
    const persisted = await readFile(path.join(configRoot, "profiles.json"), "utf8");
    expect(persisted).toContain("TEST_WIKI_KEY");
    expect(persisted).not.toContain("super-secret-value");
  });

  it("never falls back to a different common provider variable", async () => {
    const profile = {
      name: "test",
      kind: "anthropic" as const,
      model: "model",
      credential: { store: "env" as const, envName: "ONLY_THIS_KEY" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = new EnvironmentCredentialStore({ ANTHROPIC_API_KEY: "must-not-be-used" });
    expect(await store.get(profile)).toBeNull();
  });

  it("never observes another project's temporary compiler credential", async () => {
    const profile = {
      name: "embedding",
      kind: "openai-compatible" as const,
      model: "embedding-model",
      credential: { store: "env" as const, envName: "OPENAI_API_KEY" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const originalPresent = Object.hasOwn(process.env, "OPENAI_API_KEY");
    const originalValue = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "embedding-secret";
    let releaseCompiler!: () => void;
    let compilerStarted!: () => void;
    const compilerGate = new Promise<void>((resolve) => {
      releaseCompiler = resolve;
    });
    const compilerStartedPromise = new Promise<void>((resolve) => {
      compilerStarted = resolve;
    });
    try {
      const compiler = withScopedProcessEnvironment(
        { OPENAI_API_KEY: "generation-secret" },
        async () => {
          compilerStarted();
          await compilerGate;
        },
      );
      await compilerStartedPromise;
      let credentialResolved = false;
      const credential = new EnvironmentCredentialStore(process.env)
        .get(profile)
        .then((value) => {
          credentialResolved = true;
          return value;
        });
      await Promise.resolve();
      expect(credentialResolved).toBe(false);
      releaseCompiler();
      await compiler;
      await expect(credential).resolves.toBe("embedding-secret");
    } finally {
      if (originalPresent) {
        process.env["OPENAI_API_KEY"] = originalValue;
      } else {
        delete process.env["OPENAI_API_KEY"];
      }
    }
  });
});
