import type { GgfClosing } from "../service/GgfClosing";
import type { RevaluationCandidate } from "../service/GgfPostingCoordinator";

interface ReadClient { get<T = unknown>(path: string): Promise<T | undefined> }
interface Page { value: Array<{ DocEntry: number }>; "@odata.nextLink"?: string; "odata.nextLink"?: string }
type Row = Record<string, any>;

function checked<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Incomplete SAP reconciliation: ${label}`);
  return value;
}

/** Read-only search: date-wide scan, independent count, complete documents and journals. */
export class SapRevaluationReconciliation {
  constructor(private readonly client: ReadClient) {}

  async find(closing: GgfClosing): Promise<RevaluationCandidate[]> {
    const date = closing.proposedPayload?.DocDate;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error("Closing has no valid SAP posting date");
    const filter = encodeURIComponent(`DocDate ge '${date}' and DocDate le '${date}'`);
    const base = `MaterialRevaluation?$select=DocEntry&$filter=${filter}&$orderby=DocEntry&$top=100`;
    const expected = Number(checked(await this.client.get<unknown>(`MaterialRevaluation/$count?$filter=${filter}`), "independent count"));
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Invalid SAP revaluation count");
    const keys: number[] = [];
    const seen = new Set<string>();
    let path = base;
    while (path) {
      if (seen.has(path) || seen.size >= 100) throw new Error("Incomplete SAP revaluation pagination");
      seen.add(path);
      const page = checked(await this.client.get<Page>(path), "revaluation page");
      if (!Array.isArray(page.value)) throw new Error("Invalid SAP revaluation page");
      for (const row of page.value) {
        if (!Number.isSafeInteger(row.DocEntry) || row.DocEntry <= 0) throw new Error("Invalid SAP revaluation key");
        keys.push(row.DocEntry);
      }
      const next = page["@odata.nextLink"] ?? page["odata.nextLink"];
      path = next ? next.replace(/^\/?b1s\/v\d+\//, "") : "";
      if (next && (!path.startsWith("MaterialRevaluation?") || path.includes("#")))
        throw new Error("SAP revaluation page escaped entity");
    }
    if (keys.length !== expected || new Set(keys).size !== keys.length)
      throw new Error("SAP revaluation count or uniqueness differs");
    if (closing.sapMaterialRevaluationDocEntry && !keys.includes(closing.sapMaterialRevaluationDocEntry))
      throw new Error("Known SAP document absent from posting-date reconciliation");
    const result: RevaluationCandidate[] = [];
    for (const key of keys) {
      const doc = checked(await this.client.get<Row>(`MaterialRevaluation(${key})`), "revaluation document");
      if (!Number.isSafeInteger(doc.TransNum) || !Array.isArray(doc.MaterialRevaluationLines))
        throw new Error("Incomplete SAP revaluation document");
      const journal = checked(await this.client.get<Row>(`JournalEntries(${doc.TransNum})`), "revaluation journal");
      if (journal.JdtNum !== doc.TransNum || !Array.isArray(journal.JournalEntryLines))
        throw new Error("SAP document/journal link differs");
      result.push({ docEntry: doc.DocEntry, docNum: doc.DocNum, transId: doc.TransNum,
        docDate: String(doc.DocDate), revalType: String(doc.RevalType),
        comments: doc.Comments ?? null, journalMemo: doc.JournalMemo ?? null,
        lines: doc.MaterialRevaluationLines.map((l: Row) => ({
          item: String(l.ItemCode), warehouse: String(l.WarehouseCode), price: l.Price,
          amount: String(l.RevalAmountToStock), incrementAccount: l.RevaluationIncrementAccount ?? null,
          decrementAccount: l.RevaluationDecrementAccount ?? null
        })),
        journalLines: journal.JournalEntryLines.map((l: Row) => ({
          account: String(l.AccountCode), debit: String(l.Debit ?? 0), credit: String(l.Credit ?? 0)
        })) });
    }
    return result;
  }
}
