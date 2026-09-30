import type { SlReadWrite } from "../../../core/data/SetupRepository";
import { tableName } from "../../../core/config/product";
import { ServiceLayerError } from "../../../core/service/errors";
import { assertClosingConsistency, postingHash, type GgfClosing, type PostingBasis } from "../service/GgfClosing";

const VERSION = tableName("ggf", "CVERS");
const LINE = tableName("ggf", "CLINE");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export class SapMetadataUnavailableError extends Error {
  readonly code = "SAP_METADATA_UNAVAILABLE";
  constructor() {
    super("Metadados do UDO de versões indisponíveis no SAP. Operação bloqueada; tente novamente após reconexão.");
    this.name = "SapMetadataUnavailableError";
  }
}

function metadataError(error: unknown): Error {
  if (error instanceof ServiceLayerError && error.status === 400 &&
      (String(error.code) === "-1002" || /Service Not Found/i.test(error.detail ?? error.message)))
    return new SapMetadataUnavailableError();
  return error instanceof Error ? error : new Error("SAP closing version read failed");
}

export interface ClosingVersionSnapshot {
  closingId: string;
  version: number;
  lineVersion: number;
  status: string;
  postingHash: string;
  postingBasis: PostingBasis;
  recordedAt: string;
  technicalOnly: boolean;
}

interface SapPage { value: Array<Record<string, unknown>>; "@odata.nextLink"?: string; "odata.nextLink"?: string }

function code(id: string, version: number): string {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id) || !Number.isSafeInteger(version) || version < 1 || version > 99999)
    throw new Error("Invalid closing version key");
  return `${id}.${String(version).padStart(5, "0")}`;
}

function lineFields(row: Record<string, unknown>) {
  return { account: String(row.U_Account), criterion: String(row.U_Criterion),
    orderId: String(row.U_OrderId), item: String(row.U_Item), warehouse: String(row.U_Warehouse),
    basis: String(row.U_Basis), percent: String(row.U_Percent), allocated: String(row.U_Allocated),
    costBefore: String(row.U_CostBefore), costAfter: String(row.U_CostAfter),
    revaluation: String(row.U_Revaluation), status: String(row.U_Status) };
}

/** Append-only version evidence; a current CLOSE header is not a historical header. */
export class SapGgfClosingVersionRepository {
  constructor(private readonly client: SlReadWrite) {}

  async assertAvailable(): Promise<void> {
    let count: unknown;
    try { count = await this.client.get(`${VERSION}/$count`); }
    catch (error) { throw metadataError(error); }
    if ((typeof count !== "number" && typeof count !== "string") ||
        !Number.isSafeInteger(Number(count)) || Number(count) < 0)
      throw new SapMetadataUnavailableError();
  }

  async get(closingId: string, version: number): Promise<ClosingVersionSnapshot | null> {
    const key = code(closingId, version);
    let row: Record<string, unknown> | undefined;
    try { row = await this.client.get<Record<string, unknown>>(`${VERSION}(${quote(key)})`); }
    catch (error) {
      if (error instanceof ServiceLayerError && error.status === 404) return null;
      throw metadataError(error);
    }
    if (!row) return null;
    const basis = JSON.parse(String(row.U_PostingBasis ?? "null")) as PostingBasis;
    const snapshot: ClosingVersionSnapshot = {
      closingId: String(row.U_ClosingId), version: Number(row.U_Version),
      lineVersion: Number(row.U_LineVersion), status: String(row.U_Status),
      postingHash: String(row.U_PostingHash), postingBasis: basis,
      recordedAt: String(row.U_RecordedAt), technicalOnly: row.U_TechnicalOnly === "tYES"
    };
    if (row.Code !== key || snapshot.closingId !== closingId || snapshot.version !== version ||
        !Number.isSafeInteger(snapshot.lineVersion) || snapshot.lineVersion < 1 ||
        !/^[a-f0-9]{64}$/.test(snapshot.postingHash) ||
        !Number.isFinite(Date.parse(snapshot.recordedAt)) ||
        !basis || basis.fifoLineage?.some(trace => trace.closingId !== closingId || trace.version !== version) ||
        await postingHash(basis) !== snapshot.postingHash)
      throw new Error("GGF closing version snapshot hash or identity differs");
    const filter = encodeURIComponent(`U_ClosingId eq ${quote(closingId)} and U_Version eq ${quote(String(snapshot.lineVersion))}`);
    const count = Number(await this.client.get<unknown>(`${LINE}/$count?$filter=${filter}`));
    if (!Number.isSafeInteger(count) || count !== basis.lines.length)
      throw new Error("GGF closing version audit count differs");
    const lines: Array<Record<string, unknown>> = [];
    let path = `${LINE}?$filter=${filter}&$orderby=Code&$top=100`;
    const visited = new Set<string>();
    while (path) {
      if (visited.has(path) || visited.size >= 100) throw new Error("GGF closing version audit pagination incomplete");
      visited.add(path);
      const page = await this.client.get<SapPage>(path);
      if (!page || !Array.isArray(page.value)) throw new Error("GGF closing version audit page invalid");
      lines.push(...page.value);
      const next = page["@odata.nextLink"] ?? page["odata.nextLink"];
      path = next ? next.replace(/^\/?b1s\/v\d+\//, "") : "";
      if (next && (!path.startsWith(`${LINE}?`) || path.includes("#")))
        throw new Error("GGF closing version audit page escaped entity");
    }
    if (lines.length !== count || lines.some((line, index) =>
      line.Code !== `${closingId}.${String(snapshot.lineVersion).padStart(5, "0")}.${String(index + 1).padStart(4, "0")}` ||
      line.U_ClosingId !== closingId || line.U_Version !== String(snapshot.lineVersion) ||
      JSON.stringify(lineFields(line)) !== JSON.stringify(basis.lines[index])))
      throw new Error("GGF closing version audit lines differ");
    return snapshot;
  }

  async create(closing: GgfClosing, technicalOnly: boolean): Promise<ClosingVersionSnapshot> {
    if (!closing.postingBasis || !closing.postingHash || closing.postingBasis.fifoLineage?.length !== 1 ||
        closing.postingBasis.fifoLineage[0]?.version !== closing.version)
      throw new Error("Complete FIFO posting basis required for version snapshot");
    await assertClosingConsistency(closing);
    if (await this.get(closing.closingId, closing.version)) throw new Error("GGF closing version already archived");
    const key = code(closing.closingId, closing.version);
    const body = { Code:key, Name:key, U_ClosingId:closing.closingId,
      U_Version:String(closing.version), U_LineVersion:String(closing.lineVersion),
      U_PostingHash:closing.postingHash, U_PostingBasis:JSON.stringify(closing.postingBasis),
      U_Status:closing.status, U_RecordedAt:new Date().toISOString(),
      U_TechnicalOnly:technicalOnly?"tYES":"tNO" };
    try { await this.client.post(VERSION, body); }
    catch (error) { throw metadataError(error); }
    const saved = await this.get(closing.closingId, closing.version);
    if (!saved || saved.postingHash !== closing.postingHash) throw new Error("GGF closing version archive reread differs");
    return saved;
  }
}
