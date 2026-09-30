import type { RevaluationPreview } from "./RevaluationPreview";
import { parseDecimal } from "../../../core/util/money";

export const PAYLOAD_STATUS = {
  ready: "APTO", stock: "ESTOQUE INSUFICIENTE", negative: "ESTOQUE NEGATIVO",
  method: "MÉTODO NÃO HOMOLOGADO", account: "CONTA CONTÁBIL AUSENTE",
  warehouse: "DEPÓSITO NÃO DETERMINADO", cost: "CUSTO ATUAL NÃO COMPROVADO",
  quantity: "QUANTIDADE ELEGÍVEL NÃO COMPROVADA"
} as const;
export type PayloadStatus = typeof PAYLOAD_STATUS[keyof typeof PAYLOAD_STATUS];
export interface VerifiedValue<T> { value: T; refs: string[] }
export interface PayloadEvidence {
  origin: "sap" | "development";
  company: string;
  allocationId: string;
  stockDate: string;
  // This is a technical attestation contract, not a user-editable collection of switches.
  header?: {
    method: VerifiedValue<"moving-average-price-change-v1">;
    postingDate: VerifiedValue<string>;
    taxDate: VerifiedValue<string>;
    series: VerifiedValue<number>;
    periodOpen: VerifiedValue<true>;
    branchScope: VerifiedValue<string>;
    authorization: VerifiedValue<true>;
    functionalApproval: VerifiedValue<true>;
    optionalFields: VerifiedValue<"resolved">;
    reference1?: VerifiedValue<string>;
    memo?: VerifiedValue<string>;
  };
  lines: Array<{
    key: string;
    warehouse: VerifiedValue<string>;
    branch: string;
    currentCost: VerifiedValue<string>;
    stock: VerifiedValue<string>;
    eligibility: Array<{ orderId: string; quantity: string; receiptRefs: string[]; refs: string[] }>;
    accounting?: {
      inventory: VerifiedValue<string>;
      increment: VerifiedValue<string>;
      decrement: VerifiedValue<string>;
      determination: VerifiedValue<"legacy" | "advanced">;
      advancedEnabled: boolean;
      activePostable: VerifiedValue<true>;
    };
    project?: VerifiedValue<string>;
    dimensions?: Array<{ dimension: 1 | 2 | 3 | 4 | 5; rule: VerifiedValue<string> }>;
  }>;
}
function verified<T>(p: VerifiedValue<T> | undefined): p is VerifiedValue<T> {
  return !!p && p.value !== null && p.value !== undefined && p.value !== "" &&
    (typeof p.value !== "string" || !!p.value.trim()) &&
    Array.isArray(p.refs) && p.refs.length > 0 && p.refs.every(r => typeof r === "string" && !!r.trim());
}
function sameDecimal(a: unknown, b: unknown): boolean {
  const valid = (x: unknown): x is string => typeof x === "string" && /^-?\d+(?:\.\d{1,6})?$/.test(x);
  return valid(a) && valid(b) && parseDecimal(a,6) === parseDecimal(b,6);
}
function date(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}

