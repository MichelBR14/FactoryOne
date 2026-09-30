import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import TextArea from "sap/m/TextArea";
import { isSapReadMode } from "../../../core/config/runtime";
import type Event from "sap/ui/base/Event";

const CONFIG_KEY = "factoryone.ggf.v2.absorption.mapping";
const emptyMapping = JSON.stringify({ accounts: [], resources: [], technicalHomologation: true }, null, 2);

/** @namespace factoreone.app.modules.ggf.controller */
export default class AbsorptionV2 extends Controller {
  public override onInit(): void {
    this.getView()!.setModel(new ResourceModel({
      bundleName: "factoreone.app.modules.ggf.i18n.i18n", supportedLocales: [""], fallbackLocale: ""
    }), "ggfText");
    let mapping = emptyMapping;
    try { mapping = localStorage.getItem(CONFIG_KEY) ?? emptyMapping; } catch { /* Storage can be disabled. */ }
    this.getView()!.setModel(new JSONModel({
      start: "2026-09-01", end: "2026-09-30", branch: "",
      dimensions: ["", "", "", "", ""], mapping, sapRead: isSapReadMode(),
      busy: false, hasResult: false, report: null, entries: [], resources: [],
      summary: [], completeness: [], evidence: ""
    }), "v2");
  }

  public onMappingChange(event: Event): void {
    const value = (event.getSource() as TextArea).getValue();
    try { localStorage.setItem(CONFIG_KEY, value); } catch { /* Local configuration is optional. */ }
  }

  public async onRun(): Promise<void> {
    const model = this.getView()!.getModel("v2") as JSONModel;
    if (!model.getProperty("/sapRead")) {
      MessageBox.information("A consulta exige o preview local em modo SAP somente leitura.");
      return;
    }
    if (model.getProperty("/busy")) return;
    let mapping: unknown;
    try { mapping = JSON.parse(model.getProperty("/mapping")); }
    catch { MessageBox.error("O mapeamento local não é um JSON válido."); return; }
    const start = model.getProperty("/start") as string;
    const end = model.getProperty("/end") as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      MessageBox.error("Informe um período válido."); return;
    }
    model.setProperty("/busy", true);
    model.setProperty("/hasResult", false);
    try {
      const dimensions = model.getProperty("/dimensions") as string[];
      const params = new URLSearchParams({ start, end, branch: (model.getProperty("/branch") as string) ?? "", mapping: JSON.stringify(mapping) });
      dimensions.forEach((value, index) => { if (value) params.set(`dim${index + 1}`, value); });
      const response = await fetch(`/__ggf/v2/absorption?${params}`, {
        headers: { "X-FactoryOne-Read": "1" },
        credentials: "same-origin",
        cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Leitura SAP indisponível.");
      const formatMoney = (cents: string) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents) / 100);
      const report = body.report;
      const summary = report.reconciliation.map((row: Record<string, unknown>) => ({
        ...row,
        real: formatMoney(row.realCents as string), absorbed: formatMoney(row.absorbedCents as string),
        difference: formatMoney(row.differenceCents as string),
        statusText: row.status === "CONCILIATED" ? "Conciliado" : row.status === "SUBABSORPTION" ? "Subabsorção" : "Sobreabsorção"
      }));
      const entries = report.accounts.flatMap((account: Record<string, unknown>) =>
        (account.entries as Array<Record<string, unknown>>).map((entry) => ({
          ...entry, account: account.account, accountName: account.accountName, category: account.category,
          debit: formatMoney(entry.debitCents as string), credit: formatMoney(entry.creditCents as string),
          dimensionsText: (entry.dimensions as string[]).filter(Boolean).join(" / ") || "-"
        })));
      const resources = report.resources.map((row: Record<string, string>) => ({
        ...row, quantity: (Number(row.quantityMicros) / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 6 }),
        unitCost: formatMoney(row.unitCostCents as string), amount: formatMoney(row.amountCents as string),
        movementValue: formatMoney(row.movementCostCents as string)
      }));
      const resourceCatalog = report.resourceCatalog.map((row: Record<string, unknown>) => ({
        ...row,
        unit: row.unit || "Não informada",
        componentsText: (row.components as Array<{ component: number; unitCostCents: string }>)
          .map((item) => `Cost${item.component}: ${formatMoney(item.unitCostCents)}`).join(" · ")
      }));
      model.setProperty("/report", report);
      model.setProperty("/summary", summary);
      model.setProperty("/entries", entries);
      model.setProperty("/resources", resources);
      model.setProperty("/resourceCatalog", resourceCatalog);
      model.setProperty("/completeness", report.completeness);
      model.setProperty("/blockers", report.blockers.map((text: string) => ({ text })));
      model.setProperty("/statuses", report.statuses.map((text: string) => ({ text })));
      model.setProperty("/evidence", JSON.stringify({ company: body.source.company, capturedAt: body.source.capturedAt, filter: body.source.filter }, null, 2));
      model.setProperty("/hasResult", true);
    } catch (error) {
      MessageBox.error(error instanceof Error ? error.message : "Falha na leitura SAP.");
    } finally { model.setProperty("/busy", false); }
  }

  public onBack(): void { (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggf"); }
}
