import { describe, expect, it } from "vitest";
import { classifyFifoOrderTraces, previewFifoProduction, type FifoProductionInput } from "../../webapp/modules/ggf/service/FifoProductionTrace";

function fixture(): FifoProductionInput {
  return {
    lineage: { closingId: null, orderDocEntry: 214, receiptDocEntry: 122,
      receiptLine: 0, receiptDocNum: 77, item: "F1GGF26P01", warehouse: "01",
      originalLayer: { transactionSequenceNum: 2792, layerId: 0 }, remainingQuantity: null,
      revaluationDocEntry: null, revaluationDocNum: null, resultLayer: null },
    producedQuantity: "10", receiptQuantity: "10", unit: "UN", ggFMinor: "10000",
    independentlyIssuedQuantity: "6",
    layers: [{ transactionSequenceNum: 2792, layerId: 0, docNumber: "77", docType:"ttGeneralReceiptToStock", item: "F1GGF26P01",
      warehouse: "01", openQuantity: "4", currentCost: "12" }]
  };
}

describe("FIFO production lineage preview", () => {
  it("separates only remaining stock without redistributing consumed GGF", () => {
    expect(previewFifoProduction(fixture())).toMatchObject({
      status: "FIFO_PARTIALLY_CONSUMED", producedQuantity: "10.000000", openQuantity: "4.000000",
      consumedQuantity: "6.000000", ggFUnitMinor: "1000.000000", inventoryGgfMinor: "4000",
      consumedGgfMinor: "6000", accountingForConsumed: "PENDING", payload: null,
      stockDisposition:"FIFO_STOCK_REVALUATION_CANDIDATE",
      consumedDisposition:"FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE",potentialRevaluationMinor:"4000",
      lineage: { remainingQuantity: "4.000000" }
    });
  });

  it("classifies fully available and fully consumed layers", () => {
    const full=fixture();full.layers=[{...full.layers[0]!,openQuantity:"10"}];full.independentlyIssuedQuantity="0";
    expect(previewFifoProduction(full)).toMatchObject({status:"FIFO_FULLY_AVAILABLE",inventoryGgfMinor:"10000",consumedGgfMinor:"0"});
    const empty=fixture();empty.layers=[{...empty.layers[0]!,openQuantity:"0"}];empty.independentlyIssuedQuantity="10";
    expect(previewFifoProduction(empty)).toMatchObject({status:"FIFO_FULLY_CONSUMED",inventoryGgfMinor:"0",consumedGgfMinor:"10000"});
  });

  it("blocks absent and duplicated layer identities", () => {
    const missing=fixture();missing.layers=[];
    expect(previewFifoProduction(missing)).toMatchObject({status:"FIFO_LAYER_NOT_FOUND",payload:null});
    const duplicated=fixture();duplicated.layers=[duplicated.layers[0]!,duplicated.layers[0]!];
    expect(previewFifoProduction(duplicated)).toMatchObject({status:"FIFO_MULTIPLE_LAYERS",payload:null});
  });

  it("blocks changed receipt, incompatible quantity, or contradictory issue", () => {
    const changed=fixture();changed.layers=[{...changed.layers[0]!,docNumber:"78"}];
    expect(previewFifoProduction(changed)).toMatchObject({status:"FIFO_TRACE_AMBIGUOUS",payload:null});
    const excess=fixture();excess.layers=[{...excess.layers[0]!,openQuantity:"11"}];
    expect(previewFifoProduction(excess)).toMatchObject({status:"FIFO_TRACE_AMBIGUOUS",payload:null});
    const issue=fixture();issue.independentlyIssuedQuantity="5";
    expect(previewFifoProduction(issue)).toMatchObject({status:"FIFO_TRACE_AMBIGUOUS",payload:null});
  });

  it("keeps prior and replacement layer identities distinct", () => {
    const replacement=fixture();replacement.lineage={...replacement.lineage,
      revaluationDocEntry:30,revaluationDocNum:6,resultLayer:{transactionSequenceNum:2793,layerId:0}};
    replacement.layers=[{...replacement.layers[0]!,transactionSequenceNum:2793,docNumber:"6",docType:"ttInventoryValuation"}];
    expect(previewFifoProduction(replacement)).toMatchObject({status:"FIFO_PARTIALLY_CONSUMED",
      lineage:{originalLayer:{transactionSequenceNum:2792},resultLayer:{transactionSequenceNum:2793}}});
    replacement.layers=[{...replacement.layers[0]!,docNumber:"7"}];
    expect(previewFifoProduction(replacement)).toMatchObject({status:"FIFO_TRACE_AMBIGUOUS",payload:null});
  });

  it("splits fractional cents over original quantity with exact total conservation", () => {
    const input=fixture();input.ggFMinor="10001";
    const result=previewFifoProduction(input);
    expect(result).toMatchObject({inventoryGgfMinor:"4000",consumedGgfMinor:"6001",payload:null});
  });
  it("identifies multiple receipts and layers as requiring per-layer allocation", () => {
    const first=fixture(),second=fixture();
    second.lineage={...second.lineage,receiptDocEntry:123,receiptDocNum:78,
      originalLayer:{transactionSequenceNum:2793,layerId:0}};
    second.layers=[{...second.layers[0]!,transactionSequenceNum:2793,docNumber:"78"}];
    expect(classifyFifoOrderTraces([first,second])).toBe("FIFO_MULTIPLE_LAYERS");
    expect(classifyFifoOrderTraces([first,first])).toBe("FIFO_TRACE_AMBIGUOUS");
    expect(classifyFifoOrderTraces([])).toBe("FIFO_LAYER_NOT_FOUND");
  });
});
