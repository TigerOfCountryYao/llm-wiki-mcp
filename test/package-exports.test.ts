import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package exports", () => {
  it("allows AutoCut to resolve the package manifest", () => {
    const require = createRequire(import.meta.url);
    expect(
      path.normalize(
        require.resolve("@autocut-cli/llm-wiki/package.json"),
      ),
    ).toBe(path.normalize(path.join(process.cwd(), "package.json")));
  });
});
