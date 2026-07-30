import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { LlmWikiError } from "./errors.js";
import { readJsonFile, readJsonIfExists, writeJsonAtomic } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import {
  PROJECT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  type ConsentFile,
  type ProjectConfig,
  type ProviderProfile,
  type ProviderProfilesFile,
} from "./types.js";

const projectConfigSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    sources: z.array(z.string()).default([]),
    providerProfile: z.string().min(1).nullable().default(null),
    embeddingProfile: z.string().min(1).nullable().default(null),
    semantic: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  })
  .strict();

const consentSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    selectedPaths: z.array(z.string()),
    scopeMode: z.enum(["git", "filesystem"]).optional(),
    confirmedAt: z.iso.datetime(),
  })
  .strict();

const providerProfileSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["anthropic", "openai-compatible", "voyage"]),
    model: z.string().min(1),
    baseUrl: z.url().optional(),
    credential: z
      .object({
        store: z.enum(["keyring", "env"]),
        envName: z.string().min(1).optional(),
      })
      .strict(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const providerProfilesSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    profiles: z.array(providerProfileSchema),
  })
  .strict();

export function defaultProjectConfig(sources: string[]): ProjectConfig {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sources,
    providerProfile: null,
    embeddingProfile: null,
    semantic: { enabled: false },
  };
}

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  const target = projectPaths(root).projectConfig;
  const raw = await readJsonFile<unknown>(target);
  const result = projectConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new LlmWikiError("INVALID_PROJECT_CONFIG", `Invalid ${path.basename(target)}.`, result.error.issues);
  }
  return result.data;
}

export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const result = projectConfigSchema.safeParse(config);
  if (!result.success) {
    throw new LlmWikiError("INVALID_PROJECT_CONFIG", "Refusing to write invalid project config.", result.error.issues);
  }
  await writeJsonAtomic(projectPaths(root).projectConfig, result.data);
}

export async function readConsent(root: string): Promise<ConsentFile> {
  const target = projectPaths(root).consent;
  const raw = await readJsonFile<unknown>(target);
  const result = consentSchema.safeParse(raw);
  if (!result.success) {
    throw new LlmWikiError("INVALID_CONSENT", `Invalid local consent file: ${target}`, result.error.issues);
  }
  return result.data;
}

export async function readConsentIfExists(root: string): Promise<ConsentFile | null> {
  const raw = await readJsonIfExists<unknown>(projectPaths(root).consent);
  if (raw === null) {
    return null;
  }
  const result = consentSchema.safeParse(raw);
  if (!result.success) {
    throw new LlmWikiError("INVALID_CONSENT", "Invalid local consent file.", result.error.issues);
  }
  return result.data;
}

export async function writeConsent(root: string, consent: ConsentFile): Promise<void> {
  const result = consentSchema.safeParse(consent);
  if (!result.success) {
    throw new LlmWikiError("INVALID_CONSENT", "Refusing to write invalid consent.", result.error.issues);
  }
  await writeJsonAtomic(projectPaths(root).consent, result.data);
}

export function userConfigRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment["LLM_WIKI_CONFIG_HOME"];
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    const appData = environment["APPDATA"];
    return path.join(appData && appData !== "" ? appData : os.homedir(), "llm-wiki");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "llm-wiki");
  }
  return path.join(environment["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "llm-wiki");
}

export function profilesPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(userConfigRoot(environment), "profiles.json");
}

export async function readProviderProfiles(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderProfilesFile> {
  const raw = await readJsonIfExists<unknown>(profilesPath(environment));
  if (raw === null) {
    return { schemaVersion: STATE_SCHEMA_VERSION, profiles: [] };
  }
  const result = providerProfilesSchema.safeParse(raw);
  if (!result.success) {
    throw new LlmWikiError("INVALID_PROVIDER_CONFIG", "Invalid provider profiles file.", result.error.issues);
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    profiles: result.data.profiles.map((profile) => ({
      name: profile.name,
      kind: profile.kind,
      model: profile.model,
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      credential: {
        store: profile.credential.store,
        ...(profile.credential.envName === undefined
          ? {}
          : { envName: profile.credential.envName }),
      },
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  };
}

export async function writeProviderProfiles(
  value: ProviderProfilesFile,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const result = providerProfilesSchema.safeParse(value);
  if (!result.success) {
    throw new LlmWikiError("INVALID_PROVIDER_CONFIG", "Refusing to write invalid provider profiles.", result.error.issues);
  }
  await writeJsonAtomic(profilesPath(environment), result.data);
}

export async function findProviderProfile(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderProfile | null> {
  const profiles = await readProviderProfiles(environment);
  return profiles.profiles.find((profile) => profile.name === name) ?? null;
}
