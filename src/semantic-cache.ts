import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createEmbeddingClient,
  embeddingDotProduct,
  embeddingProfileFingerprint,
  normalizeEmbeddingVector,
  type EmbeddingClientFactory,
} from "./embedding.js";
import { LlmWikiError } from "./errors.js";
import type { CompiledWikiPage } from "./pages.js";
import type {
  CompiledWikiPageRecord,
  EmbeddingProviderKind,
  ProviderProfile,
  SemanticIndex,
  SemanticIndexEntry,
} from "./types.js";

const INDEX_SCHEMA_VERSION = "3";
const SEGMENTER_VERSION = "wiki-page-lines-v1";
const MAX_EMBEDDING_INPUT_CHARS = 6_000;
const MAX_BATCH_PAGES = 8;
const MAX_BATCH_ESTIMATED_TOKENS = 24_000;
const MAX_VECTOR_DIMENSIONS = 32_768;

export interface SemanticIndexIdentity {
  profile: string;
  kind: EmbeddingProviderKind;
  model: string;
  profileFingerprint: string;
}

export async function buildSemanticIndex(
  indexFile: string,
  pages: readonly CompiledWikiPage[],
  profile: ProviderProfile,
  secret: string,
  options: {
    clientFactory?: EmbeddingClientFactory;
    signal?: AbortSignal;
    recoverCorrupt?: boolean;
    forceRebuild?: boolean;
  } = {},
): Promise<SemanticIndex> {
  const client = (options.clientFactory ?? createEmbeddingClient)(
    profile,
    secret,
  );
  if (client.kind !== profile.kind || client.model !== profile.model) {
    throw new LlmWikiError(
      "EMBEDDING_CLIENT_PROFILE_MISMATCH",
      "Embedding client does not match the selected embedding profile.",
    );
  }
  const identity: SemanticIndexIdentity = {
    profile: profile.name,
    kind: client.kind,
    model: client.model,
    profileFingerprint: embeddingProfileFingerprint(profile),
  };
  const corpus = describeCorpus(pages);
  const database = await openSemanticDatabaseForBuild(
    indexFile,
    options.recoverCorrupt ?? false,
  );
  try {
    if (options.forceRebuild === true) {
      deleteFingerprint(database, identity.profileFingerprint);
    }
    let reusable: SemanticIndexEntry[];
    try {
      reusable = readEntries(database, pages, identity);
    } catch (error) {
      if (
        error instanceof LlmWikiError &&
        error.code === "SEMANTIC_INDEX_INVALID"
      ) {
        deleteFingerprint(database, identity.profileFingerprint);
        reusable = [];
      } else {
        throw error;
      }
    }
    const existing = new Map(
      reusable.map((entry) => [semanticEntryKey(entry), entry] as const),
    );
    const pending = corpus.segments.filter(
      (segment) => !existing.has(semanticEntryKey(segment)),
    );

    const existingDimensions = reusable[0]?.vector.length;
    for (let offset = 0; offset < pending.length; ) {
      throwIfCancelled(options.signal);
      const batch: PendingSegment[] = [];
      const pagesInBatch = new Set<string>();
      let estimatedTokens = 0;
      while (offset < pending.length) {
        const item = pending[offset]!;
        const addsPage = !pagesInBatch.has(item.pageId);
        if (
          batch.length > 0 &&
          ((addsPage && pagesInBatch.size >= MAX_BATCH_PAGES) ||
            estimatedTokens + estimateTokens(item.text) >
              MAX_BATCH_ESTIMATED_TOKENS)
        ) {
          break;
        }
        batch.push(item);
        pagesInBatch.add(item.pageId);
        estimatedTokens += estimateTokens(item.text);
        offset += 1;
      }
      const vectors = await client.embedDocuments(
        batch.map((item) => item.text),
      );
      if (vectors.length !== batch.length) {
        throw new LlmWikiError(
          "EMBEDDING_RESPONSE_INVALID",
          "Embedding provider returned an unexpected number of vectors.",
        );
      }
      const completed = batch.map((item, index): SemanticIndexEntry => ({
        pageId: item.pageId,
        contentHash: item.contentHash,
        segmentIndex: item.segmentIndex,
        startLineIndex: item.startLineIndex,
        endLineIndex: item.endLineIndex,
        vector: normalizeEmbeddingVector(vectors[index]),
      }));
      const dimensions = completed[0]?.vector.length ?? existingDimensions ?? 0;
      if (
        dimensions > MAX_VECTOR_DIMENSIONS ||
        completed.some((entry) => entry.vector.length !== dimensions) ||
        (existingDimensions !== undefined &&
          existingDimensions !== dimensions)
      ) {
        deleteFingerprint(database, identity.profileFingerprint);
        throw new LlmWikiError(
          "EMBEDDING_DIMENSION_MISMATCH",
          "Embedding provider returned inconsistent vector dimensions.",
        );
      }
      persistBatch(database, identity, completed);
      throwIfCancelled(options.signal);
    }
    markCorpusComplete(database, identity, corpus);
    const index = readIndex(database, pages, identity);
    if (index === null) {
      return {
        schemaVersion: 1,
        ...identity,
        dimensions: 0,
        createdAt: new Date().toISOString(),
        entries: [],
      };
    }
    return index;
  } finally {
    database.close();
  }
}

