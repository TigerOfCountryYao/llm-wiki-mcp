import {
  findProviderProfile,
  readProjectConfig,
  readProviderProfiles,
  writeProjectConfig,
  writeProviderProfiles,
} from "./config.js";
import { credentialAvailability, credentialStoreForProfile } from "./credentials.js";
import { LlmWikiError } from "./errors.js";
import { STATE_SCHEMA_VERSION, type ProviderKind, type ProviderProfile } from "./types.js";

export interface SetProviderProfileInput {
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  credentialStore: "keyring" | "env";
  envName?: string;
}

export async function setProviderProfile(
  input: SetProviderProfileInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderProfile> {
  validateProfileInput(input);
  const file = await readProviderProfiles(environment);
  const previous = file.profiles.find((profile) => profile.name === input.name);
  const now = new Date().toISOString();
  const profile: ProviderProfile = {
    name: input.name,
    kind: input.kind,
    model: input.model,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    credential: {
      store: input.credentialStore,
      ...(input.envName === undefined ? {} : { envName: input.envName }),
    },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const profiles = [
    ...file.profiles.filter((candidate) => candidate.name !== input.name),
    profile,
  ].sort((left, right) => left.name.localeCompare(right.name));
  await writeProviderProfiles(
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      profiles,
    },
    environment,
  );
  return profile;
}

export async function listProviderProfiles(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Array<ProviderProfile & { credentialAvailable: boolean; credentialReasonCode?: string }>> {
  const file = await readProviderProfiles(environment);
  return Promise.all(
    file.profiles.map(async (profile) => {
      const availability = await credentialAvailability(profile, environment);
      return {
        ...profile,
        credentialAvailable: availability.available,
        ...(availability.reasonCode === undefined
          ? {}
          : { credentialReasonCode: availability.reasonCode }),
      };
    }),
  );
}

export async function setProviderCredential(
  profileName: string,
  secret: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string; stored: true; store: "keyring" }> {
  const profile = await requireProfile(profileName, environment);
  if (profile.credential.store !== "keyring") {
    throw new LlmWikiError(
      "ENV_CREDENTIAL_READ_ONLY",
      "This profile uses an environment credential; update it in the launching process.",
    );
  }
  await credentialStoreForProfile(profile, environment).set(profile, secret);
  return { profile: profileName, stored: true, store: "keyring" };
}

export async function deleteProviderCredential(
  profileName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string; deleted: boolean }> {
  const profile = await requireProfile(profileName, environment);
  const deleted = await credentialStoreForProfile(profile, environment).delete(profile);
  return { profile: profileName, deleted };
}

export async function useProviderProfile(
  root: string,
  profileName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string; root: string }> {
  const profile = await requireProfile(profileName, environment);
  if (profile.kind === "voyage") {
    throw new LlmWikiError(
      "INVALID_GENERATION_PROVIDER_KIND",
      "Voyage profiles can be used only for embeddings, not Wiki generation.",
    );
  }
  const config = await readProjectConfig(root);
  await writeProjectConfig(root, { ...config, providerProfile: profileName });
  return { profile: profileName, root };
}

export async function requireProfile(
  profileName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderProfile> {
  const profile = await findProviderProfile(profileName, environment);
  if (profile === null) {
    throw new LlmWikiError("PROVIDER_PROFILE_NOT_FOUND", `Provider profile not found: ${profileName}`);
  }
  return profile;
}

function validateProfileInput(input: SetProviderProfileInput): void {
  if (input.name.trim() === "" || input.model.trim() === "") {
    throw new LlmWikiError("INVALID_PROVIDER_PROFILE", "Provider name and model are required.");
  }
  if (input.credentialStore === "env" && (input.envName === undefined || input.envName === "")) {
    throw new LlmWikiError(
      "CREDENTIAL_ENV_NOT_CONFIGURED",
      "An environment credential profile requires --env-name.",
    );
  }
  if (input.credentialStore === "keyring" && input.envName !== undefined) {
    throw new LlmWikiError(
      "INVALID_PROVIDER_PROFILE",
      "--env-name is only valid for environment credential profiles.",
    );
  }
  if (input.baseUrl !== undefined) {
    try {
      new URL(input.baseUrl);
    } catch {
      throw new LlmWikiError("INVALID_PROVIDER_PROFILE", "Provider base URL is invalid.");
    }
  }
}
