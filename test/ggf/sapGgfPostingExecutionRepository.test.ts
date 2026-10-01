import { describe, expect, it } from "vitest";
import { ServiceLayerError } from "../../webapp/core/service/errors";
import type { SlReadWrite } from "../../webapp/core/data/SetupRepository";
import { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "../../webapp/modules/ggf/repository/SapGgfPostingExecutionRepository";
import { calculateGgfExecutionId, calculateGgfRequestHash, executionTotals,
  type GgfPostingDocumentLedger, type GgfPostingExecutionIdentity, type GgfPostingExecutionRecord } from "../../webapp/modules/ggf/service/GgfPostingExecution";

const identity: GgfPostingExecutionIdentity = { closingId: "TECH_LEDGER_7B", closingVersion: 4,
  postingPlanVersion: 2, postingHash: "a".repeat(64) };

class MemorySap implements SlReadWrite {
  rows = new Map<string, Record<string, unknown>>();
  failOnceOn: string | null = null;
  async get<T>(path: string): Promise<T | undefined> {
    let result: unknown;
    const entity = path.startsWith("FBO_GGF_PEXEC") ? "FBO_GGF_PEXEC" :
      path.startsWith("FBO_GGF_PDOC") ? "FBO_GGF_PDOC" : "FBO_GGF_CLAIM";
    if (path.includes("/$count")) {
      const match = /U_ExecutionId eq '([^']+)'/.exec(decodeURIComponent(path));
      const closing = /U_ClosingId eq '([^']+)'/.exec(decodeURIComponent(path));
      result = [...this.rows.values()].filter(row => row._entity === entity &&
        (!match || row.U_ExecutionId === match[1]) && (!closing || row.U_ClosingId === closing[1])).length;
    } else if (path.includes("$filter=")) {
      const decoded = decodeURIComponent(path);
      const execId = /U_ExecutionId eq '([^']+)'/.exec(decoded)?.[1];
      const closeId = /U_ClosingId eq '([^']+)'/.exec(decoded)?.[1];
      result = { value: [...this.rows.values()].filter(row => row._entity === entity &&
        (!execId || row.U_ExecutionId === execId) && (!closeId || row.U_ClosingId === closeId)) };
    } else {
      const code = /\('([^']+)'\)/.exec(path)?.[1];
      result = code ? this.rows.get(`${entity}/${code}`) : undefined;
      if (!result) throw new ServiceLayerError("Not found", 404);
    }
    return result as T;
  }
  async post<T>(path: string, body: unknown): Promise<T | undefined> {
    const row = body as Record<string, unknown>;
    const key = `${path}/${String(row.Code)}`;
    if (this.failOnceOn === key) { this.failOnceOn = null; throw new ServiceLayerError("Timeout", 0); }
    if (this.rows.has(key)) throw new ServiceLayerError("Duplicate key", 400, -2035);
    this.rows.set(key, { ...row, _entity: path });
    return undefined;
  }
  async patch<T>(path: string, body: unknown): Promise<T | undefined> {
    const entity = path.startsWith("FBO_GGF_PEXEC") ? "FBO_GGF_PEXEC" : "FBO_GGF_PDOC";
    const code = /\('([^']+)'\)/.exec(path)?.[1] ?? "";
    const key = `${entity}/${code}`;
    const current = this.rows.get(key);
    if (!current) throw new ServiceLayerError("Not found", 404);
    this.rows.set(key, { ...current, ...(body as Record<string, unknown>) });
    return undefined;
  }
}

async function fixture() {
  const executionId = await calculateGgfExecutionId(identity);
  const payloads = [
    { Comments: "technical test 1", amount: "100" },
    { Comments: "technical test 2", amount: "200" },
    { Comments: "technical test 3", amount: "300" }
  ];
  const docs: GgfPostingDocumentLedger[] = [];
  for (let index = 0; index < 3; index++) {
    const request = index < 2 ? payloads[index]! : null;
    const requestHash = request ? await calculateGgfRequestHash(request) : null;
    const status = index === 0 ? "RECONCILED" : index === 1 ? "UNCERTAIN" : "PENDING";
    docs.push({ executionId, identity, sequence: index + 1,
      documentType: ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][index]!,
      plannedAmount: String((index + 1) * 100), currency: "BRL", status, requestHash, request,
      response: index === 0 ? { DocEntry: 900 } : null,
      dependencies: index === 2 ? ["MATERIAL_REVALUATION_AND_CPV_PLANS"] : [],
      attemptCount: index < 2 ? 1 : 0, attemptStartedAt: index < 2 ? "2026-10-01T10:00:00Z" : null,
      responseReceivedAt: null, sapDocEntry: index === 0 ? 900 : null, sapDocNum: index === 0 ? 901 : null,
      sapTransId: index === 0 ? 902 : null, reconciledAt: index === 0 ? "2026-10-01T10:01:00Z" : null,
      reconciliationStatus: index === 0 ? "MATCHED" : index === 1 ? "NO_MATCH" : "NOT_RUN",
      sanitizedError: index === 1 ? "RECONCILIATION_NOT_UNIQUE" : null,
      attempts: index < 2 ? [{ attempt: 1, requestHash: requestHash!, startedAt: "2026-10-01T10:00:00Z",
        responseReceivedAt: null, status, sanitizedError: null }] : [] });
  }
  const totals = executionTotals(docs);
  const record: GgfPostingExecutionRecord = { executionId, identity, status: "POSTING_UNCERTAIN",
    startedAt: "2026-10-01T10:00:00Z", finishedAt: null, startedBy: "technical-test",
    lastError: "RECONCILIATION_NOT_UNIQUE", totalExpected: totals.expected, totalPosted: totals.posted,
    totalReconciled: totals.reconciled, documents: docs };
  return { executionId, record };
}

