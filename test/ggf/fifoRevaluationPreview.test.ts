import { describe, expect, it } from "vitest";
import { previewFifoRevaluation, reconcileFifoValues,
  type FifoPreviewInput } from "../../webapp/modules/ggf/service/FifoRevaluationPreview";

function fixture(): FifoPreviewInput {
  return {
    item: "F1GGF26F01", warehouse: "01", stockQty: "10",
    layers: [
      { transactionSequenceNum: 2789, layerId: 0, openQty: "5", currentCost: "10",
        receiptQty: "5", source: "InventoryGenEntries(118)/0" },
      { transactionSequenceNum: 2790, layerId: 0, openQty: "5", currentCost: "12",
        receiptQty: "5", source: "InventoryGenEntries(120)/0" }
    ],
    target: { transactionSequenceNum: 2789, layerId: 0, eligibleQty: "5", newPrice: "10.2" },
    posting: { date: "2026-09-28", series: 25, reference: "F1FIFO2609281",
      memo: "FactoryOne FIFO homologacao F1FIFO2609281", incrementAccount: "5.03.01.01.04" }
  };
}

describe("FIFO price-change preview, without SAP POST", () => {
  it("previews one open layer and its exact stock impact", () => {
    const input=fixture();
    input.layers=[input.layers[0]!];input.stockQty="5";
    const result=previewFifoRevaluation(input);
    expect(result).toMatchObject({status:"FIFO_APTO",beforeMinor:"5000",deltaMinor:"100",
      afterMinor:"5100",affectedQty:"5.000000"});
    expect(result.payload?.MaterialRevaluationLines[0]?.FIFOLayers).toEqual([
      {TransactionSequenceNum:2789,LayerID:0,Price:10.2}]);
    expect(result.payload?.MaterialRevaluationLines[0]).not.toHaveProperty("Price");
  });

  it("previews two layers while changing only the identified one", () => {
    const result=previewFifoRevaluation(fixture());
    expect(result).toMatchObject({status:"FIFO_APTO",beforeMinor:"11000",deltaMinor:"100",
      afterMinor:"11100"});
    expect(result.payload?.MaterialRevaluationLines[0]?.FIFOLayers).toHaveLength(1);
  });

  it("uses only the remaining open quantity of a partially consumed layer", () => {
    const input=fixture();
    input.layers=[{...input.layers[0]!,openQty:"3"},input.layers[1]!];
    input.stockQty="8";input.target.eligibleQty="3";
    expect(previewFifoRevaluation(input)).toMatchObject({status:"FIFO_APTO",
      beforeMinor:"9000",deltaMinor:"60",afterMinor:"9060",receiptConsumedQty:"2.000000"});
  });

  it("blocks a closed or absent layer", () => {
    const input=fixture();input.target.layerId=9;
    expect(previewFifoRevaluation(input)).toMatchObject({status:"FIFO_CAMADA_FECHADA",payload:null});
  });

  it("blocks a layer without a proven sequence and ID", () => {
    const input=fixture();input.target.transactionSequenceNum=Number.NaN;
    expect(previewFifoRevaluation(input)).toMatchObject({status:"FIFO_CAMADA_NAO_IDENTIFICADA",payload:null});
  });

  it("blocks both excessive and partial quantities under Price Change", () => {
    for (const eligibleQty of ["6","4"]) {
      const input=fixture();input.target.eligibleQty=eligibleQty;
      expect(previewFifoRevaluation(input)).toMatchObject({status:"FIFO_QUANTIDADE_INSUFICIENTE",payload:null});
    }
  });

  it("blocks negative stock, inconsistent layers and missing accounting", () => {
    const negative=fixture();negative.stockQty="-1";
    expect(previewFifoRevaluation(negative)).toMatchObject({status:"FIFO_ESTOQUE_NEGATIVO",payload:null});
    const inconsistent=fixture();inconsistent.stockQty="9";
    expect(previewFifoRevaluation(inconsistent)).toMatchObject({status:"FIFO_DADOS_INCOMPLETOS",payload:null});
    const incomplete=fixture();incomplete.posting.incrementAccount="";
    expect(previewFifoRevaluation(incomplete)).toMatchObject({status:"FIFO_DADOS_INCOMPLETOS",payload:null});
  });

  it("rounds each open layer to cents deterministically", () => {
    const input=fixture();input.layers=[{...input.layers[0]!,openQty:"3",receiptQty:"3",currentCost:"10.005"}];
    input.stockQty="3";input.target.eligibleQty="3";input.target.newPrice="10.015";
    expect(previewFifoRevaluation(input)).toMatchObject({status:"FIFO_APTO",
      beforeMinor:"3002",deltaMinor:"3",afterMinor:"3005"});
  });

  it("reconciles layer value and both journal sides independently", () => {
    const preview=previewFifoRevaluation(fixture());
    const after=[{transactionSequenceNum:2789,layerId:0,openQty:"5",currentCost:"10.2"},
      {transactionSequenceNum:2790,layerId:0,openQty:"5",currentCost:"12"}];
    expect(reconcileFifoValues(preview,after,"100","100")).toEqual({reconciled:true,differenceMinor:"0"});
    expect(reconcileFifoValues(preview,after,"99","100").reconciled).toBe(false);
    expect(reconcileFifoValues(preview,[{...after[0]!,currentCost:"10"},after[1]!],"100","100"))
      .toEqual({reconciled:false,differenceMinor:"-100"});
    expect(reconcileFifoValues(preview,[{...after[0]!,transactionSequenceNum:9999},after[1]!],
      "100","100")).toEqual({reconciled:false,differenceMinor:"0"});
    const replaced=[{...after[1]!,docNumber:"76",docType:"ttGeneralReceiptToStock"},
      {...after[0]!,transactionSequenceNum:2791,docNumber:"6",docType:"ttInventoryValuation"}];
    expect(reconcileFifoValues(preview,replaced,"100","100",{docNum:"6"}))
      .toEqual({reconciled:true,differenceMinor:"0"});
    expect(reconcileFifoValues(preview,replaced,"100","100",{docNum:"7"}).reconciled).toBe(false);
  });
});