/** A separate, fail-closed document gate. It never recalculates GGF or adjusted prices. */
export function simulateMaterialRevaluation(preview: RevaluationPreview, evidence: PayloadEvidence) {
  const S = PAYLOAD_STATUS;
  const h = evidence.header;
  const contextMatches = evidence.origin === preview.origin && evidence.company === preview.company &&
    evidence.allocationId === preview.allocationId && evidence.stockDate === preview.stockDate && preview.postingBlocked === true;
  const headerReady = !!h && verified(h.method) && h.method.value === "moving-average-price-change-v1" &&
    verified(h.postingDate) && date(h.postingDate.value) && verified(h.taxDate) && date(h.taxDate.value) &&
    verified(h.series) && Number.isSafeInteger(h.series.value) && h.series.value >= 0 &&
    verified(h.periodOpen) && h.periodOpen.value === true && verified(h.branchScope) &&
    verified(h.authorization) && h.authorization.value === true && verified(h.functionalApproval) && h.functionalApproval.value === true &&
    verified(h.optionalFields) && h.optionalFields.value === "resolved" &&
    (!h.reference1 || (verified(h.reference1) && /^[A-Z0-9]{1,11}$/.test(h.reference1.value))) &&
    (!h.memo || (verified(h.memo) && h.memo.value.length <= 50));
  const rows = preview.rows.map(row => {
    const problems: Array<{ status: PayloadStatus; reason: string }> = [];
    const block = (status: PayloadStatus, reason: string) => problems.push({status,reason});
    const scope = preview.scopes.find(s => s.key === `${row.item}/${row.warehouse}`);
    const matches = evidence.lines.filter(l => l.key === scope?.key);
    const proof = matches.length === 1 ? matches[0] : undefined;
    if (row.stock !== null && /^-?\d+(\.\d+)?$/.test(row.stock) && Number(row.stock) < 0) block(S.negative,"negativeStock");
    else if (["NO_STOCK","INSUFFICIENT_STOCK"].includes(row.status) || row.stock === "0.000000") block(S.stock,"insufficientStock");
    if (!row.warehouse || !verified(proof?.warehouse) || proof.warehouse.value !== row.warehouse) block(S.warehouse,"warehouseEvidence");
    if (!verified(proof?.currentCost) || !sameDecimal(proof.currentCost.value,row.currentCost)) block(S.cost,"costEvidence");
    const q = proof?.eligibility.filter(e=>e.orderId === row.orderId) ?? [];
    if (q.length !== 1 || !sameDecimal(q[0]?.quantity,row.eligible) || !q[0]?.refs.length || q[0].refs.some(r=>!r.trim()) ||
        !Array.isArray(q[0].receiptRefs) || q[0].receiptRefs.length !== row.receipts.length || new Set(q[0].receiptRefs).size !== q[0].receiptRefs.length ||
        row.receipts.some(r=>!q[0]!.receiptRefs.includes(`${r.document}/${r.line}`))) block(S.quantity,"productionRemainingNotProven");
    const a = proof?.accounting;
    if (!a || !verified(a.inventory) || !verified(a.increment) || !verified(a.decrement) || !verified(a.determination) ||
        typeof a.advancedEnabled !== "boolean" || a.determination.value !== (a.advancedEnabled ? "advanced" : "legacy") || !verified(a.activePostable) || a.activePostable.value !== true)
      block(S.account,"effectiveAccountsNotProven");
    if (row.method !== "bis_MovingAverage") block(S.method,row.method === "bis_FIFO" ? "fifoLayersAndRuleRequired" : row.method === "bis_Standard" ? "standardPriceRuleRequired" : "unsupportedValuation");
    if (!contextMatches) block(S.method,"evidenceSnapshotMismatch");
    if (!headerReady || (proof && proof.branch !== h?.branchScope?.value)) block(S.method,"documentContextNotProven");
    if (!verified(proof?.stock) || !sameDecimal(proof.stock.value,row.stock)) block(S.stock,"stockEvidenceMismatch");
    if (preview.technicalOnly || row.status !== "READY" || !scope?.ready || scope.targetPrice === null || scope.estimate === "0.00") block(S.method,"approvedPreviewNotReady");
    if (proof?.project && !verified(proof.project)) block(S.method,"projectNotProven");
    if (proof?.dimensions && (new Set(proof.dimensions.map(d=>d.dimension)).size !== proof.dimensions.length ||
        proof.dimensions.some(d=>![1,2,3,4,5].includes(d.dimension) || !verified(d.rule)))) block(S.method,"dimensionsNotProven");
    return {order:row.order,orderId:row.orderId,key:scope?.key ?? "",status:problems[0]?.status ?? S.ready,problems};
  });
  const globalProblems: string[] = [];
  if (!rows.length || new Set(preview.rows.map(r=>r.id)).size !== rows.length || new Set(preview.scopes.map(s=>s.key)).size !== preview.scopes.length ||
      evidence.lines.some(l=>!preview.scopes.some(s=>s.key===l.key))) globalProblems.push("unexpectedOrDuplicateScope");
  const p = preview.payload;
  if (!p || !preview.payloadReady || p.RevalType !== "P" || p.DocDate !== h?.postingDate?.value || p.TaxDate !== h?.taxDate?.value ||
      p.MaterialRevaluationLines.length !== preview.scopes.length) globalProblems.push("approvedDocumentMissingOrDifferent");
  const lines = p?.MaterialRevaluationLines.map(line => {
    const key=`${line.ItemCode}/${line.WarehouseCode}`;
    const proof=evidence.lines.find(l=>l.key===key), scope=preview.scopes.find(s=>s.key===key);
    const negative=Number(scope?.estimate)<0;
    const account=negative?("RevaluationDecrementAccount" in line?line.RevaluationDecrementAccount:undefined):("RevaluationIncrementAccount" in line?line.RevaluationIncrementAccount:undefined);
    if (!scope || !Number.isFinite(line.Price) || line.Price < 0 || !sameDecimal(String(line.Price),scope.targetPrice)) globalProblems.push("priceMismatch");
    if (!account || account !== (negative?proof?.accounting?.decrement.value:proof?.accounting?.increment.value)) globalProblems.push("accountMismatch");
    const dimensions=Object.fromEntries((proof?.dimensions??[]).map(d=>[d.dimension===1?"DistributionRule":`DistributionRule${d.dimension}`,d.rule.value]));
    return { ItemCode:line.ItemCode, WarehouseCode:line.WarehouseCode, Price:line.Price,
      ...(negative?{RevaluationDecrementAccount:account!}:{RevaluationIncrementAccount:account!}),
      ...(proof?.project?{Project:proof.project.value}:{}),...dimensions };
  }) ?? [];
  if (new Set(lines.map(l=>`${l.ItemCode}/${l.WarehouseCode}`)).size !== lines.length) globalProblems.push("duplicateDocumentLines");
  if (globalProblems.length) for (const row of rows) {
    row.problems.push({status:S.method,reason:globalProblems.join(",")});
    if(row.status===S.ready)row.status=S.method;
  }
  const ready=rows.length>0 && rows.every(r=>r.status===S.ready) && globalProblems.length===0;
  return { rows, status:ready?S.ready:rows.find(r=>r.status!==S.ready)?.status ?? S.method, postingBlocked:true as const,
    endpoint:"/b1s/v2/MaterialRevaluation", method:"POST (NOT EXECUTED)",
    payload:ready?{DocDate:h!.postingDate.value,TaxDate:h!.taxDate.value,Series:h!.series.value,RevalType:"P",
      ...(h!.reference1?{Reference1:h!.reference1.value}:{}),
      Comments:h!.memo?.value??p!.Comments,JournalMemo:h!.memo?.value??p!.JournalMemo,MaterialRevaluationLines:lines}:null,
    evidence, globalProblems, livePostingValidated:false as const };
}

/** Existing reads prove cost/warehouse only, never remaining stock or effective accounts. */
export function pendingPayloadEvidence(preview: RevaluationPreview): PayloadEvidence {
  return {origin:preview.origin,company:preview.company,allocationId:preview.allocationId,stockDate:preview.stockDate,
    lines:preview.scopes.map(scope=>({key:scope.key,branch:"",
      warehouse:{value:scope.warehouse,refs:preview.rows.filter(r=>`${r.item}/${r.warehouse}`===scope.key).flatMap(r=>r.receipts.map(d=>`InventoryGenEntries(${d.document})/${d.line}:WarehouseCode`))},
      currentCost:{value:scope.currentCost??"",refs:scope.currentCost===null?[]:[`Items('${scope.item}')/ItemWarehouseInfoCollection('${scope.warehouse}'):StandardAveragePrice`]},
      stock:{value:scope.stock??"",refs:scope.stock===null?[]:[`Items('${scope.item}')/ItemWarehouseInfoCollection('${scope.warehouse}'):InStock`]},
      eligibility:[]}))};
}
