import { z } from "zod";
import { readJsonIfExists, writeJsonAtomic } from "./fs-utils.js";
import { projectPaths } from "./paths.js";
import {
  STATE_SCHEMA_VERSION,
  type CurrentPointer,
  type RuntimeStatus,
} from "./types.js";

const currentSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    generation: z.string().regex(/^\d{8}-[a-f0-9]{12}$/u),
    builtAt: z.iso.datetime(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const statusSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    state: z.enum([
      "uninitialized",
      "ready",
      "stale",
      "building",
      "error",
      "provider-unavailable",
    ]),
    updatedAt: z.iso.datetime(),
    reasonCode: z.string().optional(),
    message: z.string().optional(),
    currentGeneration: z.string().regex(/^\d{8}-[a-f0-9]{12}$/u).optional(),
    buildStartedAt: z.iso.datetime().optional(),
  })
  .strict();

export async function readCurrent(root: string): Promise<CurrentPointer | null> {
  const raw = await readJsonIfExists<unknown>(projectPaths(root).current);
  if (raw === null) {
    return null;
  }
  return currentSchema.parse(raw);
}

export async function writeCurrent(root: string, value: CurrentPointer): Promise<void> {
  await writeJsonAtomic(projectPaths(root).current, currentSchema.parse(value));
}

export async function readStoredStatus(root: string): Promise<RuntimeStatus | null> {
  const raw = await readJsonIfExists<unknown>(projectPaths(root).status);
  if (raw === null) {
    return null;
  }
  const parsed = statusSchema.parse(raw);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    state: parsed.state,
    updatedAt: parsed.updatedAt,
    ...(parsed.reasonCode === undefined ? {} : { reasonCode: parsed.reasonCode }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
    ...(parsed.currentGeneration === undefined
      ? {}
      : { currentGeneration: parsed.currentGeneration }),
    ...(parsed.buildStartedAt === undefined ? {} : { buildStartedAt: parsed.buildStartedAt }),
  };
}

export async function writeStatus(root: string, value: RuntimeStatus): Promise<void> {
  await writeJsonAtomic(projectPaths(root).status, statusSchema.parse(value));
}

export async function markStale(
  root: string,
  reasonCode: string,
  message: string,
): Promise<void> {
  const current = await readCurrent(root);
  await writeStatus(root, {
    schemaVersion: STATE_SCHEMA_VERSION,
    state: "stale",
    updatedAt: new Date().toISOString(),
    reasonCode,
    message,
    ...(current === null ? {} : { currentGeneration: current.generation }),
  });
}
