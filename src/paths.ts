import path from "node:path";

export interface ProjectPaths {
  root: string;
  projectConfig: string;
  localRoot: string;
  consent: string;
  current: string;
  status: string;
  managed: string;
  locks: string;
  buildLock: string;
  watcherLock: string;
  builds: string;
  generations: string;
}

export function projectPaths(root: string): ProjectPaths {
  const localRoot = path.join(root, ".llm-wiki");
  return {
    root,
    projectConfig: path.join(root, "llm-wiki.json"),
    localRoot,
    consent: path.join(localRoot, "consent.json"),
    current: path.join(localRoot, "current.json"),
    status: path.join(localRoot, "status.json"),
    managed: path.join(localRoot, "managed"),
    locks: path.join(localRoot, "locks"),
    buildLock: path.join(localRoot, "locks", "build.lock"),
    watcherLock: path.join(localRoot, "locks", "watcher.lock"),
    builds: path.join(localRoot, "builds"),
    generations: path.join(localRoot, "generations"),
  };
}
