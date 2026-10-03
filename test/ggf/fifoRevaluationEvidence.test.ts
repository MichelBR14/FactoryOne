import { describe, expect, it } from "vitest";
import { reconcileFifoMaterialRevaluation } from "../../webapp/modules/ggf/service/FifoRevaluationEvidence";

const expected = { docEntry: 44, docNum: 7, transId: 2311, itemCode: "F1GGF26F01", warehouseCode: "01",
  sourceSequence: 2790, sourceLayerId: 0, quantity: 5, unitCostBefore: 12, unitCostAfter: 12.2,
  branch: 1, currency: "R$", revaluationAccount: "5.03.01.01.04", debitAccount: "1.01.02.01.01",
  creditAccount: "5.03.01.01.04", amountCents: 100 };

function evidence() {
  return { document: { DocEntry: 44, DocNum: 7, TransNum: 2311, RevalType: "P", Reference1: null as string | null,
    MaterialRevaluationLines: [{ ItemCode: "F1GGF26F01", WarehouseCode: "01",
      RevaluationIncrementAccount: "5.03.01.01.04", RevalAmountToStock: 0,
      FIFOLayers: [{ TransactionSequenceNum: 2790, LayerID: 0, Price: 12.2 }] }] },
    journalEntry: { JdtNum: 2311, JournalEntryLines: [
      { AccountCode: "1.01.02.01.01", Debit: 1, Credit: 0, BPLID: 1, FCCurrency: "R$" },
      { AccountCode: "5.03.01.01.04", Debit: 0, Credit: 1, BPLID: 1, FCCurrency: "R$" }] },
    sourceLayer: { TransactionSequenceNum: 2790, LayerID: 0, OpenQty: 5, CurrentCost: 12 },
    resultingLayer: { DocNumber: 7, DocType: "ttInventoryValuation", ItemCode: "F1GGF26F01", WarehouseCode: "01",
      OpenQty: 5, CurrentCost: 12.2 }, expected };
}

describe("FIFO MaterialRevaluation evidence", () => {
  it("accepts null Reference1 and zero RevalAmountToStock when layer and linked JE prove the adjustment", () => {
    expect(reconcileFifoMaterialRevaluation(evidence()).matched).toBe(true);
  });
  it("accepts zero RevalAmountToStock with correct FIFO layer and JE", () => {
    const input = evidence();
    input.document.Reference1 = "SAP-did-not-retain-this-reference";
    input.document.MaterialRevaluationLines[0]!.RevalAmountToStock = 0;
    expect(reconcileFifoMaterialRevaluation(input).matched).toBe(true);
  });
  it.each([
    ["layer", (x: ReturnType<typeof evidence>) => { x.document.MaterialRevaluationLines[0]!.FIFOLayers[0]!.LayerID = 1; }],
    ["quantity", (x: ReturnType<typeof evidence>) => { x.resultingLayer.OpenQty = 4; }],
    ["final cost", (x: ReturnType<typeof evidence>) => { x.resultingLayer.CurrentCost = 12.3; }],
    ["account", (x: ReturnType<typeof evidence>) => { x.journalEntry.JournalEntryLines[0]!.AccountCode = "9.99"; }],
    ["TransId", (x: ReturnType<typeof evidence>) => { x.journalEntry.JdtNum = 999; }]
  ])("rejects divergent %s evidence", (_name, mutate) => {
    const input = evidence(); mutate(input);
    expect(reconcileFifoMaterialRevaluation(input).matched).toBe(false);
  });
});
