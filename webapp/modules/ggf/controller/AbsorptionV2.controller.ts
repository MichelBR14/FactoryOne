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
    type SavedDistribution = Partial<Record<"MOD" | "GGF", { criterion?: string; orderNumbers?: string[]; groupShares?: unknown[] }>>;
    let savedDistribution: SavedDistribution = {};
    try { savedDistribution = (JSON.parse(mapping) as { distribution?: SavedDistribution }).distribution ?? {}; } catch { /* Invalid local JSON is handled on submit. */ }
    this.getView()!.setModel(new JSONModel({
      start: "2026-09-01", end: "2026-09-30", branch: "",
      dimensions: ["", "", "", "", ""], mapping, sapRead: isSapReadMode(),
      modCriterion: savedDistribution.MOD?.criterion ?? "DIRECT_COST", ggfCriterion: savedDistribution.GGF?.criterion ?? "DIRECT_COST",
      modOrders: savedDistribution.MOD?.orderNumbers?.join(",") ?? "76,77,79", ggfOrders: savedDistribution.GGF?.orderNumbers?.join(",") ?? "76,77,79",
      modGroupShares: JSON.stringify(savedDistribution.MOD?.groupShares ?? [], null, 2),
      ggfGroupShares: JSON.stringify(savedDistribution.GGF?.groupShares ?? [], null, 2),
      busy: false, hasResult: false, report: null, entries: [], resources: [],
      summary: [], completeness: [], evidence: "", distribution: null, distributionCategories: [],
      distributionOrders: [], distributionBases: [], distributionWarnings: []
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
    try {
      const modGroups = JSON.parse(model.getProperty("/modGroupShares") as string);
      const ggfGroups = JSON.parse(model.getProperty("/ggfGroupShares") as string);
      const configuration = mapping as Record<string, unknown>;
      const modCriterion = model.getProperty("/modCriterion") as string;
      const ggfCriterion = model.getProperty("/ggfCriterion") as string;
      configuration.distribution = {
        MOD: { criterion: modCriterion, orderNumbers: this.orderNumbers(model.getProperty("/modOrders")), groupShares: modCriterion === "RESOURCE_GROUP" ? modGroups : [] },
        GGF: { criterion: ggfCriterion, orderNumbers: this.orderNumbers(model.getProperty("/ggfOrders")), groupShares: ggfCriterion === "RESOURCE_GROUP" ? ggfGroups : [] }
      };
      const savedMapping = JSON.stringify(configuration, null, 2);
      model.setProperty("/mapping", savedMapping);
      try { localStorage.setItem(CONFIG_KEY, savedMapping); } catch { /* Local configuration is optional. */ }
    } catch { MessageBox.error("Percentuais de grupos devem estar em JSON válido."); return; }
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
      const response = await fetch(`/__ggf/v2/distribution?${params}`, {
        headers: { "X-FactoryOne-Read": "1" },
        credentials: "same-origin",
        cache: "no-store"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Leitura SAP indisponível.");
      const formatMoney = (cents: string) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents) / 100);
      const formatBasis = (value: unknown, decimals: unknown, unit: unknown) => {
        const basisUnit = String(unit ?? "");
        if (basisUnit === "SAP_LOCAL") return formatMoney(String(value));
        const places = Number(decimals ?? 0);
        const amount = Number(BigInt(String(value))) / (10 ** places);
        return `${amount.toLocaleString("pt-BR", { maximumFractionDigits: places })} ${basisUnit}`.trim();
      };
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
      model.setProperty("/distribution", body.distribution);
      model.setProperty("/summary", summary);
      model.setProperty("/entries", entries);
      model.setProperty("/resources", resources);
      model.setProperty("/resourceCatalog", resourceCatalog);
      model.setProperty("/completeness", report.completeness);
      model.setProperty("/blockers", report.blockers.map((text: string) => ({ text })));
      model.setProperty("/statuses", report.statuses.map((text: string) => ({ text })));
      model.setProperty("/evidence", JSON.stringify({ company: body.source.company, capturedAt: body.source.capturedAt, filter: body.source.filter }, null, 2));
      const categories = body.distribution.categories.map((row: Record<string, unknown>) => ({
        ...row, difference: formatMoney(row.differenceCents as string), allocated: formatMoney(row.allocatedCents as string),
        residual: formatMoney(row.residualCents as string),
        statusText: ({
          CONCILIATED: "Conciliado",
          CALCULATED_TECHNICAL: "Calculado (homologação técnica)",
          BLOCKED_CONFIGURATION: "Configuração bloqueada",
          BLOCKED_NO_ACCOUNT: "Sem conta configurada",
          BLOCKED_NO_ORDER: "Sem OP elegível",
          BLOCKED_BASIS: "Base indisponível",
          BLOCKED_INCOMPATIBLE_BASIS: "Base incompatível",
          BLOCKED_SOURCE: "Fonte bloqueada"
        } as Record<string, string>)[String(row.status)] ?? String(row.status)
      }));
      const orderRows = body.distribution.orders.map((row: Record<string, unknown>) => ({
        ...row, standardMod: formatMoney(row.standardModCents as string), standardGgf: formatMoney(row.standardGgfCents as string),
        mod: formatMoney(row.modAdjustmentCents as string), ggf: formatMoney(row.ggfAdjustmentCents as string),
        total: formatMoney(row.totalAdjustmentCents as string), originalCost: row.originalCostCents === null ? "—" : formatMoney(row.originalCostCents as string),
        costAfter: row.costAfterAbsorptionCents === null ? "—" : formatMoney(row.costAfterAbsorptionCents as string),
        baseText: (row.bases as Array<Record<string, unknown>>).map((base) => `${base.category} · ${base.criterion} · base ${formatBasis(base.base, base.basisDecimals, base.basisUnit)} / ${formatBasis(base.totalBase, base.basisDecimals, base.basisUnit)} · ${base.participationPercent}% · ${formatMoney(base.amountCents as string)} · ajuste ${base.roundingMinor} cent. · ${((base.sourceRefs as string[]) ?? []).join(", ")}`).join("\n") || "Sem memória disponível"
      }));
      const total = body.distribution;
      model.setProperty("/distributionCategories", categories);
      model.setProperty("/distributionOrders", orderRows);
      model.setProperty("/distributionBases", body.distribution.orders.flatMap((row: Record<string, unknown>) =>
        (row.bases as Array<Record<string, unknown>>).map((base) => ({
          ...base, orderNumber: row.orderNumber, item: row.item,
          amount: formatMoney(base.amountCents as string), refs: ((base.sourceRefs as string[]) ?? []).join(", ")
        }))));
      model.setProperty("/distributionWarnings", body.distribution.categories.filter((row: Record<string, unknown>) => row.blocker).map((row: Record<string, unknown>) => `${row.category}: ${row.blocker}`).map((text: string) => ({ text })));
      model.setProperty("/distributionTotals", {
        difference: formatMoney(total.totalDifferenceCents), allocated: formatMoney(total.totalAllocatedCents), residual: formatMoney(total.residualCents)
      });
      model.setProperty("/hasResult", true);
    } catch (error) {
      MessageBox.error(error instanceof Error ? error.message : "Falha na leitura SAP.");
    } finally { model.setProperty("/busy", false); }
  }

  private orderNumbers(value: unknown): string[] {
    return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  }

  public onBack(): void { (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggf"); }
}
