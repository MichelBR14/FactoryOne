import type { SlReadWrite } from "../../../core/data/SetupRepository";
import { tableName } from "../../../core/config/product";
import { ServiceLayerError } from "../../../core/service/errors";
import { calculateGgfPostingPlanHash, type GgfPostingPlan, type GgfPostingPlanDraft } from "../service/GgfPostingPlan";

const ENTITY = tableName("ggf", "PPLAN");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
interface SapPlanRow extends Record<string, unknown> { Code: string }
interface SapPage { value: SapPlanRow[]; "@odata.nextLink"?: string; "odata.nextLink"?: string }

export class SapPostingPlanMetadataUnavailableError extends Error {
  readonly code = "SAP_METADATA_UNAVAILABLE";
  constructor() {
    super("Metadados do plano GGF indisponiveis no SAP. Persistencia bloqueada.");
    this.name = "SapPostingPlanMetadataUnavailableError";
  }
}

export class SapPostingPlanVersionConflictError extends Error {
  readonly code = "POSTING_PLAN_VERSION_CONFLICT";
  constructor(readonly closingId: string, readonly version: number) {
    super("Outra sessao criou esta versao do plano. Releia o plano SAP antes de continuar.");
    this.name = "SapPostingPlanVersionConflictError";
  }
}

export class SapPostingPlanWriteUncertainError extends Error {
  readonly code = "POSTING_PLAN_WRITE_UNCERTAIN";
  constructor(readonly closingId: string, readonly version: number) {
    super("A resposta da gravacao do plano foi interrompida. O SAP deve ser relido antes de qualquer nova tentativa.");
    this.name = "SapPostingPlanWriteUncertainError";
  }
}

function metadataError(error: unknown): Error {
  if (error instanceof ServiceLayerError && (error.status === 404 || error.status === 400 &&
      (String(error.code) === "-1002" || /Service Not Found/i.test(error.detail ?? error.message))))
    return new SapPostingPlanMetadataUnavailableError();
  return error instanceof Error ? error : new Error("SAP posting plan read failed");
}

async function key(closingId: string, version: number): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId) || !Number.isSafeInteger(version) || version < 1 || version > 9999)
    throw new Error("Invalid SAP posting plan identity");
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for SAP posting plan key");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(closingId));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 7), byte => byte.toString(16).padStart(2, "0")).join("");
  return `P${prefix}${String(version).padStart(4, "0")}`;
}

async function header(plan: GgfPostingPlan): Promise<Record<string, string>> {
  const code = await key(plan.closingId, plan.version);
  return { Code: code, Name: code,
    U_ClosingId: plan.closingId, U_Version: String(plan.closingVersion ?? 0),
    U_PostingPlanVersion: String(plan.version), U_PostingHash: plan.postingHash,
    U_CreatedAt: plan.createdAt, U_CreatedBy: plan.createdBy ?? "",
    U_Status: plan.status, U_TotalMod: plan.totalMod, U_TotalGgf: plan.totalGgf,
    U_TotalStock: plan.totalStock, U_TotalCpv: plan.totalCpv, U_TotalBlocked: plan.totalBlocked,
    U_AcctDifference: plan.accountingDifference, U_PlanSnapshot: JSON.stringify(plan) };
}

async function fromRow(row: SapPlanRow): Promise<GgfPostingPlan> {
  let plan: GgfPostingPlan;
  try { plan = JSON.parse(String(row.U_PlanSnapshot)) as GgfPostingPlan; }
  catch { throw new Error("SAP posting plan snapshot is invalid JSON"); }
  const expectedCode = await key(plan.closingId, plan.version);
  if (row.Code !== expectedCode || row.U_ClosingId !== plan.closingId ||
      Number(row.U_Version) !== (plan.closingVersion ?? 0) ||
      Number(row.U_PostingPlanVersion) !== plan.version || row.U_PostingHash !== plan.postingHash ||
      row.U_Status !== plan.status || row.U_TotalMod !== plan.totalMod || row.U_TotalGgf !== plan.totalGgf ||
      row.U_TotalStock !== plan.totalStock || row.U_TotalCpv !== plan.totalCpv ||
      row.U_TotalBlocked !== plan.totalBlocked || row.U_AcctDifference !== plan.accountingDifference ||
      row.U_CreatedAt !== plan.createdAt || row.U_CreatedBy !== (plan.createdBy ?? "") ||
      plan.postingBlocked !== true || plan.documents.some(document => document.payload !== null))
    throw new Error("SAP posting plan header and snapshot differ");
  return plan;
}

/** SAP is authoritative. Snapshots are immutable UDO records; this repository never PATCHes or deletes. */
export class SapGgfPostingPlanRepository {
  constructor(private readonly client: SlReadWrite, private readonly now = () => new Date().toISOString()) {}

