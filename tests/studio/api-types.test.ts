// S16.0: the vendored Studio 0.51.0 OpenAPI file is the unmodified release asset, and src/studio/api-types.ts is exactly what it generates.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate, OUT, SPEC } from "../../scripts/gen-studio-api-types.mjs";

const root = new URL("../../", import.meta.url);

describe("Studio 0.51.0 (contract 5.2.0) fixture and generated types", () => {
  it("is the unmodified release asset (its SHA256SUMS line)", () => {
    const text = readFileSync(new URL("tests/fixtures/studio-openapi-0.51.0.json", root));
    expect(createHash("sha256").update(text).digest("hex")).toBe("271fdc1bdac2ea59c1988b1c244d08758c6bf030c5f332531000d2d959202c88");
  });

  it("declares contract 5.2.0", () => {
    const spec = JSON.parse(readFileSync(new URL(SPEC, root), "utf8")) as { info: { version: string } };
    expect(spec.info.version).toBe("5.2.0");
  });

  it("src/studio/api-types.ts is what the fixture generates (run `npm run gen:studio-types` after changing the fixture)", async () => {
    const want = await generate();
    expect(readFileSync(new URL(OUT, root), "utf8") === want).toBe(true);
  });
});