export async function readSemanticIndex(
  indexFile: string,
  pages: readonly CompiledWikiPage[],
  identity: SemanticIndexIdentity,
): Promise<SemanticIndex | null> {
  const database = await openSemanticDatabaseReadOnly(indexFile);
  if (database === null) {
    return null;
  }
  try {
    return readIndex(database, pages, identity);
  } finally {
    database.close();
  }
}

export function rankSemanticIndex(
  index: SemanticIndex,
  queryVector: number[],
  maximum: number,
): Array<SemanticIndexEntry & { score: number }> {
  const normalizedQuery = normalizeEmbeddingVector(queryVector);
  if (normalizedQuery.length !== index.dimensions) {
    throw new LlmWikiError(
      "EMBEDDING_DIMENSION_MISMATCH",
      "Query vector dimensions do not match the semantic index.",
    );
  }
  return index.entries
    .map((entry) => ({
      ...entry,
      score: embeddingDotProduct(normalizedQuery, entry.vector),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.pageId.localeCompare(right.pageId) ||
        left.segmentIndex - right.segmentIndex,
    )
    .slice(0, Math.max(0, maximum));
}

interface PendingSegment {
  pageId: string;
  contentHash: string;
  segmentIndex: number;
  startLineIndex: number;
  endLineIndex: number;
  text: string;
}

interface SemanticRow {
  page_id: string;
  content_hash: string;
  segment_index: number;
  start_line_index: number;
  end_line_index: number;
  dimensions: number;
  vector_json: string;
}

interface SemanticCorpus {
  corpusHash: string;
  segments: PendingSegment[];
}

interface SemanticCorpusRow {
  expected_segments: number;
}

async function openSemanticDatabaseForBuild(
  indexFile: string,
  recoverCorrupt: boolean,
): Promise<DatabaseSync> {
  await mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  const target = await inspectDatabaseTarget(indexFile);
  await assertSafeDatabaseSidecars(indexFile, true);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(indexFile);
    if (target.exists) {
      assertDatabaseIntegrity(database);
      assertOwnedSemanticDatabase(database, target.size);
    }
    initializeDatabase(database);
    assertDatabaseIntegrity(database);
  } catch (error) {
    database?.close();
    if (
      !recoverCorrupt ||
      !target.exists ||
      !isConfirmedSqliteCorruption(error)
    ) {
      throw semanticIndexInvalid(error);
    }
    await removeCorruptSemanticDatabase(indexFile);
    try {
      database = new DatabaseSync(indexFile);
      initializeDatabase(database);
      assertDatabaseIntegrity(database);
    } catch (recoveryError) {
      database?.close();
      throw semanticIndexInvalid(recoveryError);
    }
  }
  await chmod(indexFile, 0o600).catch(() => undefined);
  return database;
}

async function openSemanticDatabaseReadOnly(
  indexFile: string,
): Promise<DatabaseSync | null> {
  let stats;
  try {
    stats = await lstat(indexFile);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw semanticIndexInvalid(error);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new LlmWikiError(
      "SEMANTIC_INDEX_INVALID",
      "Semantic cache path is not a regular file.",
    );
  }
  await assertSafeDatabaseSidecars(indexFile, false);
  await assertRollbackJournalDatabase(indexFile);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(indexFile, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    assertDatabaseIntegrity(database);
    const version = database
      .prepare("SELECT value FROM semantic_metadata WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    if (version?.value !== INDEX_SCHEMA_VERSION) {
      database.close();
      return null;
    }
    return database;
  } catch (error) {
    database?.close();
    throw semanticIndexInvalid(error);
  }
}

async function inspectDatabaseTarget(
  indexFile: string,
): Promise<{ exists: boolean; size: number }> {
  try {
    const stats = await lstat(indexFile);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic cache path is not a regular file.",
      );
    }
    return { exists: true, size: stats.size };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { exists: false, size: 0 };
    }
    throw error;
  }
}

