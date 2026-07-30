import { describe, expect, it } from "vitest";
import { contentDefinedLineChunks } from "../src/proxy.js";

describe("stable source chunking", () => {
  it("never emits a body over 80k, even for a single long line", () => {
    const chunks = contentDefinedLineChunks("x".repeat(200_001));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.body.length <= 80_000)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.lineMap).every((line) => line === 1)).toBe(true);
  });

  it("preserves physical source line numbers", () => {
    const chunks = contentDefinedLineChunks("first\nsecond\nthird");
    expect(chunks).toEqual([
      {
        body: "first\nsecond\nthird",
        startLine: 1,
        endLine: 3,
        lineMap: [1, 2, 3],
      },
    ]);
  });
});
