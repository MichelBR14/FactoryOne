import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

describe("independent real allocation validation", () => {
  it("passes offline Python checks with invented source rows and injected discrepancies", () => {
    const result = spawnSync(
      "python3",
      [
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        "test/ggf",
        "-p",
        "test_independent_rateio.py",
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 16 tests");
  });
  it("keeps the verifier independent and the live runner read-only", () => {
    const verifier = readFileSync("scripts/ggf-independent-check.py", "utf8");
    expect(verifier).not.toMatch(
      /from (webapp|requests|urllib\.request)|import (requests|http|socket)/,
    );
    const runner = readFileSync("scripts/ggf-real-validation.mjs", "utf8");
    expect(runner).toContain("connection.get(path");
    expect(runner).not.toMatch(
      /\.confirm\(|\.(post|put|patch|delete)\(|fetch\(/,
    );
    expect(runner).toContain("functionalGgfApproved: false");
    expect(runner).toContain("Replay query sequence differs");
  });
});
