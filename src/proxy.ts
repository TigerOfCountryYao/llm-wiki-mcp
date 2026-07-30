import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory } from "./fs-utils.js";
import type {
  EnumeratedSource,
  ProxyRecord,
  SourceLocator,
  UnsupportedSource,
} from "./types.js";

const MIN_CHUNK_CHARS = 32_000;
const MAX_CHUNK_CHARS = 80_000;

export interface PreparedProxies {
  proxies: ProxyRecord[];
  unsupported: UnsupportedSource[];
}

interface TextChunk {
  body: string;
  startLine: number;
  endLine: number;
  lineMap: number[];
}

export async function prepareSourceProxies(
  generationRoot: string,
  sources: EnumeratedSource[],
): Promise<PreparedProxies> {
  const sourceDirectory = path.join(generationRoot, "proxy-inputs");
  await ensurePrivateDirectory(sourceDirectory);
  const proxies: ProxyRecord[] = [];
  const unsupported: UnsupportedSource[] = [];

  for (const source of sources) {
    const extracted = await extractSourceText(source);
    if (extracted.ok === false) {
      unsupported.push({
        sourceId: source.sourceId,
        kind: "unsupported",
        relativePath: source.relativePath ?? source.title,
        contentHash: source.contentHash,
        size: source.size,
        reason: extracted.reason,
        ...(extracted.mediaType === undefined ? {} : { mediaType: extracted.mediaType }),
      });
      continue;
    }

    const chunks = contentDefinedLineChunks(extracted.text);
    const occurrences = new Map<string, number>();
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const bodyHash = createHash("sha256").update(chunk.body, "utf8").digest("hex");
      const baseId = createHash("sha256")
        .update(`${source.sourceId}\0${bodyHash}`, "utf8")
        .digest("hex")
        .slice(0, 24);
      const occurrence = occurrences.get(baseId) ?? 0;
      occurrences.set(baseId, occurrence + 1);
      const proxyId = occurrence === 0 ? baseId : `${baseId}-${occurrence + 1}`;
      const proxyFile = `${proxyId}.md`;
      const locator = locatorForChunk(source, chunk);
      await writeFile(path.join(sourceDirectory, proxyFile), chunk.body, {
        encoding: "utf8",
        mode: 0o600,
      });
      proxies.push({
        proxyId,
        proxyFile,
        sourceId: source.sourceId,
        sourceKind: source.kind,
        sourceHash: source.contentHash,
        title: source.title,
        chunkIndex,
        ...(source.kind === "file"
          ? {
              originalStartLine: chunk.startLine,
              originalEndLine: chunk.endLine,
              lineMap: chunk.lineMap,
            }
          : {}),
        locator,
        bodyHash,
      });
    }
  }

  return { proxies, unsupported };
}

export function contentDefinedLineChunks(text: string): TextChunk[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const physicalLines = normalized.split("\n");
  const units = physicalLines.flatMap((line, index) => {
    if (line.length <= MAX_CHUNK_CHARS) {
      return [{ text: line, line: index + 1 }];
    }
    const pieces: Array<{ text: string; line: number }> = [];
    for (let offset = 0; offset < line.length; offset += MAX_CHUNK_CHARS) {
      pieces.push({
        text: line.slice(offset, offset + MAX_CHUNK_CHARS),
        line: index + 1,
      });
    }
    return pieces;
  });
  const chunks: TextChunk[] = [];
  let startIndex = 0;
  let currentLength = 0;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const separatorLength = currentLength === 0 ? 0 : 1;
    if (currentLength > 0 && currentLength + separatorLength + unit.text.length > MAX_CHUNK_CHARS) {
      const chunkUnits = units.slice(startIndex, index);
      chunks.push({
        body: chunkUnits.map((item) => item.text).join("\n"),
        startLine: chunkUnits[0]!.line,
        endLine: chunkUnits.at(-1)!.line,
        lineMap: chunkUnits.map((item) => item.line),
      });
      startIndex = index;
      currentLength = 0;
    }
    currentLength += (currentLength === 0 ? 0 : 1) + unit.text.length;
    const contentBoundary =
      currentLength >= MIN_CHUNK_CHARS &&
      createHash("sha256").update(unit.text, "utf8").digest()[0]! < 2;
    const hardBoundary = currentLength === MAX_CHUNK_CHARS;
    if ((contentBoundary || hardBoundary) && index < units.length - 1) {
      const chunkUnits = units.slice(startIndex, index + 1);
      chunks.push({
        body: chunkUnits.map((item) => item.text).join("\n"),
        startLine: chunkUnits[0]!.line,
        endLine: chunkUnits.at(-1)!.line,
        lineMap: chunkUnits.map((item) => item.line),
      });
      startIndex = index + 1;
      currentLength = 0;
    }
  }

  const finalUnits = units.slice(startIndex);
  chunks.push({
    body: finalUnits.map((item) => item.text).join("\n"),
    startLine: finalUnits[0]?.line ?? 1,
    endLine: finalUnits.at(-1)?.line ?? 1,
    lineMap: finalUnits.map((item) => item.line),
  });
  return chunks;
}

async function extractSourceText(
  source: EnumeratedSource,
): Promise<
  | { ok: true; text: string }
  | { ok: false; reason: string; mediaType?: string }
> {
  if (source.kind === "knowledge") {
    return { ok: true, text: source.knowledge?.text ?? "" };
  }
  if (source.absolutePath === undefined) {
    return { ok: false, reason: "missing-file-path" };
  }
  const bytes = await readFile(source.absolutePath);
  if (bytes.includes(0)) {
    const mediaType = mediaTypeForPath(source.relativePath ?? source.title);
    return {
      ok: false,
      reason: "binary-source-parser-unavailable",
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    const mediaType = mediaTypeForPath(source.relativePath ?? source.title);
    return {
      ok: false,
      reason: "non-utf8-source-parser-unavailable",
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  }
}

function locatorForChunk(source: EnumeratedSource, chunk: TextChunk): SourceLocator {
  if (source.kind === "knowledge") {
    const provenance = source.knowledge?.provenance;
    return {
      kind: "knowledge",
      knowledgeId: source.knowledge?.id ?? source.sourceId.slice("knowledge:".length),
      ...(provenance?.eventId === undefined ? {} : { eventId: provenance.eventId }),
      ...(provenance?.messageId === undefined ? {} : { messageId: provenance.messageId }),
      ...(provenance?.conversationId === undefined
        ? {}
        : { conversationId: provenance.conversationId }),
    };
  }
  return {
    kind: "file",
    path: source.relativePath ?? source.title,
    lineStart: chunk.startLine,
    lineEnd: chunk.endLine,
  };
}

function mediaTypeForPath(value: string): string | undefined {
  const extension = path.extname(value).toLocaleLowerCase("en-US");
  return (
    {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    } as Record<string, string>
  )[extension];
}