describe("SAP GGF posting execution ledger", () => {
  it("persists and rereads a partial three-document execution as SAP-authoritative state", async () => {
    const sap = new MemorySap();
    const { executionId, record } = await fixture();
    const firstSession = new SapGgfPostingExecutionRepository(sap);
    await firstSession.create(record);
    const secondSession = new SapGgfPostingExecutionRepository(sap);
    const reread = await secondSession.get(executionId);
    expect(reread).toEqual(record);
    expect(reread?.documents.map(document => document.status)).toEqual(["RECONCILED", "UNCERTAIN", "PENDING"]);
    expect(reread?.documents[0]).toMatchObject({ sapDocEntry: 900, sapDocNum: 901, sapTransId: 902 });
    await expect(secondSession.create(record)).rejects.toThrow("ExecutionId already exists");
  });

  it("rejects count, identity, and document mutations instead of silently rewriting history", async () => {
    const sap = new MemorySap();
    const { executionId, record } = await fixture();
    const repo = new SapGgfPostingExecutionRepository(sap);
    await repo.create(record);
    const changed = structuredClone(record);
    changed.documents[0]!.plannedAmount = "999";
    await expect(repo.save(changed)).rejects.toThrow("identity is immutable");
    sap.rows.delete(`FBO_GGF_PDOC/${executionId}D002`);
    await expect(repo.get(executionId)).rejects.toThrow("count differs");
  });

  it("resumes an incomplete undispatched READY ledger after a storage timeout", async () => {
    const sap = new MemorySap();
    const { executionId, record } = await fixture();
    const documents = record.documents.map(document => ({ ...document, status: "PENDING" as const,
      requestHash: null, request: null, response: null, attemptCount: 0, attemptStartedAt: null,
      responseReceivedAt: null, sapDocEntry: null, sapDocNum: null, sapTransId: null, reconciledAt: null,
      reconciliationStatus: "NOT_RUN" as const, sanitizedError: null, attempts: [] }));
    const ready = { ...record, status: "READY" as const, finishedAt: null, lastError: null,
      totalPosted: "0", totalReconciled: "0", documents };
    sap.failOnceOn = `FBO_GGF_PDOC/${executionId}D002`;
    const repo = new SapGgfPostingExecutionRepository(sap);
    await expect(repo.create(ready)).rejects.toMatchObject({ code: "POSTING_EXECUTION_WRITE_UNCERTAIN" });
    const resumed = await new SapGgfPostingExecutionRepository(sap).create(ready);
    expect(resumed.status).toBe("READY");
    expect(resumed.documents.map(document => document.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
  });

  it("changes ExecutionId when any of the four financial identity parts changes", async () => {
    const base = await calculateGgfExecutionId(identity);
    expect(await calculateGgfExecutionId({ ...identity, claimedAt: "volatile" } as GgfPostingExecutionIdentity)).toBe(base);
    for (const changed of [
      { ...identity, closingVersion: identity.closingVersion + 1 },
      { ...identity, postingPlanVersion: identity.postingPlanVersion + 1 },
      { ...identity, postingHash: "b".repeat(64) }
    ]) expect(await calculateGgfExecutionId(changed)).not.toBe(base);
  });

  it("keeps a legacy claim as an explicit blocker and never overwrites it", async () => {
    const sap = new MemorySap();
    sap.rows.set("FBO_GGF_CLAIM/legacy-close-key", { Code: "legacy-close-key", _entity: "FBO_GGF_CLAIM",
      U_ClosingId: identity.closingId, U_PostingHash: identity.postingHash, U_Version: String(identity.closingVersion) });
    const repo = new SapGgfPostingClaimRepository(sap);
    await expect(repo.claim(identity)).rejects.toThrow("Legacy ClosingId-only claim blocks execution");
    expect(sap.rows.has("FBO_GGF_CLAIM/legacy-close-key")).toBe(true);
  });

  it("rejects a claim that exists for a different closing version, plan version, or hash", async () => {
    const sap = new MemorySap();
    const executionId = await calculateGgfExecutionId(identity);
    sap.rows.set(`FBO_GGF_CLAIM/${executionId}`, { Code: executionId, Name: executionId,
      _entity: "FBO_GGF_CLAIM", U_ClosingId: identity.closingId, U_ExecutionId: executionId,
      U_ClosingVersion: String(identity.closingVersion), U_PostingPlanVersion: String(identity.postingPlanVersion + 1),
      U_PostingHash: identity.postingHash, U_Version: String(identity.closingVersion), U_Status: "CLAIMED",
      U_CreatedAt: "2026-10-01T10:00:00Z", U_UpdatedAt: "2026-10-01T10:00:00Z", U_ClaimedBy: "tester" });
    await expect(new SapGgfPostingClaimRepository(sap).claim(identity))
      .rejects.toThrow("Another financial identity already has a claim");
    expect(sap.rows.size).toBe(1);
  });
});
