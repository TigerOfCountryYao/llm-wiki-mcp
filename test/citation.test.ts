import { describe, expect, it } from "vitest";
import { mapCompilerCitation } from "../src/explore.js";
import type { ProxyRecord } from "../src/types.js";

const proxy: ProxyRecord = {
  proxyId: "proxy",
  proxyFile: "proxy.md",
  sourceId: "file:docs/a.md",
  sourceKind: "file",
  sourceHash: "a".repeat(64),
  title: "a.md",
  chunkIndex: 0,
  originalStartLine: 10,
  originalEndLine: 11,
  lineMap: [10, 10, 11],
  engineSourceFile: "a-ingested.md",
  engineBodyStartLine: 6,
  locator: {
    kind: "file",
    path: "docs/a.md",
    lineStart: 10,
    lineEnd: 11,
  },
  bodyHash: "b".repeat(64),
};

describe("compiler citation mapping", () => {
  it("maps compiler source lines through body offset and long-line map", () => {
    expect(mapCompilerCitation(proxy, 6, 7)).toEqual({
      kind: "file",
      path: "docs/a.md",
      lineStart: 10,
      lineEnd: 10,
    });
  });

  it("returns the honest whole-chunk locator when no span exists", () => {
    expect(mapCompilerCitation(proxy, undefined, undefined)).toEqual(proxy.locator);
  });

  it("does not fabricate lines for an invalid compiler span", () => {
    expect(mapCompilerCitation(proxy, 1, 2)).toEqual(proxy.locator);
  });
});
