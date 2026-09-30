import { mkdir, writeFile } from "node:fs/promises";
import { openReadSession } from "./ggf-sap-session.mjs";

const candidates = {
  ChartOfAccounts: "Code,Name,ActiveAccount,AccountType,AcctCurrency",
  JournalEntries: "JdtNum,ReferenceDate,OriginalJournal",
  ProductionOrders:
    "AbsoluteEntry,DocumentNumber,PostingDate,ClosingDate,ItemNo,CompletedQuantity,InventoryUOM,ProductionOrderStatus",
  InventoryGenEntries: "DocEntry,DocNum,DocDate,Cancelled,TransNum",
  InventoryGenExits: "DocEntry,DocNum,DocDate,Cancelled,TransNum",
  Resources: "Code,Name,Group,UnitOfMeasure,Cost1",
  ResourceGroups: "Code,Name,NumOfUnitsText",
  ProjectManagementTimeSheet: "AbsEntry,DateFrom,DateTo",
  BusinessPlaces: "BPLID,BPLName",
  UnitOfMeasurements: "AbsEntry,Code,Name",
  SQLQueries: "SqlCode,SqlName"
};
const session = await openReadSession();
try {
  const report = { capturedAt: new Date().toISOString(), ...session.info, sources: {} };
  await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
  for (const [entity, select] of Object.entries(candidates)) {
    const count = await session.get(`${entity}/$count`);
    const sample = await session.get(`${entity}?$select=${select}&$top=3`);
    report.sources[entity] = { count, sample };
    console.log(
      JSON.stringify({
        entity,
        count: count.ok ? count.data : count.status,
        sampleStatus: sample.status,
        rows: sample.data?.value?.length
      })
    );
  }
  await writeFile(".local/ggf/survey.json", JSON.stringify(report, null, 2), { mode: 0o600 });
} finally {
  await session.close();
}
