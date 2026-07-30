import { rm } from "node:fs/promises";
import {
  defaultProjectConfig,
  readProjectConfig,
  writeConsent,
  writeProjectConfig,
} from "./config.js";
import { LlmWikiError } from "./errors.js";
import { ensurePrivateDirectory, pathExists } from "./fs-utils.js";
import { installLocalExclude, uninstallLocalExclude } from "./git.js";
import { projectPaths } from "./paths.js";
import {
  catalogProject,
  validateSelectedPathsFromCatalog,
} from "./scope.js";
import { writeStatus } from "./state.js";
import {
  STATE_SCHEMA_VERSION,
  type ProjectConfig,
  type SourceScopeMode,
} from "./types.js";

export async function initializeProject(
  root: string,
  requestedSelections?: string[],
): Promise<{
  root: string;
  selectedPaths: string[];
  scopeMode: SourceScopeMode;
  gitExclude: {
    changed: boolean;
    path: string | null;
    warning?: string;
  };
}> {
  const catalog = await catalogProject(root);
  const rawSelections =
    requestedSelections === undefined
      ? catalog.entries.filter((entry) => entry.selected).map((entry) => entry.path)
      : requestedSelections;
  const selectedPaths = validateSelectedPathsFromCatalog(catalog, rawSelections);
  if (selectedPaths.length === 0) {
    throw new LlmWikiError(
      "EMPTY_SOURCE_SCOPE",
      "No eligible first-level sources were selected. Select at least one source.",
    );
  }

  const paths = projectPaths(root);
  await Promise.all([
    ensurePrivateDirectory(paths.localRoot),
    ensurePrivateDirectory(paths.managed),
    ensurePrivateDirectory(paths.locks),
    ensurePrivateDirectory(paths.builds),
    ensurePrivateDirectory(paths.generations),
  ]);

  let config: ProjectConfig;
  if (await pathExists(paths.projectConfig)) {
    config = { ...(await readProjectConfig(root)), sources: selectedPaths };
  } else {
    config = defaultProjectConfig(selectedPaths);
  }
  await writeProjectConfig(root, config);
  await writeConsent(root, {
    schemaVersion: STATE_SCHEMA_VERSION,
    selectedPaths,
    scopeMode: catalog.scopeMode,
    confirmedAt: new Date().toISOString(),
  });
  await writeStatus(root, {
    schemaVersion: STATE_SCHEMA_VERSION,
    state: "stale",
    updatedAt: new Date().toISOString(),
    reasonCode: "INITIAL_BUILD_REQUIRED",
    message: "Source scope is confirmed; build the first generation.",
  });

  const gitExclude = await installLocalExclude(root);
  return { root, selectedPaths, scopeMode: catalog.scopeMode, gitExclude };
}

export async function uninitializeProject(root: string): Promise<{
  root: string;
  removedLocalState: boolean;
  retainedProjectConfig: boolean;
  gitExclude: {
    changed: boolean;
    path: string | null;
    warning?: string;
  };
}> {
  const paths = projectPaths(root);
  const removedLocalState = await pathExists(paths.localRoot);
  if (removedLocalState) {
    await rm(paths.localRoot, { recursive: true, force: true });
  }
  const gitExclude = await uninstallLocalExclude(root);
  return {
    root,
    removedLocalState,
    retainedProjectConfig: await pathExists(paths.projectConfig),
    gitExclude,
  };
}
