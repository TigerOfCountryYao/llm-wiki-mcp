export { buildProject, type BuildOptions, type BuildResult } from "./build.js";
export {
  type CredentialStore,
  EnvironmentCredentialStore,
  SystemKeyringCredentialStore,
  credentialAvailability,
  credentialStoreForProfile,
} from "./credentials.js";
export { doctorProject, type DoctorCheck } from "./doctor.js";
export { LlmWikiError } from "./errors.js";
export {
  buildSemanticIndex,
  createEmbeddingClient,
  embeddingProfileFingerprint,
  rankSemanticIndex,
  readSemanticIndex,
  type EmbeddingClient,
  type EmbeddingClientFactory,
} from "./embedding.js";
export { exploreWiki, type ExploreOptions } from "./explore.js";
export {
  deleteKnowledge,
  parseDeleteKnowledge,
  parseUpsertKnowledge,
  upsertKnowledge,
  type DeleteKnowledgeInput,
  type UpsertKnowledgeInput,
} from "./managed.js";
export {
  installForClients,
  uninstallForClients,
  type ClientInstallResult,
  type McpClient,
} from "./installer.js";
export { startMcpServer } from "./mcp.js";
export {
  deleteProviderCredential,
  listProviderProfiles,
  setProviderCredential,
  setProviderProfile,
  useProviderProfile,
  type SetProviderProfileInput,
} from "./provider.js";
export { initializeProject, uninitializeProject } from "./project.js";
export {
  withScopedProcessEnvironment,
  withStableProcessEnvironment,
} from "./process-environment.js";
export {
  catalogProject,
  enumerateAuthorizedSources,
  validateSelectedPaths,
} from "./scope.js";
export { getProjectStatus, type ProjectStatusResult } from "./status.js";
export { startWatcherLeader, type WatcherHandle } from "./watcher.js";
export type {
  CatalogEntry,
  CatalogResult,
  ConsentFile,
  ExploreEvidence,
  ExploreResult,
  EmbeddingProviderKind,
  GenerationManifest,
  ProjectConfig,
  ProviderProfile,
  RuntimeState,
  RuntimeStatus,
  SemanticIndex,
  SemanticIndexEntry,
  SourceLocator,
  WikiEngine,
} from "./types.js";