async function assertSafeDatabaseSidecars(
  indexFile: string,
  allowRegularFiles: boolean,
): Promise<void> {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    try {
      const stats = await lstat(`${indexFile}${suffix}`);
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        !allowRegularFiles
      ) {
        throw new LlmWikiError(
          "SEMANTIC_INDEX_INVALID",
          "Semantic cache has an unsafe or unresolved sidecar.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function assertRollbackJournalDatabase(indexFile: string): Promise<void> {
  const header = Buffer.alloc(20);
  const handle = await openFile(indexFile, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000" ||
      header[18] !== 1 ||
      header[19] !== 1
    ) {
      throw new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic cache is incomplete or requires journal recovery.",
      );
    }
  } finally {
    await handle.close();
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  const result = database.prepare("PRAGMA quick_check").get() as
    | { quick_check?: string }
    | undefined;
  if (result?.quick_check !== "ok") {
    throw new CorruptSemanticDatabaseError();
  }
}

function assertOwnedSemanticDatabase(
  database: DatabaseSync,
  fileSize: number,
): void {
  const rows = database
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table'
          AND name IN ('semantic_metadata', 'page_segments')`,
    )
    .all() as unknown as Array<{ name: string }>;
  const hasMetadata = rows.some((row) => row.name === "semantic_metadata");
  const hasSegments = rows.some((row) => row.name === "page_segments");
  if (!hasMetadata || !hasSegments) {
    if (fileSize === 0 || hasMetadata || hasSegments) {
      throw new CorruptSemanticDatabaseError();
    }
    throw new LlmWikiError(
      "SEMANTIC_INDEX_INVALID",
      "Semantic cache path does not contain an llm-wiki index.",
    );
  }
}

async function removeCorruptSemanticDatabase(indexFile: string): Promise<void> {
  await inspectDatabaseTarget(indexFile);
  await assertSafeDatabaseSidecars(indexFile, true);
  await Promise.all([
    rm(indexFile, { force: true }),
    rm(`${indexFile}-journal`, { force: true }),
    rm(`${indexFile}-shm`, { force: true }),
    rm(`${indexFile}-wal`, { force: true }),
  ]);
}

class CorruptSemanticDatabaseError extends Error {
  constructor() {
    super("Semantic cache failed its integrity check.");
    this.name = "CorruptSemanticDatabaseError";
  }
}

function isConfirmedSqliteCorruption(error: unknown): boolean {
  if (error instanceof CorruptSemanticDatabaseError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & {
    errcode?: number;
    errstr?: string;
  };
  return (
    candidate.errcode === 11 ||
    candidate.errcode === 26 ||
    /database disk image is malformed|file is not a database/u.test(
      `${candidate.message} ${candidate.errstr ?? ""}`.toLocaleLowerCase(
        "en-US",
      ),
    )
  );
}

function semanticIndexInvalid(error: unknown): LlmWikiError {
  return error instanceof LlmWikiError &&
    error.code === "SEMANTIC_INDEX_INVALID"
    ? error
    : new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic cache could not be opened or validated.",
      );
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS semantic_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS page_segments (
      profile_fingerprint TEXT NOT NULL,
      profile TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      segmenter_version TEXT NOT NULL,
      page_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_line_index INTEGER NOT NULL,
      end_line_index INTEGER NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        profile_fingerprint,
        segmenter_version,
        page_id,
        content_hash,
        segment_index
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS page_segments_lookup
      ON page_segments(profile_fingerprint, segmenter_version, page_id, content_hash);
    CREATE TABLE IF NOT EXISTS semantic_corpora (
      profile_fingerprint TEXT NOT NULL,
      segmenter_version TEXT NOT NULL,
      corpus_hash TEXT NOT NULL,
      expected_segments INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (profile_fingerprint, segmenter_version, corpus_hash)
    ) STRICT;
  `);
  const version = database
    .prepare("SELECT value FROM semantic_metadata WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  if (version?.value !== undefined && version.value !== INDEX_SCHEMA_VERSION) {
    database.exec(`
      DELETE FROM page_segments;
      DELETE FROM semantic_corpora;
      DELETE FROM semantic_metadata;
    `);
  }
  database
    .prepare(
      "INSERT OR REPLACE INTO semantic_metadata(key, value) VALUES ('schema_version', ?)",
    )
    .run(INDEX_SCHEMA_VERSION);
}

