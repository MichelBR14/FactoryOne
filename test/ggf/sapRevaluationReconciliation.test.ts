import { describe, expect, it } from "vitest";
import { SapRevaluationReconciliation } from "../../webapp/modules/ggf/repository/SapRevaluationReconciliation";
import type { GgfClosing } from "../../webapp/modules/ggf/service/GgfClosing";

const closing={proposedPayload:{DocDate:"2026-09-28"},sapMaterialRevaluationDocEntry:null} as unknown as GgfClosing;
const doc={DocEntry:25,DocNum:5,TransNum:2278,DocDate:"2026-09-28T00:00:00Z",RevalType:"P",
  Comments:"FactoryOne GGF TEST_1",JournalMemo:"FactoryOne GGF TEST_1",
  MaterialRevaluationLines:[{ItemCode:"F1GGF26H01",WarehouseCode:"01",Price:13,RevalAmountToStock:1,
    RevaluationIncrementAccount:"5.03.01.01.04",RevaluationDecrementAccount:"5.03.01.01.04"}]};
const journal={JdtNum:2278,JournalEntryLines:[{AccountCode:"1.01.02.01.01",Debit:1,Credit:0},
  {AccountCode:"5.03.01.01.04",Debit:0,Credit:1}]};

describe("SAP MaterialRevaluation reconciliation reader (GET only)",()=>{
  it("reads a counted date-wide page and the linked journal",async()=>{
    const paths:string[]=[];
    const reader=new SapRevaluationReconciliation({async get<T>(path:string):Promise<T|undefined>{
      paths.push(path);
      if(path.startsWith("MaterialRevaluation/$count"))return 1 as T;
      if(path.startsWith("MaterialRevaluation?"))return {value:[{DocEntry:25}]} as T;
      if(path==="MaterialRevaluation(25)")return doc as T;
      if(path==="JournalEntries(2278)")return journal as T;
      throw new Error(`unexpected ${path}`);
    }});
    const result=await reader.find(closing);
    expect(result[0]).toMatchObject({docEntry:25,docNum:5,transId:2278,
      lines:[{item:"F1GGF26H01",warehouse:"01",amount:"1"}]});
    expect(paths).toHaveLength(4);
    expect(paths.every(p=>!p.includes("Reference1"))).toBe(true);
  });
  it("fails closed on count mismatch and never treats a partial page as no document",async()=>{
    const reader=new SapRevaluationReconciliation({async get<T>(path:string):Promise<T|undefined>{
      return (path.includes("/$count")?2:{value:[{DocEntry:25}]}) as T;
    }});
    await expect(reader.find(closing)).rejects.toThrow("count or uniqueness differs");
  });
  it("fails closed if a known DocEntry is absent from the date scan",async()=>{
    const reader=new SapRevaluationReconciliation({async get<T>(path:string):Promise<T|undefined>{
      return (path.includes("/$count")?0:{value:[]}) as T;
    }});
    await expect(reader.find({...closing,sapMaterialRevaluationDocEntry:25})).rejects.toThrow("Known SAP document absent");
  });
});
