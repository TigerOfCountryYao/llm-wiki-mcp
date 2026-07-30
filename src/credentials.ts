import { LlmWikiError } from "./errors.js";
import { withStableProcessEnvironment } from "./process-environment.js";
import type { ProviderProfile } from "./types.js";

const KEYRING_SERVICE = "llm-wiki";

export interface CredentialStore {
  readonly kind: "keyring" | "env";
  get(profile: ProviderProfile): Promise<string | null>;
  set(profile: ProviderProfile, secret: string): Promise<void>;
  delete(profile: ProviderProfile): Promise<boolean>;
}

export class EnvironmentCredentialStore implements CredentialStore {
  readonly kind = "env" as const;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async get(profile: ProviderProfile): Promise<string | null> {
    if (this.environment === process.env) {
      return withStableProcessEnvironment(() => this.read(profile));
    }
    return this.read(profile);
  }

  private read(profile: ProviderProfile): string | null {
    const envName = profile.credential.envName;
    if (envName === undefined) {
      throw new LlmWikiError(
        "CREDENTIAL_ENV_NOT_CONFIGURED",
        `Provider profile ${profile.name} does not name a credential environment variable.`,
      );
    }
    const value = this.environment[envName];
    return value === undefined || value === "" ? null : value;
  }

  async set(_profile: ProviderProfile, _secret: string): Promise<void> {
    throw new LlmWikiError(
      "ENV_CREDENTIAL_READ_ONLY",
      "Environment credentials must be supplied by the launching process.",
    );
  }

  async delete(_profile: ProviderProfile): Promise<boolean> {
    throw new LlmWikiError(
      "ENV_CREDENTIAL_READ_ONLY",
      "Environment credentials must be removed by the launching process.",
    );
  }
}

export class SystemKeyringCredentialStore implements CredentialStore {
  readonly kind = "keyring" as const;

  async get(profile: ProviderProfile): Promise<string | null> {
    const keytar = await loadKeytar();
    return keytar.getPassword(KEYRING_SERVICE, accountForProfile(profile.name));
  }

  async set(profile: ProviderProfile, secret: string): Promise<void> {
    if (secret.length === 0) {
      throw new LlmWikiError("EMPTY_CREDENTIAL", "Refusing to store an empty credential.");
    }
    const keytar = await loadKeytar();
    await keytar.setPassword(KEYRING_SERVICE, accountForProfile(profile.name), secret);
  }

  async delete(profile: ProviderProfile): Promise<boolean> {
    const keytar = await loadKeytar();
    return keytar.deletePassword(KEYRING_SERVICE, accountForProfile(profile.name));
  }
}

export function credentialStoreForProfile(
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  return profile.credential.store === "env"
    ? new EnvironmentCredentialStore(environment)
    : new SystemKeyringCredentialStore();
}

export async function credentialAvailability(
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ available: boolean; store: "keyring" | "env"; reasonCode?: string }> {
  try {
    const value = await credentialStoreForProfile(profile, environment).get(profile);
    return value === null
      ? {
          available: false,
          store: profile.credential.store,
          reasonCode: "CREDENTIAL_MISSING",
        }
      : { available: true, store: profile.credential.store };
  } catch (error) {
    return {
      available: false,
      store: profile.credential.store,
      reasonCode:
        error instanceof LlmWikiError ? error.code : "CREDENTIAL_STORE_UNAVAILABLE",
    };
  }
}

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarModule> {
  try {
    const imported = await import("@github/keytar");
    const candidate = (
      "default" in imported && imported.default !== undefined
        ? imported.default
        : imported
    ) as Partial<KeytarModule>;
    if (
      typeof candidate.getPassword !== "function" ||
      typeof candidate.setPassword !== "function" ||
      typeof candidate.deletePassword !== "function"
    ) {
      throw new Error("credential-store module has an incompatible API");
    }
    return candidate as KeytarModule;
  } catch (error) {
    throw new LlmWikiError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `The system credential store is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function accountForProfile(profileName: string): string {
  return `provider:${profileName}`;
}