function readIndex(
  database: DatabaseSync,
  pages: readonly CompiledWikiPage[],
  identity: SemanticIndexIdentity,
): SemanticIndex | null {
  const corpus = describeCorpus(pages);
  if (corpus.segments.length === 0) {
    return null;
  }
  const completion = database
    .prepare(
      `SELECT expected_segments
         FROM semantic_corpora
        WHERE profile_fingerprint = ?
          AND segmenter_version = ?
          AND corpus_hash = ?`,
    )
    .get(
      identity.profileFingerprint,
      SEGMENTER_VERSION,
      corpus.corpusHash,
    ) as SemanticCorpusRow | undefined;
  if (completion?.expected_segments !== corpus.segments.length) {
    return null;
  }
  const entries = readEntries(database, pages, identity);
  const expected = new Set(corpus.segments.map(semanticEntryKey));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !expected.has(semanticEntryKey(entry)))
  ) {
    return null;
  }
  const dimensions = entries[0]!.vector.length;
  return {
    schemaVersion: 1,
    ...identity,
    dimensions,
    createdAt: new Date().toISOString(),
    entries,
  };
}

function readEntries(
  database: DatabaseSync,
  pages: readonly CompiledWikiPageRecord[],
  identity: SemanticIndexIdentity,
): SemanticIndexEntry[] {
  const live = new Map(pages.map((page) => [page.pageId, page.contentHash]));
  const rows = database
    .prepare(
      `SELECT page_id, content_hash, segment_index, start_line_index,
              end_line_index, dimensions, vector_json
         FROM page_segments
        WHERE profile_fingerprint = ? AND segmenter_version = ?
        ORDER BY page_id, segment_index`,
    )
    .all(identity.profileFingerprint, SEGMENTER_VERSION) as unknown as SemanticRow[];
  const entries: SemanticIndexEntry[] = [];
  let dimensions: number | undefined;
  for (const row of rows) {
    if (live.get(row.page_id) !== row.content_hash) {
      continue;
    }
    let vector: unknown;
    try {
      vector = JSON.parse(row.vector_json);
    } catch {
      throw new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic page cache contains invalid vector data.",
      );
    }
    if (
      !Array.isArray(vector) ||
      vector.length !== row.dimensions ||
      vector.length === 0 ||
      vector.length > MAX_VECTOR_DIMENSIONS ||
      vector.some((item) => typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic page cache contains an invalid vector.",
      );
    }
    dimensions ??= vector.length;
    const magnitude = Math.sqrt(
      vector.reduce((sum, item) => sum + item * item, 0),
    );
    if (
      vector.length !== dimensions ||
      !Number.isFinite(magnitude) ||
      Math.abs(magnitude - 1) > 1e-6 ||
      !Number.isSafeInteger(row.segment_index) ||
      !Number.isSafeInteger(row.start_line_index) ||
      !Number.isSafeInteger(row.end_line_index) ||
      row.segment_index < 0 ||
      row.start_line_index < 0 ||
      row.end_line_index < row.start_line_index
    ) {
      throw new LlmWikiError(
        "SEMANTIC_INDEX_INVALID",
        "Semantic page cache contains inconsistent segment data.",
      );
    }
    entries.push({
      pageId: row.page_id,
      contentHash: row.content_hash,
      segmentIndex: row.segment_index,
      startLineIndex: row.start_line_index,
      endLineIndex: row.end_line_index,
      vector,
    });
  }
  return entries;
}

function describeCorpus(pages: readonly CompiledWikiPage[]): SemanticCorpus {
  const segments = [...pages]
    .sort((left, right) => left.pageId.localeCompare(right.pageId))
    .flatMap((page) =>
      splitEmbeddingSegments(page.body).map(
        (segment, segmentIndex): PendingSegment => ({
          pageId: page.pageId,
          contentHash: page.contentHash,
          segmentIndex,
          startLineIndex: segment.startLineIndex,
          endLineIndex: segment.endLineIndex,
          text: segment.text,
        }),
      ),
    );
  const descriptors = segments.map(({ text: _text, ...descriptor }) => descriptor);
  return {
    corpusHash: createHash("sha256")
      .update(JSON.stringify(descriptors), "utf8")
      .digest("hex"),
    segments,
  };
}

