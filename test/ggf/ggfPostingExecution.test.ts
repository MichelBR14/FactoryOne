import { describe, expect, it } from "vitest";
import { calculateGgfRequestHash, canonicalizeCheckpointRequest, sameCanonicalCheckpointRequest } from
  "../../webapp/modules/ggf/service/GgfPostingExecution";

describe("posting checkpoint request canonicalization", () => {
  it("normalizes only null and plain empty objects to the same empty request", () => {
    expect(canonicalizeCheckpointRequest(null)).toEqual({});
    expect(canonicalizeCheckpointRequest({})).toEqual({});
    expect(sameCanonicalCheckpointRequest(null, {})).toBe(true);
    expect(sameCanonicalCheckpointRequest(JSON.parse("{}"), null)).toBe(true);
    expect(() => sameCanonicalCheckpointRequest(undefined, {})).toThrow("plain JSON object");
  });

  it("keeps non-empty payloads strict and does not weaken RequestHash", async () => {
    expect(sameCanonicalCheckpointRequest(null, { DocEntry: 12 })).toBe(false);
    expect(sameCanonicalCheckpointRequest({}, { DocEntry: 12 })).toBe(false);
    expect(sameCanonicalCheckpointRequest({ DocEntry: 12 }, { DocEntry: 13 })).toBe(false);
    expect(await calculateGgfRequestHash({})).not.toBe(await calculateGgfRequestHash({ DocEntry: 12 }));
    expect(await calculateGgfRequestHash({ DocEntry: 12 })).not.toBe(await calculateGgfRequestHash({ DocEntry: 13 }));
    expect(() => canonicalizeCheckpointRequest([])).toThrow("plain JSON object");
    expect(() => canonicalizeCheckpointRequest("{}")).toThrow("plain JSON object");
  });
});
