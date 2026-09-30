import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import TextArea from "sap/m/TextArea";
import { isSapReadMode } from "../../../core/config/runtime";
import { buildAccountingPreview, type AccountingPreviewConfig, type AccountingPreviewLineInput } from "../service/AccountingPreview";
import type Event from "sap/ui/base/Event";

const CONFIG_KEY = "factoryone.ggf.v2.absorption.mapping";
const ACCOUNTING_CONFIG_KEY = "factoryone.ggf.v2.absorption.accounting";
const emptyMapping = JSON.stringify({ accounts: [], resources: [], technicalHomologation: true }, null, 2);
const emptyAccountingConfig = JSON.stringify({ transitoryGgfAccount: "", transitoryModAccount: "",
  closingGgfAccount: "", closingModAccount: "", cpvAccount: "", inventoryAccounts: {},
  dimensionsByLine: {}, cpvEligibleOperationKeys: [], requireDimensions: true }, null, 2);

/** @namespace factoreone.app.modules.ggf.controller */
export default class AbsorptionV2 extends Controller {
  public override onInit(): void {
    this.getView()!.setModel(new ResourceModel({
      bundleName: "factoreone.app.modules.ggf.i18n.i18n", supportedLocales: [""], fallbackLocale: ""
    }), "ggfText");
    let mapping = emptyMapping;
    try { mapping = localStorage.getItem(CONFIG_KEY) ?? emptyMapping; } catch { /* Storage can be disabled. */ }
    let accountingConfig = emptyAccountingConfig;
    try { accountingConfig = localStorage.getItem(ACCOUNTING_CONFIG_KEY) ?? emptyAccountingConfig; } catch { /* Local configuration is optional. */ }
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
      accountingConfig,
      busy: false, hasResult: false, report: null, entries: [], resources: [],
      summary: [], completeness: [], evidence: "", distribution: null, distributionCategories: [],
      distributionOrders: [], distributionBases: [], distributionWarnings: [],
      stockConsumptionOrders: [], fifoScenario: null, accountingPreview: null, technicalAccountingPreview: null
    }), "v2");
  }

  public onMappingChange(event: Event): void {
    const value = (event.getSource() as TextArea).getValue();
    try { localStorage.setItem(CONFIG_KEY, value); } catch { /* Local configuration is optional. */ }
  }

  public onAccountingConfigChange(event: Event): void {
    const value = (event.getSource() as TextArea).getValue();
    try { localStorage.setItem(ACCOUNTING_CONFIG_KEY, value); } catch { /* Local configuration is optional. */ }
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
    let accountingConfig: AccountingPreviewConfig;
    try { accountingConfig = JSON.parse(model.getProperty("/accountingConfig") as string) as AccountingPreviewConfig; }
    catch { MessageBox.error("A parametrização contábil local não é um JSON válido."); return; }
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
      const stockConsumption = body.stockConsumption;
      const statusText: Record<string, string> = {
        BLOCKED_STOCK_NEGATIVE: "Estoque negativo",
        BLOCKED_AMBIGUOUS_TRACE: "Rastreio ambíguo",
        STOCK_REVALUATION_CANDIDATE: "Candidato a reavaliação de estoque",
        CPV_ADJUSTMENT_CANDIDATE: "Candidato a ajuste de CPV",
        CONSUMPTION_UNCLASSIFIED: "Consumo sem classificação contábil",
        BLOCKED_METHOD_NOT_HOMOLOGATED: "Método não homologado"
      };
      model.setProperty("/stockConsumptionOrders", (stockConsumption?.orders ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        statusText: statusText[String(row.status)] ?? String(row.status ?? "Sem evidência"),
        producedText: row.producedQuantity == null ? "Não comprovada" : `${row.producedQuantity} ${row.unit ?? ""}`.trim(),
        modAdjustment: row.modAdjustmentCents == null ? "Não disponível" : formatMoney(String(row.modAdjustmentCents)),
        ggfAdjustment: row.ggfAdjustmentCents == null ? "Não disponível" : formatMoney(String(row.ggfAdjustmentCents)),
        modStock: "Bloqueado", modConsumed: "Bloqueado", ggfStock: "Bloqueado", ggfConsumed: "Bloqueado",
        stock: row.quantityOnStock == null ? "Não disponível" : String(row.quantityOnStock),
        warehouseText: ((row.warehouses as Array<Record<string, unknown>>) ?? []).map((warehouse) =>
          `${warehouse.code}: ${warehouse.quantity} ${row.unit ?? ""} (disponível ${warehouse.available ?? "não comprovada"})`).join(" · ") || "Depósito não comprovado",
        valuationMethodText: String(row.valuationMethod ?? "Não disponível")
      })));
      const configuredMapping = mapping as { accounts?: Array<{ account: string; category: "MOD" | "GGF" }> };
      const categoryTotals = Object.fromEntries(report.reconciliation.map((row: Record<string, unknown>) =>
        [String(row.category), String(row.differenceCents)])) as Record<"MOD" | "GGF", string>;
      const reviewByOrder = new Map<string, Record<string, unknown>>(
        ((stockConsumption?.orders ?? []) as Array<Record<string, unknown>>).map(row => [String(row.orderNumber), row])
      );
      const accountingLines: AccountingPreviewLineInput[] = [];
      for (const order of body.distribution.orders as Array<Record<string, unknown>>) {
        const review = reviewByOrder.get(String(order.orderNumber));
        for (const category of ["MOD", "GGF"] as const) {
          const amount = String(category === "MOD" ? order.modAdjustmentCents : order.ggfAdjustmentCents);
          if (amount === "0") continue;
          const basis = (order.bases as Array<Record<string, unknown>>).find(row => row.category === category);
          const determination = review?.accountingDetermination as AccountingPreviewLineInput["inventoryAccountFromSap"] | undefined;
          accountingLines.push({
            closingId: null, version: null, orderNumber: String(order.orderNumber), item: String(order.item),
            warehouse: null, category, accountOriginal: configuredMapping.accounts?.find(row => row.category === category)?.account ?? null,
            criterion: basis ? String(basis.criterion) : null, quantity: review?.producedQuantity == null ? null : String(review.producedQuantity),
            unit: review?.unit == null ? null : String(review.unit), amountCents: amount,
            stockCents: review?.[category === "MOD" ? "modStockCents" : "ggfStockCents"] == null ? null : String(review[category === "MOD" ? "modStockCents" : "ggfStockCents"]),
            consumedCents: review?.[category === "MOD" ? "modConsumedCents" : "ggfConsumedCents"] == null ? null : String(review[category === "MOD" ? "modConsumedCents" : "ggfConsumedCents"]),
            stockTraceStatus: String(review?.status ?? "BLOCKED_AMBIGUOUS_TRACE"),
            valuationMethod: review?.valuationMethod == null ? null : String(review.valuationMethod),
            inventoryAccountFromSap: determination,
            consumedOperationKey: null,
            sourceRefs: ((order.bases as Array<Record<string, unknown>>).filter(row => row.category === category)
              .flatMap(row => row.sourceRefs as string[] ?? []))
          });
        }
      }
      const accounting = buildAccountingPreview({ MOD: categoryTotals.MOD ?? "0", GGF: categoryTotals.GGF ?? "0" }, accountingLines, accountingConfig);
      const formattedAccounting = this.formatAccountingPreview(accounting, formatMoney);
      model.setProperty("/accountingPreview", formattedAccounting);
      const fifo = stockConsumption?.fifoScenario;
      if (fifo?.calculation?.totalStockCents != null && fifo?.calculation?.totalConsumedCents != null) {
        const technicalTotal = String(fifo.example?.ggfTotalMinor ?? "0");
        const technicalLine: AccountingPreviewLineInput = {
          closingId: null, version: null, orderNumber: String(fifo.order), item: String(fifo.item),
          warehouse: String(fifo.warehouse), category: "GGF", accountOriginal: null, criterion: null,
          quantity: String(fifo.produced), unit: String(fifo.unit), amountCents: technicalTotal,
          stockCents: String(fifo.calculation.totalStockCents), consumedCents: String(fifo.calculation.totalConsumedCents),
          stockTraceStatus: String(fifo.calculation.status), valuationMethod: String(fifo.valuationMethod ?? "bis_FIFO"),
          consumedOperationKey: `InventoryGenExits:${fifo.issues?.[0]?.docEntry}/${fifo.issues?.[0]?.line}`,
          sourceRefs: [`ProductionOrders(${fifo.order})`, `InventoryGenEntries(${fifo.receipt?.docEntry})/${fifo.receipt?.line}`,
            ...(fifo.issues ?? []).map((issue: Record<string, unknown>) => `InventoryGenExits(${issue.docEntry})/${issue.line}`)]
        };
        const demo = buildAccountingPreview({ MOD: "0", GGF: technicalTotal }, [technicalLine], accountingConfig);
        model.setProperty("/technicalAccountingPreview", this.formatAccountingPreview(demo, formatMoney));
      } else model.setProperty("/technicalAccountingPreview", null);
      model.setProperty("/fifoScenario", fifo ? {
        ...fifo,
        producedText: fifo.produced ? `${fifo.produced} ${fifo.unit}` : "Não disponível",
        consumedText: fifo.consumed ? `${fifo.consumed} ${fifo.unit}` : "Não disponível",
        remainingText: fifo.remaining ? `${fifo.remaining} ${fifo.unit}` : "Não disponível",
        stockAmount: fifo.calculation?.totalStockCents == null ? "Não disponível" : formatMoney(fifo.calculation.totalStockCents),
        consumedAmount: fifo.calculation?.totalConsumedCents == null ? "Não disponível" : formatMoney(fifo.calculation.totalConsumedCents),
        methodText: fifo.item ? `${fifo.item} · FIFO` : "FIFO não comprovado",
        receiptText: fifo.receipt ? `InventoryGenEntries(${fifo.receipt.docEntry}) linha ${fifo.receipt.line} · ${fifo.receipt.date} · ${fifo.receipt.quantity} ${fifo.unit}` : "Recebimento não comprovado",
        outflowText: fifo.issues?.map((issue: Record<string, unknown>) => `InventoryGenExits(${issue.docEntry}) linha ${issue.line ?? 0} · ${issue.date} · ${issue.quantity} ${fifo.unit}`).join("; ") ?? "Saídas não reconciliadas",
        layerText: fifo.layer ? `${fifo.layer.label} · sequência ${fifo.layer.sequence} / camada ${fifo.layer.id} · aberto ${fifo.layer.openQty} · custo corrente ${fifo.layer.cost}` : "Camada não comprovada",
        splitStatusText: statusText[fifo.calculation?.status] ?? String(fifo.status ?? "Rastreio não comprovado"),
        consumedStatusText: statusText[fifo.calculation?.consumedStatus] ?? "Consumo sem classificação contábil",
        splitReason: fifo.calculation?.reason ?? fifo.reason ?? "Sem evidência suficiente."
      } : null);
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

  private formatAccountingPreview(preview: ReturnType<typeof buildAccountingPreview>, formatMoney: (value: string) => string) {
    return {
      ...preview,
      summaries: preview.summaries.map(row => ({ ...row, toAbsorb: formatMoney(row.toAbsorbCents), stock: formatMoney(row.stockCents),
        cpv: formatMoney(row.cpvCents), blocked: formatMoney(row.blockedCents), difference: formatMoney(row.differenceCents) })),
      rows: preview.rows.map(row => ({ ...row, total: row.totalCents == null ? "—" : formatMoney(row.totalCents),
        stock: row.stockCents == null ? "—" : formatMoney(row.stockCents), consumed: row.consumedCents == null ? "—" : formatMoney(row.consumedCents),
        accountingOriginText: row.inventoryAccountFromSap
          ? `${row.inventoryAccountFromSap.origin} · ${row.inventoryAccountFromSap.verified ? row.inventoryAccountFromSap.account : "não resolvida"}`
          : "Determinação SAP não comprovada",
        dimensionsText: row.dimensions.length ? row.dimensions.join(" / ") : "Dimensões não configuradas",
        statusText: this.accountingStatusText(String(row.status)),
        reasonsText: row.reasons.map(reason => this.accountingStatusText(reason)).join(" · ") || "Sem bloqueios" })),
      totals: { ...preview.totals, toAbsorb: formatMoney(preview.totals.toAbsorbCents), stock: formatMoney(preview.totals.stockCents),
        cpv: formatMoney(preview.totals.cpvCents), blocked: formatMoney(preview.totals.blockedCents), difference: formatMoney(preview.totals.differenceCents),
        debits: formatMoney(preview.totals.debitsCents), credits: formatMoney(preview.totals.creditsCents), accountingDifference: formatMoney(preview.totals.accountingDifferenceCents) },
      documents: preview.documents.map(doc => ({ ...doc, statusText: doc.status === "PREVIEW_ONLY" ? "Prévia sem payload" : "Bloqueado",
        debits: formatMoney(doc.debitsCents), credits: formatMoney(doc.creditsCents),
        lines: doc.lines.map(row => ({ ...row, amount: formatMoney(row.amountCents) })) }))
    };
  }

  private accountingStatusText(status: string): string {
    return ({
      READY_FOR_STOCK_REVALUATION: "Pronto para prévia de reavaliação",
      READY_FOR_CPV_ADJUSTMENT: "Pronto para prévia de CPV",
      ACCOUNTING_CONFIG_INCOMPLETE: "Parametrização contábil incompleta",
      CPV_ACCOUNTING_NOT_CONFIGURED: "Conta CPV não configurada",
      STOCK_TRACE_INCOMPLETE: "Rastreio de estoque incompleto",
      CPV_CLASSIFICATION_MISSING: "Classificação de CPV ausente",
      NEGATIVE_STOCK: "Estoque negativo",
      VALUATION_METHOD_NOT_HOMOLOGATED: "Método de avaliação não homologado",
      BLOCKED: "Bloqueado"
    } as Record<string, string>)[status] ?? status;
  }

  public onBack(): void { (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggf"); }
}
