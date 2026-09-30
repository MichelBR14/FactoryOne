import type { AllocationResult } from "../engine/types";
import type { RevaluationInput } from "../service/RevaluationPreview";

/** Controlled demonstration only. Never called by the SAP reader. */
export function demoRevaluationInput(result: AllocationResult): RevaluationInput {
  if (result.snapshot.origin !== "development") throw new Error("Fictional valuation requires fictional allocation");
  return { origin: "development", company: "DEVELOPMENT", allocationId: result.snapshot.id,
    allocationDate: result.snapshot.capturedAt, stockDate: new Date().toISOString(), technicalOnly: false,
    sourceRefs: ["DEV-VALUATION-v1: fictional stock and proven-remaining fixtures"],
    policy: { perpetual: true, costScope: "warehouse", functionalApproved: true, stockTreatment: "spread-over-current-stock", postingDate: result.snapshot.filter.end,
      incrementAccount: "DEV-INCREASE", decrementAccount: "DEV-DECREASE", accountsVerified: true },
    orders: result.orders.map(({order,allocated}) => ({ id: order.id, number: order.number, item: order.item,
      planned: order.quantity, produced: order.quantity, unit: "UN", allocatedMinor: String(allocated),
      components: (order.directCostComponents ?? []).map(c => ({...c, kind: c.kind === "DEVELOPMENT_MATERIAL" ? "material" : c.kind === "DEVELOPMENT_RESOURCE" ? "resource" : c.kind})), inconsistencies: [],
      accounts: result.configuration.accounts.map(a => ({account:a.account,name:a.name,
        amountMinor: String(result.traces.filter(t => t.account===a.account && t.orderId===order.id).reduce((v,t)=>v+t.amount,0n))})),
      receipts: [{document:`DEV-RECEIPT-${order.number}`,line:0,date:result.snapshot.filter.end,warehouse:"DEV-WH",quantity:order.quantity!,unit:"UN"}],
      remaining: [{warehouse:"DEV-WH",quantity:order.quantity!,evidence:"DEV fixture: all production remains in stock"}] })),
    items: result.orders.map(({order}) => ({code:order.item,name:`Produto demonstrativo ${order.number}`,unit:"UN",method:"bis_MovingAverage",
      inventory:true,serial:false,batch:false,totalStock:order.quantity,globalCost:null,
      warehouses:[{code:"DEV-WH",stock:order.quantity,cost:"100.000000",locked:false}]})) };
}
