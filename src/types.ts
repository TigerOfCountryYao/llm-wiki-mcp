export const PROJECT_SCHEMA_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 1 as const;

export type SourceKind = "file" | "knowledge" | "unsupported";
export type SourceScopeMode = "git" | "filesystem";

export type FileLocator = {
  kind: "file";
  path: string;
  lineStart: number;
  lineEnd: number;
};

export type PdfLocator = {
  kind: "pdf";
  path: string;
  page: number;
};

export type PptxLocator = {
  kind: "pptx";
  path: string;
  slide: number;
};

export type SpreadsheetLocator = {
  kind: "spreadsheet";
  path: string;
  sheet: string;
  range: string;
};

export type DocxLocator = {
  kind: "docx";
  path: string;
  section?: string;
  paragraph?: number;
};

export type ImageLocator = {
  kind: "image";
  path: string;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type KnowledgeLocator = {
  kind: "knowledge";
  knowledgeId: string;
  eventId?: string;
  messageId?: string;
  conversationId?: string;
};

export type UnsupportedLocator = {
  kind: "unsupported-source";
  path: string;
  mediaType?: string;
  reason: string;
};

export type SourceLocator =
  | FileLocator
  | PdfLocator
  | PptxLocator
  | SpreadsheetLocator
  | DocxLocator
  | ImageLocator
  | KnowledgeLocator
  | UnsupportedLocator;

export type ProviderKind = "anthropic" | "openai-compatible" | "voyage";
export type EmbeddingProviderKind = Extract<ProviderKind, "openai-compatible" | "voyage">;

export interface ProviderProfile {
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  credential: {
    store: "keyring" | "env";
    envName?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfilesFile {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  profiles: ProviderProfile[];
}

export interface GenerationProviderStatus {
  profile: string | null;
  kind?: ProviderKind;
  model?: string;
}

export interface GenerationSemanticStatus {
  enabled: boolean;
  available: boolean;
  profile: string | null;
  kind?: EmbeddingProviderKind;
  model?: string;
  profileFingerprint?: string;
  reasonCode: string;
  reason: string;
}

export interface ProjectConfig {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  sources: string[];
  providerProfile: string | null;
  embeddingProfile: string | null;
  semantic: {
    enabled: boolean;
  };
}

export interface ConsentFile {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  selectedPaths: string[];
  scopeMode?: SourceScopeMode | undefined;
  confirmedAt: string;
}

export interface CurrentPointer {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  generation: string;
  builtAt: string;
  sourceDigest: string;
}

export type RuntimeState =
  | "uninitialized"
  | "ready"
  | "stale"
  | "building"
  | "error"
  | "provider-unavailable";

export interface RuntimeStatus {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  state: RuntimeState;
  updatedAt: string;
  reasonCode?: string;
  message?: string;
  currentGeneration?: string;
  buildStartedAt?: string;
}

export interface CatalogEntry {
  path: string;
  kind: "file" | "directory";
  selected: boolean;
  eligible: boolean;
  reason?: string;
}

export interface CatalogResult {
  root: string;
  initialized: boolean;
  scopeMode: SourceScopeMode;
  entries: CatalogEntry[];
}

export interface ManagedKnowledge {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  id: string;
  title: string;
  text: string;
  provenance?: {
    eventId?: string;
    messageId?: string;
    conversationId?: string;
  };
  metadata?: Record<string, string>;
  contentHash: string;
  updatedAt: string;
}

export interface EnumeratedSource {
  sourceId: string;
  kind: "file" | "knowledge";
  title: string;
  relativePath?: string;
  absolutePath?: string;
  knowledge?: ManagedKnowledge;
  contentHash: string;
  size: number;
}

export interface UnsupportedSource {
  sourceId: string;
  kind: "unsupported";
  relativePath: string;
  contentHash: string;
  size: number;
  reason: string;
  mediaType?: string;
}

export interface ProxyRecord {
  proxyId: string;
  proxyFile: string;
  sourceId: string;
  sourceKind: SourceKind;
  sourceHash: string;
  title: string;
  chunkIndex: number;
  originalStartLine?: number;
  originalEndLine?: number;
  lineMap?: number[];
  engineSourceFile?: string;
  engineBodyStartLine?: number;
  locator: SourceLocator;
  bodyHash: string;
}

export interface GenerationManifest {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  generation: string;
  createdAt: string;
  sourceDigest: string;
  engine: {
    name: string;
    version: string;
  };
  provider: GenerationProviderStatus;
  semantic: GenerationSemanticStatus;
  sources: Array<{
    sourceId: string;
    kind: SourceKind;
    contentHash: string;
    relativePath?: string;
    size: number;
  }>;
  unsupported: UnsupportedSource[];
  proxies: ProxyRecord[];
}

export interface EngineBuildInput {
  generationRoot: string;
  proxies: ProxyRecord[];
  previousProxies?: ProxyRecord[];
}

export interface EngineBuildResult {
  name: string;
  version: string;
  pageCount: number;
  sourceMappings: Array<{
    proxyId: string;
    engineSourceFile: string;
    engineBodyStartLine: number;
  }>;
}

export interface WikiEngine {
  build(input: EngineBuildInput): Promise<EngineBuildResult>;
}

export interface ExploreCitation {
  locator: SourceLocator;
  sourceHash: string;
  generation: string;
}

export interface ExploreEvidence {
  title: string;
  snippet: string;
  score: number;
  retrieval: "lexical" | "semantic";
  citation: ExploreCitation;
}

export interface ExploreResult {
  query: string;
  status: {
    state: RuntimeState;
    generation?: string;
    builtAt?: string;
    reasonCode?: string;
    message?: string;
    semantic: "disabled" | "available" | "unavailable";
    semanticReasonCode?: string;
  };
  evidence: ExploreEvidence[];
  warnings: string[];
}

export interface SemanticIndexEntry {
  proxyId: string;
  bodyHash: string;
  segmentIndex: number;
  startLineIndex: number;
  endLineIndex: number;
  vector: number[];
}

export interface SemanticIndex {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  profile: string;
  kind: EmbeddingProviderKind;
  model: string;
  profileFingerprint: string;
  dimensions: number;
  createdAt: string;
  entries: SemanticIndexEntry[];
}

export interface CommandSuccess<T = unknown> {
  ok: true;
  command: string;
  data: T;
}

export interface CommandFailure {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type CommandEnvelope<T = unknown> = CommandSuccess<T> | CommandFailure;