  async assertAvailable(): Promise<void> {
    let count: unknown;
    try { count = await this.client.get(`${ENTITY}/$count`); }
    catch (error) { throw metadataError(error); }
    if ((typeof count !== "number" && typeof count !== "string") || !Number.isSafeInteger(Number(count)) || Number(count) < 0)
      throw new SapPostingPlanMetadataUnavailableError();
  }

  async get(closingId: string, version: number): Promise<GgfPostingPlan | null> {
    const code = await key(closingId, version);
    let row: SapPlanRow | undefined;
    try { row = await this.client.get<SapPlanRow>(`${ENTITY}(${quote(code)})`); }
    catch (error) {
      if (error instanceof ServiceLayerError && error.status === 404) return null;
      throw metadataError(error);
    }
    if (!row) return null;
    const plan = await fromRow(row);
    if (await calculateGgfPostingPlanHash(plan) !== plan.postingHash)
      throw new Error("SAP posting plan hash verification failed");
    return plan;
  }

  async list(closingId: string): Promise<GgfPostingPlan[]> {
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId)) throw new Error("Invalid SAP posting plan ClosingId");
    await this.assertAvailable();
    const filter = encodeURIComponent(`U_ClosingId eq ${quote(closingId)}`);
    const count = Number(await this.client.get(`${ENTITY}/$count?$filter=${filter}`));
    if (!Number.isSafeInteger(count) || count < 0) throw new SapPostingPlanMetadataUnavailableError();
    const rows: SapPlanRow[] = [];
    let path = `${ENTITY}?$filter=${filter}&$orderby=U_PostingPlanVersion&$top=100`;
    const visited = new Set<string>();
    while (path) {
      if (visited.has(path) || visited.size >= 100) throw new Error("SAP posting plan pagination incomplete");
      visited.add(path);
      let page: SapPage | undefined;
      try { page = await this.client.get<SapPage>(path); }
      catch (error) { throw metadataError(error); }
      if (!page || !Array.isArray(page.value)) throw new Error("SAP posting plan page invalid");
      rows.push(...page.value);
      const next = page["@odata.nextLink"] ?? page["odata.nextLink"];
      path = next ? next.replace(/^\/?b1s\/v\d+\//, "") : "";
      if (next && (!path.startsWith(`${ENTITY}?`) || path.includes("#")))
        throw new Error("SAP posting plan page escaped entity");
    }
    if (rows.length !== count || new Set(rows.map(row => row.Code)).size !== count)
      throw new Error("SAP posting plan count differs");
    const plans: GgfPostingPlan[] = [];
    for (const row of rows) {
      const plan = await fromRow(row);
      if (plan.closingId !== closingId || await calculateGgfPostingPlanHash(plan) !== plan.postingHash)
        throw new Error("SAP posting plan identity or hash differs");
      plans.push(plan);
    }
    plans.sort((a, b) => a.version - b.version);
    if (plans.some((plan, index) => plan.version !== index + 1))
      throw new Error("SAP posting plan version sequence has a gap");
    return plans;
  }

  async append(draft: GgfPostingPlanDraft): Promise<GgfPostingPlan> {
    await this.assertAvailable();
    const existing = await this.list(draft.closingId);
    const latest = existing.at(-1);
    if (latest) {
      const unchanged = { ...draft, version: latest.version, createdAt: latest.createdAt, postingHash: "" } as GgfPostingPlan;
      if (await calculateGgfPostingPlanHash(unchanged) === latest.postingHash) return latest;
    }
    const version = (latest?.version ?? 0) + 1;
    const plan = { ...draft, version, createdAt: this.now(), postingHash: "" } as GgfPostingPlan;
    plan.postingHash = await calculateGgfPostingPlanHash(plan);
    const body = await header(plan);
    try { await this.client.post(ENTITY, body); }
    catch (error) {
      if (error instanceof ServiceLayerError && error.status >= 400 && error.status < 500) {
        if (metadataError(error) instanceof SapPostingPlanMetadataUnavailableError)
          throw new SapPostingPlanMetadataUnavailableError();
        if (error.status === 409 || Number(error.code) === -2035)
          throw new SapPostingPlanVersionConflictError(draft.closingId, version);
        throw error;
      }
      try {
        const reconciled = await this.get(draft.closingId, version);
        if (reconciled?.postingHash === plan.postingHash) return reconciled;
      } catch { /* Ambiguous writes fail closed; never issue another POST. */ }
      throw new SapPostingPlanWriteUncertainError(draft.closingId, version);
    }
    const saved = await this.get(draft.closingId, version);
    if (!saved || saved.postingHash !== plan.postingHash)
      throw new Error("SAP posting plan create/readback differs");
    return saved;
  }
}
