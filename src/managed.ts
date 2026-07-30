import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LlmWikiError } from "./errors.js";
import {
  ensurePrivateDirectory,
  pathExists,
  readJsonFile,
  stableJson,
  writeJsonAtomic,
} from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import { STATE_SCHEMA_VERSION, type ManagedKnowledge } from "./types.js";

const upsertSchema = z
  .object({
    id: z.string().min(1).max(512),
    title: z.string().min(1).max(1_000),
    text: z.string().max(10_000_000),
    provenance: z
      .object({
        eventId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const deleteSchema = z.object({ id: z.string().min(1).max(512) }).strict();

const storedSchema = upsertSchema.extend({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  updatedAt: z.iso.datetime(),
});

export type UpsertKnowledgeInput = z.infer<typeof upsertSchema>;
export type DeleteKnowledgeInput = z.infer<typeof deleteSchema>;

export function parseUpsertKnowledge(value: unknown): UpsertKnowledgeInput {
  const result = upsertSchema.safeParse(value);
  if (!result.success) {
    throw new LlmWikiError("INVALID_KNOWLEDGE_INPUT", "Invalid structured knowledge input.", result.error.issues);
  }
  return result.data;
}

export function parseDeleteKnowledge(value: unknown): DeleteKnowledgeInput {
  const result = deleteSchema.safeParse(value);
  if (!result.success) {
    throw new LlmWikiError("INVALID_KNOWLEDGE_INPUT", "Invalid structured knowledge delete input.", result.error.issues);
  }
  return result.data;
}

export async function upsertKnowledge(
  root: string,
  input: UpsertKnowledgeInput,
): Promise<{
  id: string;
  changed: boolean;
  status: "stale" | "unchanged";
}> {
  const directory = projectPaths(root).managed;
  await ensurePrivateDirectory(directory);
  const target = managedPath(root, input.id);
  const contentHash = hashKnowledge(input);
  if (await pathExists(target)) {
    const previous = await readStored(target);
    if (previous.contentHash === contentHash) {
      return { id: input.id, changed: false, status: "unchanged" };
    }
  }

  const record: ManagedKnowledge = {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    text: input.text,
    ...(input.provenance === undefined ? {} : { provenance: cleanProvenance(input.provenance) }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    contentHash,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(target, record);
  return { id: input.id, changed: true, status: "stale" };
}

export async function deleteKnowledge(
  root: string,
  input: DeleteKnowledgeInput,
): Promise<{ id: string; deleted: boolean; status: "stale" }> {
  const target = managedPath(root, input.id);
  const deleted = await pathExists(target);
  if (deleted) {
    await rm(target, { force: true });
  }
  return { id: input.id, deleted, status: "stale" };
}

export async function listManagedKnowledge(root: string): Promise<ManagedKnowledge[]> {
  const directory = projectPaths(root).managed;
  if (!(await pathExists(directory))) {
    return [];
  }
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const records = await Promise.all(names.map((name) => readStored(path.join(directory, name))));
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function managedPath(root: string, id: string): string {
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  return path.join(projectPaths(root).managed, `${digest}.json`);
}

function hashKnowledge(input: UpsertKnowledgeInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        id: input.id,
        title: input.title,
        text: input.text,
        provenance:
          input.provenance === undefined
            ? null
            : cleanProvenance(input.provenance),
        metadata: input.metadata ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

async function readStored(target: string): Promise<ManagedKnowledge> {
  const result = storedSchema.safeParse(await readJsonFile<unknown>(target));
  if (!result.success) {
    throw new LlmWikiError("INVALID_MANAGED_KNOWLEDGE", `Invalid managed knowledge record: ${target}`);
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: result.data.id,
    title: result.data.title,
    text: result.data.text,
    ...(result.data.provenance === undefined
      ? {}
      : { provenance: cleanProvenance(result.data.provenance) }),
    ...(result.data.metadata === undefined ? {} : { metadata: result.data.metadata }),
    contentHash: result.data.contentHash,
    updatedAt: result.data.updatedAt,
  };
}

function cleanProvenance(value: {
  eventId?: string | undefined;
  messageId?: string | undefined;
  conversationId?: string | undefined;
}): NonNullable<ManagedKnowledge["provenance"]> {
  return {
    ...(value.eventId === undefined ? {} : { eventId: value.eventId }),
    ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
  };
}
