import { describe, expect, it } from "vitest";
import { transitionClosing, type GgfClosing } from "../../webapp/modules/ggf/service/GgfClosing";

describe("closing state after successful reconciliation of an uncertain document", () => {
  it("allows POSTING_UNCERTAIN to become POSTING_PARTIAL", () => {
    const closing = { closingId: "TECH7E_TEST", status: "POSTING_UNCERTAIN", version: 7 } as GgfClosing;
    expect(transitionClosing(closing, "POSTING_PARTIAL")).toMatchObject({
      status: "POSTING_PARTIAL", version: 8
    });
  });
});
