import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CompiledWikiPageCitation,
  CompiledWikiPageRecord,
  EngineCompiledWikiPage,
  ProxyRecord,
} from "./types.js";

export interface CompiledWikiPage extends CompiledWikiPageRecord {
  body: string;
}

const CLAIM_CITATION_PATTERN = /\^\[([^\]]+)\]/gu;
const SPAN_PATTERN =
  /^(?<file>[^:#]+)(?:(?::(?<start>\d+)(?:-\s*(?<end>\d+))?)|(?:#L(?<hashStart>\d+)(?:-L(?<hashEnd>\d+))?))?$/u;

export async function catalogCompiledWikiPages(
  generationRoot: string,
  proxies: ProxyRecord[],
  authorizedSourceIds?: ReadonlySet<string>,
  enginePages?: EngineCompiledWikiPage[],
  expectedPages?: readonly CompiledWikiPageRecord[],
): Promise<CompiledWikiPage[]> {
  const engineRoot = path.resolve(generationRoot, "engine");
  const wikiRoot = path.join(engineRoot, "wiki");
  const byEngineSource = new Map<string, ProxyRecord>();
  const byProxyFile = new Map<string, ProxyRecord>();
  for (const proxy of proxies) {
    if (
      authorizedSourceIds !== undefined &&
      !authorizedSourceIds.has(proxy.sourceId)
    ) {
      continue;
    }
    byProxyFile.set(normalizeRelative(proxy.proxyFile), proxy);
    if (proxy.engineSourceFile !== undefined) {
      const normalized = normalizeRelative(proxy.engineSourceFile);
      byEngineSource.set(normalized, proxy);
      byEngineSource.set(path.posix.basename(normalized), proxy);
    }
  }

  const candidates =
    enginePages !== undefined
      ? await readDeclaredPages(engineRoot, enginePages)
      : expectedPages !== undefined
        ? await readDeclaredPages(engineRoot, expectedPages)
        : await readFallbackPages(engineRoot, wikiRoot);
  const pages: CompiledWikiPage[] = [];
  for (const candidate of candidates) {
    const parsed = parseCompiledMarkdown(
      candidate.markdown,
      candidate.relativePath,
    );
    const title = candidate.title ?? parsed.title;
    const citations = pageCitations(parsed.body, byEngineSource);
    if (citations.length === 0) {
      const direct = byProxyFile.get(
        path.posix.basename(candidate.relativePath),
      );
      if (direct !== undefined) {
        citations.push({ proxyId: direct.proxyId });
      }
    }
    if (citations.length === 0) {
      continue;
    }
    pages.push({
      pageId: candidate.pageId,
      relativePath: candidate.relativePath,
      title,
      contentHash: createHash("sha256")
        .update(candidate.markdown, "utf8")
        .digest("hex"),
      citations,
      body: parsed.body,
    });
  }
  const expected =
    expectedPages === undefined
      ? null
      : new Map(
          expectedPages.map(
            (page) => [`${page.pageId}\0${page.contentHash}`, page] as const,
          ),
        );
  return pages
    .filter(
      (page) =>
        expected === null ||
        expected.has(`${page.pageId}\0${page.contentHash}`),
    )
    .sort((left, right) => left.pageId.localeCompare(right.pageId));
}

async function readFallbackPages(
  engineRoot: string,
  wikiRoot: string,
): Promise<
  Array<{
    pageId: string;
    relativePath: string;
    title?: string;
    markdown: string;
  }>
> {
  const files = await listMarkdownFiles(wikiRoot);
  const pages = [];
  for (const file of files) {
    const wikiRelativePath = normalizeRelative(path.relative(wikiRoot, file));
    if (wikiRelativePath === "index.md") {
      continue;
    }
    const markdown = await readFile(file, "utf8");
    if (frontmatterFlag(markdown, "archived") || frontmatterFlag(markdown, "orphaned")) {
      continue;
    }
    pages.push({
      pageId: wikiRelativePath.slice(0, -".md".length),
      relativePath: normalizeRelative(path.relative(engineRoot, file)),
      markdown,
    });
  }
  return pages;
}

async function readDeclaredPages(
  wikiRoot: string,
  records: ReadonlyArray<{
    pageId: string;
    relativePath: string;
    title: string;
  }>,
): Promise<
  Array<{
    pageId: string;
    relativePath: string;
    title: string;
    markdown: string;
  }>
> {
  const pages = [];
  for (const record of records) {
    const relativePath = normalizeRelative(record.relativePath);
    if (
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((part) => part === "..")
    ) {
      continue;
    }
    const target = path.resolve(wikiRoot, ...relativePath.split("/"));
    const relative = path.relative(wikiRoot, target);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    try {
      const stats = await lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }
      const markdown = await readFile(target, "utf8");
      if (
        frontmatterFlag(markdown, "archived") ||
        frontmatterFlag(markdown, "orphaned")
      ) {
        continue;
      }
      pages.push({
        pageId: record.pageId,
        relativePath,
        title: record.title,
        markdown,
      });
    } catch {
      continue;
    }
  }
  return pages;
}

function pageCitations(
  body: string,
  proxies: ReadonlyMap<string, ProxyRecord>,
): CompiledWikiPageCitation[] {
  const citations: CompiledWikiPageCitation[] = [];
  const seen = new Set<string>();
  for (const marker of body.matchAll(CLAIM_CITATION_PATTERN)) {
    const pageLineIndex = body.slice(0, marker.index).split("\n").length - 1;
    for (const rawEntry of splitCitationEntries(marker[1] ?? "")) {
      const parsed = parseCitationEntry(rawEntry);
      if (parsed === null) {
        continue;
      }
      const normalized = normalizeRelative(parsed.file);
      const proxy =
        proxies.get(normalized) ?? proxies.get(path.posix.basename(normalized));
      if (proxy === undefined) {
        continue;
      }
      const citation: CompiledWikiPageCitation = {
        proxyId: proxy.proxyId,
        pageLineIndex,
        ...(parsed.start === undefined
          ? {}
          : {
              engineStartLine: parsed.start,
              engineEndLine: parsed.end ?? parsed.start,
            }),
      };
      const key = `${citation.proxyId}\0${citation.engineStartLine ?? ""}\0${
        citation.engineEndLine ?? ""
      }\0${citation.pageLineIndex ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        citations.push(citation);
      }
    }
  }
  return citations;
}

function splitCitationEntries(value: string): string[] {
  return value
    .split(/,(?!\s*\d+(?:-\d+)?\s*(?:,|$))/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseCitationEntry(
  value: string,
): { file: string; start?: number; end?: number } | null {
  const match = SPAN_PATTERN.exec(value.trim());
  if (match?.groups === undefined) {
    return null;
  }
  const startValue = match.groups["start"] ?? match.groups["hashStart"];
  const endValue = match.groups["end"] ?? match.groups["hashEnd"];
  if (startValue === undefined) {
    return { file: match.groups["file"]! };
  }
  const start = Number(startValue);
  const end = Number(endValue ?? startValue);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return null;
  }
  return { file: match.groups["file"]!, start, end };
}

function parseCompiledMarkdown(
  markdown: string,
  relativePath: string,
): { title: string; body: string } {
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalized);
  const body = frontmatter?.[2] ?? normalized;
  const metadata = frontmatter?.[1] ?? "";
  const titleValue = /^title:\s*(.+)$/mu.exec(metadata)?.[1]?.trim();
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
  return {
    title:
      unquoteYamlScalar(titleValue) ??
      heading ??
      path.posix.basename(relativePath, ".md"),
    body,
  };
}

function unquoteYamlScalar(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function frontmatterFlag(markdown: string, name: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1];
  return (
    frontmatter !== undefined &&
    new RegExp(`^${name}:\\s*true\\s*$`, "imu").test(frontmatter)
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        entry.isFile() &&
        path.extname(entry.name).toLocaleLowerCase("en-US") === ".md"
      ) {
        files.push(target);
      }
    }
  };
  await visit(root);
  return files;
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}