function persistBatch(
  database: DatabaseSync,
  identity: SemanticIndexIdentity,
  entries: readonly SemanticIndexEntry[],
): void {
  const statement = database.prepare(`
    INSERT OR REPLACE INTO page_segments(
      profile_fingerprint, profile, kind, model, segmenter_version,
      page_id, content_hash, segment_index, start_line_index, end_line_index,
      dimensions, vector_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = new Date().toISOString();
    for (const entry of entries) {
      statement.run(
        identity.profileFingerprint,
        identity.profile,
        identity.kind,
        identity.model,
        SEGMENTER_VERSION,
        entry.pageId,
        entry.contentHash,
        entry.segmentIndex,
        entry.startLineIndex,
        entry.endLineIndex,
        entry.vector.length,
        JSON.stringify(entry.vector),
        updatedAt,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function markCorpusComplete(
  database: DatabaseSync,
  identity: SemanticIndexIdentity,
  corpus: SemanticCorpus,
): void {
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS current_semantic_segments (
      page_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      PRIMARY KEY (page_id, content_hash, segment_index)
    ) STRICT;
  `);
  const insertCurrent = database.prepare(`
    INSERT OR REPLACE INTO current_semantic_segments(
      page_id, content_hash, segment_index
    ) VALUES (?, ?, ?)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM current_semantic_segments");
    for (const segment of corpus.segments) {
      insertCurrent.run(
        segment.pageId,
        segment.contentHash,
        segment.segmentIndex,
      );
    }
    database
      .prepare(
        `DELETE FROM page_segments
          WHERE profile_fingerprint = ?
            AND segmenter_version = ?
            AND NOT EXISTS (
              SELECT 1
                FROM current_semantic_segments AS current
               WHERE current.page_id = page_segments.page_id
                 AND current.content_hash = page_segments.content_hash
                 AND current.segment_index = page_segments.segment_index
            )`,
      )
      .run(identity.profileFingerprint, SEGMENTER_VERSION);
    database
      .prepare(
        `DELETE FROM semantic_corpora
          WHERE profile_fingerprint = ?
            AND segmenter_version = ?
            AND corpus_hash <> ?`,
      )
      .run(
        identity.profileFingerprint,
        SEGMENTER_VERSION,
        corpus.corpusHash,
      );
    database
      .prepare(
        `INSERT OR REPLACE INTO semantic_corpora(
           profile_fingerprint, segmenter_version, corpus_hash,
           expected_segments, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        identity.profileFingerprint,
        SEGMENTER_VERSION,
        corpus.corpusHash,
        corpus.segments.length,
        new Date().toISOString(),
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deleteFingerprint(database: DatabaseSync, fingerprint: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("DELETE FROM page_segments WHERE profile_fingerprint = ?")
      .run(fingerprint);
    database
      .prepare("DELETE FROM semantic_corpora WHERE profile_fingerprint = ?")
      .run(fingerprint);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function splitEmbeddingSegments(text: string): Array<{
  text: string;
  startLineIndex: number;
  endLineIndex: number;
}> {
  if (text.trim().length === 0) {
    return [];
  }
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const units = lines.flatMap((line, lineIndex) => {
    if (line.length <= MAX_EMBEDDING_INPUT_CHARS) {
      return [{ text: line, lineIndex }];
    }
    const result: Array<{ text: string; lineIndex: number }> = [];
    for (
      let offset = 0;
      offset < line.length;
      offset += MAX_EMBEDDING_INPUT_CHARS
    ) {
      result.push({
        text: line.slice(offset, offset + MAX_EMBEDDING_INPUT_CHARS),
        lineIndex,
      });
    }
    return result;
  });
  const segments: Array<{
    text: string;
    startLineIndex: number;
    endLineIndex: number;
  }> = [];
  let current: Array<{ text: string; lineIndex: number }> = [];
  let length = 0;
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    segments.push({
      text: current.map((unit) => unit.text).join("\n"),
      startLineIndex: current[0]!.lineIndex,
      endLineIndex: current.at(-1)!.lineIndex,
    });
    current = [];
    length = 0;
  };
  for (const unit of units) {
    const nextLength =
      length + (current.length === 0 ? 0 : 1) + unit.text.length;
    if (current.length > 0 && nextLength > MAX_EMBEDDING_INPUT_CHARS) {
      flush();
    }
    current.push(unit);
    length += (current.length === 1 ? 0 : 1) + unit.text.length;
    if (length === MAX_EMBEDDING_INPUT_CHARS) {
      flush();
    }
  }
  flush();
  return segments;
}

function semanticEntryKey(
  value: Pick<
    SemanticIndexEntry,
    | "pageId"
    | "contentHash"
    | "segmentIndex"
    | "startLineIndex"
    | "endLineIndex"
  >,
): string {
  return `${value.pageId}\0${value.contentHash}\0${value.segmentIndex}\0${value.startLineIndex}\0${value.endLineIndex}`;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LlmWikiError("BUILD_CANCELLED", "Wiki build was cancelled.");
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
