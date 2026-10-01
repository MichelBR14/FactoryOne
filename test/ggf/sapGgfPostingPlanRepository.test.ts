import { describe, expect, it } from "vitest";
import { ServiceLayerError } from "../../webapp/core/service/errors";
import type { SlReadWrite } from "../../webapp/core/data/SetupRepository";
import { SapGgfPostingPlanRepository } from "../../webapp/modules/ggf/repository/SapGgfPostingPlanRepository";
import { buildAccountingPreview } from "../../webapp/modules/ggf/service/AccountingPreview";
import { buildGgfPostingPlanDraft } from "../../webapp/modules/ggf/service/GgfPostingPlan";

function draft(ggf = "916600") {
  const preview = buildAccountingPreview({ MOD: "0", GGF: ggf }, [], {
    transitoryGgfAccount: "T-GGF", transitoryModAccount: "T-MOD", closingGgfAccount: "C-GGF",
    closingModAccount: "C-MOD", cpvAccount: "CPV", inventoryAccounts: {},
    cpvEligibleOperationKeys: [], requireDimensions: false
  });
  return buildGgfPostingPlanDraft(preview, { closingId: "TECH-SBODEMOBR2-202609", companyDB: "SBODEMOBR2",
    periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "", dimensions: [], currency: "BRL",
    currencySource: "company test", sourceCapturedAt: "2026-09-30T20:00:00Z" });
}

class MemorySap implements SlReadWrite {
  rows = new Map<string, Record<string, unknown>>();
  failPost: ServiceLayerError | null = null;
  async get<T>(path: string): Promise<T | undefined> {
    let result: unknown;
    if (path.includes("/$count")) result = this.rows.size;
    else if (path.includes("$filter=")) result = { value: [...this.rows.values()] };
    else {
      const match = /FBO_GGF_PPLAN\('([^']+)'\)/.exec(path);
      result = match ? this.rows.get(match[1]!) : undefined;
      if (!result) throw new ServiceLayerError("Not found", 404);
    }
    return result as T;
  }
  async post<T>(path: string, body: unknown): Promise<T | undefined> {
    if (this.failPost) throw this.failPost;
    const row = body as Record<string, unknown>;
    if (this.rows.has(String(row.Code))) throw new ServiceLayerError("Duplicate key", 400, -2035);
    this.rows.set(String(row.Code), row);
    return undefined;
  }
  async patch<T>(): Promise<T | undefined> { throw new Error("PATCH forbidden"); }
}

describe("SAP GGF posting plan repository", () => {
  it("persists, rereads, verifies and versions an append-only blocked plan", async () => {
    const sap = new MemorySap();
    const repo = new SapGgfPostingPlanRepository(sap, () => "2026-09-30T20:00:00.000Z");
    const first = await repo.append(draft());
    const second = await repo.append(draft("916601"));
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(first.status).toBe("BLOCKED");
    expect(second.postingHash).not.toBe(first.postingHash);
    expect(first.documents.every(document => document.payload === null)).toBe(true);
    expect((await repo.list(first.closingId)).map(plan => plan.postingHash)).toEqual([first.postingHash, second.postingHash]);
  });

  it("does not turn ordinary SAP validation errors into version conflicts", async () => {
    const sap = new MemorySap();
    sap.failPost = new ServiceLayerError("Invalid field", 400, -5002);
    await expect(new SapGgfPostingPlanRepository(sap).append(draft())).rejects.toMatchObject({ status: 400, code: -5002 });
  });

  it("keeps an ambiguous write fail-closed without retrying POST", async () => {
    const sap = new MemorySap();
    sap.failPost = new ServiceLayerError("Timeout", 0);
    await expect(new SapGgfPostingPlanRepository(sap).append(draft())).rejects.toMatchObject({ code: "POSTING_PLAN_WRITE_UNCERTAIN" });
  });
});
