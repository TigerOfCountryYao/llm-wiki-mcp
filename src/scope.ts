import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readConsentIfExists, readProjectConfig } from "./config.js";
import { LlmWikiError } from "./errors.js";
import {
  hasDotSegment,
  isNodeError,
  normalizeRelativePath,
  pathExists,
  resolveRealPathWithin,
  stableJson,
} from "./fs-utils.js";
import { gitEligibleFiles } from "./git.js";
import { listManagedKnowledge } from "./managed.js";
import { projectPaths } from "./paths.js";
import type {
  CatalogEntry,
  CatalogResult,
  ConsentFile,
  EnumeratedSource,
  ManagedKnowledge,
} from "./types.js";

export async function catalogProject(root: string): Promise<CatalogResult> {
  const consent = await readConsentIfExists(root);
  const config = (await pathExists(projectPaths(root).projectConfig))
    ? await readProjectConfig(root)
    : null;
  const configuredPaths = new Set((config?.sources ?? []).map(canonicalPath));
  const suggested =
    consent === null
      ? new Set(config?.sources ?? [])
      : new Set(
          consent.selectedPaths.filter((item) => configuredPaths.has(canonicalPath(item))),
        );
  const gitFiles = await gitEligibleFiles(root);
  const candidates =
    gitFiles === null
      ? await nonGitCatalog(root)
      : await gitCatalog(root, gitFiles.filter((item) => !hasDotSegment(item)));

  const defaultAll = consent === null && config === null;
  const entries = candidates
    .map((entry) => ({
      ...entry,
      selected: defaultAll || suggested.has(entry.path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    initialized: consent !== null,
    entries,
  };
}

export async function validateSelectedPaths(root: string, selected: string[]): Promise<string[]> {
  const catalog = await catalogProject(root);
  const byCanonical = new Map(
    catalog.entries.map((entry) => [canonicalPath(entry.path), entry.path] as const),
  );
  const normalized = [...new Set(selected.map(normalizeRelativePath))];
  const resolved = normalized.map((item) => {
    if (item.includes("/")) {
      throw new LlmWikiError(
        "SOURCE_NOT_FIRST_LEVEL",
        `Source selections must be first-level entries: ${item}`,
      );
    }
    const match = byCanonical.get(canonicalPath(item));
    if (match === undefined) {
      throw new LlmWikiError("SOURCE_NOT_ELIGIBLE", `Source is not eligible: ${item}`);
    }
    return match;
  });
  return resolved.sort((left, right) => left.localeCompare(right));
}

export async function enumerateAuthorizedSources(
  root: string,
  consent: ConsentFile,
): Promise<{ sources: EnumeratedSource[]; sourceDigest: string }> {
  const config = await readProjectConfig(root);
  const consented = new Set(consent.selectedPaths.map(canonicalPath));
  const effectivePaths = config.sources.filter((item) => consented.has(canonicalPath(item)));
  const selected = new Set(
    effectivePaths.map(canonicalPath),
  );
  const gitFiles = await gitEligibleFiles(root);
  const relativeFiles =
    gitFiles === null
      ? await enumerateNonGitSelected(root, effectivePaths)
      : gitFiles.filter((item) => isAuthorizedFile(item, selected));

  const uniqueFiles = [...new Set(relativeFiles.map((item) => item.replaceAll("\\", "/")))]
    .filter((item) => !hasDotSegment(item))
    .sort((left, right) => left.localeCompare(right));

  const fileSources: EnumeratedSource[] = [];
  for (const relativePath of uniqueFiles) {
    const absolutePath = path.resolve(root, relativePath);
    const linkInfo = await lstat(absolutePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (linkInfo === null) {
      continue;
    }
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      continue;
    }
    const confinedPath = await resolveRealPathWithin(root, absolutePath).catch(
      (error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      },
    );
    if (confinedPath === null) {
      continue;
    }
    const bytes = await readFile(confinedPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (bytes === null) {
      continue;
    }
    fileSources.push({
      sourceId: `file:${relativePath}`,
      kind: "file",
      title: path.basename(relativePath),
      relativePath,
      absolutePath: confinedPath,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }

  const managed = await listManagedKnowledge(root);
  const managedSources = managed.map(managedToSource);
  const sources = [...fileSources, ...managedSources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const sourceDigest = createHash("sha256")
    .update(
      stableJson(
        sources.map((source) => ({
          sourceId: source.sourceId,
          contentHash: source.contentHash,
          size: source.size,
        })),
      ),
      "utf8",
    )
    .digest("hex");
  return { sources, sourceDigest };
}

async function gitCatalog(root: string, files: string[]): Promise<Array<Omit<CatalogEntry, "selected">>> {
  const firstSegments = [...new Set(files.map((item) => item.split("/")[0]).filter(isDefined))];
  const entries: Array<Omit<CatalogEntry, "selected">> = [];
  for (const firstSegment of firstSegments) {
    if (firstSegment.startsWith(".")) {
      continue;
    }
    const target = path.join(root, firstSegment);
    const info = await lstat(target).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (info === null || info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile()) {
      entries.push({ path: firstSegment, kind: "file", eligible: true });
    } else if (info.isDirectory()) {
      entries.push({ path: firstSegment, kind: "directory", eligible: true });
    }
  }
  return entries;
}

async function nonGitCatalog(root: string): Promise<Array<Omit<CatalogEntry, "selected">>> {
  const entries: Array<Omit<CatalogEntry, "selected">> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile()) {
      entries.push({ path: entry.name, kind: "file", eligible: true });
      continue;
    }
    if (entry.isDirectory() && (await hasEligibleDescendant(path.join(root, entry.name)))) {
      entries.push({ path: entry.name, kind: "directory", eligible: true });
    }
  }
  return entries;
}

async function hasEligibleDescendant(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile()) {
      return true;
    }
    if (entry.isDirectory() && (await hasEligibleDescendant(path.join(directory, entry.name)))) {
      return true;
    }
  }
  return false;
}

async function enumerateNonGitSelected(root: string, selectedPaths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const selectedPath of selectedPaths) {
    const relativePath = normalizeRelativePath(selectedPath);
    const target = path.resolve(root, relativePath);
    if (!(await pathExists(target))) {
      continue;
    }
    const info = await lstat(target).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (info === null) {
      continue;
    }
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile()) {
      result.push(relativePath);
    } else if (info.isDirectory()) {
      await walkNonGit(root, target, result);
    }
  }
  return result;
}

async function walkNonGit(root: string, directory: string, result: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkNonGit(root, absolute, result);
    } else if (entry.isFile()) {
      result.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
}

function isAuthorizedFile(relativePath: string, selected: Set<string>): boolean {
  if (hasDotSegment(relativePath)) {
    return false;
  }
  const first = relativePath.replaceAll("\\", "/").split("/")[0];
  return first !== undefined && selected.has(canonicalPath(first));
}

function canonicalPath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function managedToSource(knowledge: ManagedKnowledge): EnumeratedSource {
  return {
    sourceId: `knowledge:${knowledge.id}`,
    kind: "knowledge",
    title: knowledge.title,
    knowledge,
    contentHash: knowledge.contentHash,
    size: Buffer.byteLength(knowledge.text, "utf8"),
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
