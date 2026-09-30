import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import type Page from "sap/m/Page";
import type { ListBase$ItemPressEvent } from "sap/m/ListBase";
import type { Router$BeforeRouteMatchedEvent } from "sap/ui/core/routing/Router";
import { isDevelopmentMode, isSapReadMode } from "../../../core/config/runtime";
import type { RevaluationPreview, PreviewStatus } from "../service/RevaluationPreview";
import { simulateMaterialRevaluation, pendingPayloadEvidence } from "../service/MaterialRevaluationPayload";
import { exportRevaluationCsv } from "../service/revaluationExport";

const statuses: Record<PreviewStatus, string> = {
  READY: "Pronto para reavaliação", NO_STOCK: "Sem estoque disponível", INSUFFICIENT_STOCK: "Estoque insuficiente",
  NEGATIVE_STOCK: "Estoque negativo", SPECIFIC_METHOD: "Método exige tratamento específico", MISSING_DATA: "Dados insuficientes", INCONSISTENT: "Bloqueado por inconsistência"
};
const reasons: Record<string, string> = {
  originMismatch: "Composição, recebimentos ou GGF não conciliam com a OP.", negativeStock: "Saldo atual negativo.",
  noStock: "Não há saldo no depósito.", insufficientStock: "O saldo é menor que a produção selecionada.",
  specificMethod: "Método de avaliação, lote ou série exige tratamento específico.", companyScope: "Avaliação por empresa exige tratamento entre depósitos.",
  multipleWarehouses: "Produção em múltiplos depósitos exige conciliação própria antes da proposta.",
  missingCostOrSource: "Falta comprovar custo, unidade ou origem completa.", negativeCost: "O custo não pode ficar negativo.",
  lockedWarehouse: "Depósito do item bloqueado ou situação desconhecida.", remainingUnproven: "Quantidade remanescente desta OP não comprovada.",
  remainingExceedsStock: "Quantidade elegível excede produção ou estoque.", noEligibleStock: "Não há produção elegível remanescente.",
  functionalPending: "Conta e regra funcional de GGF ainda não aprovadas para reavaliação.",
  stockTreatmentPending: "Tratamento do GGF sobre o saldo inteiro do item ainda não definido.",
  accountsPending: "Contas de contrapartida não verificadas.", postingDatePending: "Data contábil ainda não definida.",
  sharedStock: "OPs compartilham um saldo insuficiente; não há reserva de estoque por OP.",
  payloadPrecision: "Preço com seis casas não reproduz o valor desejado em centavos.",
  orderChanged: "A OP mudou ou não está encerrada.", receiptChanged: "Recebimento não corresponde à apuração.", quantityChanged: "Quantidade da OP difere da apuração."
};
const display = (value: string | null | undefined, decimals = 6) => value == null ? "Não comprovado" : new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: decimals }).format(Number(value));
const displayMinor = (value: string | null | undefined) => value == null ? "Não comprovado" : display(String(Number(value) / 100), 2);

interface FifoTechnicalTrace {
  origin: "sap"; technicalOnly: true; scenario: string; capturedAt: string;
  order: string; item: string; itemName: string; warehouse: string; unit: string;
  produced: string; originalLayerQuantity: string; consumed: string; remaining: string;
  status: string; receipt: { docEntry: number; docNum: number; line: number; date: string; quantity: number };
  layer: { label: string; openQty: number; cost: number };
  issues: Array<{ docEntry: number; docNum: number; line: number; date: string; quantity: number }>;
  example: { label: string; ggfTotalMinor: string; ggfUnitMinor: string;
    stockMinor: string; consumedMinor: string; stockStatus: string; consumedStatus: string };
  payload: null;
}

/** @namespace factoreone.app.modules.ggf.controller */
export default class Revaluation extends Controller {
  private model = new JSONModel();
  private revision = 0;
  private abort?: AbortController;
  private preview?: RevaluationPreview;

  public override onInit(): void {
    this.model.setSizeLimit(10000);
    this.getView()!.setModel(this.model, "preview");
    this.byId("previewDetails")!.addEventDelegate({ onAfterRendering: () => {
      if (this.model.getProperty("/selected")) (this.byId("revaluationPage") as Page).scrollToElement(this.byId("previewDetails")!, 0);
    }});
    const router = (this.getOwnerComponent() as UIComponent).getRouter();
    router.getRoute("ggfRevaluation")!.attachPatternMatched(this.onLoad, this);
    router.attachBeforeRouteMatched(this.onLeaving, this);
  }
  private onLeaving(event: Router$BeforeRouteMatchedEvent): void {
    if (event.getParameter("name") !== "ggfRevaluation") {
      this.revision++; this.abort?.abort(); this.preview = undefined;
      this.model.setData({ busy: false, available: false, rows: [], fifoRows: [], fifoTrace: null });
      (this.getOwnerComponent()!.getModel("ggfRevaluation") as JSONModel | undefined)?.setData({});
    }
  }
  public async onLoad(): Promise<void> {
    const revision = ++this.revision;
    this.abort?.abort(); this.abort = new AbortController(); this.preview = undefined;
    this.model.setData({ busy: false, available: false, sap: isSapReadMode(), development: isDevelopmentMode() && !isSapReadMode(), rows: [], fifoRows: [], fifoTrace: null, error: "", selected: null });
    try {
      if (!isDevelopmentMode()) throw new Error("Prévia indisponível neste ambiente. Contabilização bloqueada.");
      let result: RevaluationPreview & {documentSimulation?: ReturnType<typeof simulateMaterialRevaluation>;
        fifoTechnicalTrace?: FifoTechnicalTrace | null; fifoTechnicalError?: string | null};
      if (isSapReadMode()) {
        this.model.setProperty("/busy", true);
        const response = await fetch("/__ggf/revaluation", { headers: { "X-FactoryOne-Read": "1" }, cache: "no-store", signal: this.abort.signal });
        if (!response.ok) throw new Error("Leitura SAP interrompida. Nenhuma prévia parcial publicada.");
        result = await response.json() as RevaluationPreview;
        if (result.origin !== "sap" || result.company !== "SBODEMOBR2" || result.postingBlocked !== true) throw new Error("Origem da prévia incompatível.");
      } else {
        result = (this.getOwnerComponent()!.getModel("ggfRevaluation") as JSONModel | undefined)?.getProperty("/result") as RevaluationPreview;
        if (!result || result.origin !== "development") throw new Error("Nenhuma simulação local disponível. Retorne ao fechamento e simule o rateio.");
      }
      if (revision !== this.revision) return;
      // Legacy/development previews without document attestations are never executable documents.
      const documentSimulation = result.documentSimulation ?? simulateMaterialRevaluation(result, pendingPayloadEvidence(result));
      result = { ...result, documentSimulation, payload: documentSimulation.payload,
        payloadReady: documentSimulation.status === "APTO" && documentSimulation.payload !== null };
      const fifo = result.fifoTechnicalTrace;
      if (fifo && (result.origin !== "sap" || fifo.origin !== "sap" || fifo.technicalOnly !== true ||
          fifo.payload !== null || fifo.status !== "FIFO_PARTIALLY_CONSUMED" ||
          !Array.isArray(fifo.issues) || fifo.issues.length !== 1))
        throw new Error("Rastreabilidade FIFO técnica incompatível com a origem da prévia.");
      this.preview = result;
      const rows = result.rows.map(r => ({ ...r, statusText: r.status === "READY" && !result.payloadReady ? "Prévia de custo calculada" : statuses[r.status], documentStatus: result.documentSimulation?.rows.find(d=>d.orderId===r.orderId && d.key===`${r.item}/${r.warehouse}`)?.status ?? "", state: r.status === "READY" && result.payloadReady ? "Success" : "Warning",
        methodText: ({ bis_MovingAverage: "Média móvel", bis_Standard: "Padrão", bis_FIFO: "FIFO", bis_SNB: "Série / lote" } as Record<string,string>)[r.method] ?? r.method,
        reasonsText: r.reasons.map(k => reasons[k] ?? k).join(" "),
        values: Object.fromEntries(["planned","produced","stock","eligible","currentCost","ggf","unitGgf","adjustedCost","estimated","materials","resources","original","adjustedHistoricalTotal","naivePriceChangeImpact"].map(k => [k, display(r[k as keyof typeof r] as string | null)])),
        accounts: r.accounts.map(a => ({...a, displayAmount: display(a.amount, 2)})) }));
      this.model.setData({ busy: false, available: true, sap: isSapReadMode(), development: !isSapReadMode(), error: "", rows, selected: null,
        fifoTechnicalError: result.fifoTechnicalError ?? "",
        fifoRows: fifo ? [{...fifo,producedText:display(fifo.produced),originalText:display(fifo.originalLayerQuantity),
          consumedText:display(fifo.consumed),remainingText:display(fifo.remaining)}] : [],
        fifoTrace: fifo ? { ...fifo, producedText: display(fifo.produced), originalText: display(fifo.originalLayerQuantity),
          consumedText: display(fifo.consumed), remainingText: display(fifo.remaining),
          unitGgfText: displayMinor(fifo.example.ggfUnitMinor), stockGgfText: displayMinor(fifo.example.stockMinor),
          consumedGgfText: displayMinor(fifo.example.consumedMinor),
          issueText: fifo.issues.map(row=>`Saída ${row.docNum} / linha ${row.line}: ${display(String(row.quantity))} ${fifo.unit}`).join("; ") } : null,
        company: result.company, allocationDate: new Date(result.allocationDate).toLocaleString("pt-BR"), stockDate: new Date(result.stockDate).toLocaleString("pt-BR"),
        total: display(result.totalGgf, 2), estimated: display(result.estimatedTotal, 2),
        technical: result.technicalOnly, payloadReady: result.payloadReady,
        payload: (result.documentSimulation ? result.documentSimulation.payload : result.payload) ? JSON.stringify(result.documentSimulation ? result.documentSimulation.payload : result.payload,null,2) : "Documento incompleto: consulte os bloqueios por OP. Nenhum payload executável foi gerado.",
        scopes: result.scopes.map(s => ({ ...s, price: display(s.targetPrice), amount: display(s.estimate,2) })) });
    } catch (error) {
      if (revision === this.revision) this.model.setProperty("/error", error instanceof Error ? error.message : "Prévia indisponível.");
    } finally { if (revision === this.revision) this.model.setProperty("/busy", false); }
  }
  public onDetails(event: ListBase$ItemPressEvent): void {
    this.model.setProperty("/selected", event.getParameter("listItem")!.getBindingContext("preview")!.getObject());
    requestAnimationFrame(() => {
      if (this.model.getProperty("/selected")) (this.byId("revaluationPage") as Page).scrollToElement(this.byId("previewDetails")!, 0);
    });
  }
  public onCloseDetails(): void { this.model.setProperty("/selected", null); }
  public onBack(): void { (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggfClosing"); }
  public onMenu(): void { (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggf"); }
  public onJson(): void { if (this.preview) this.download(JSON.stringify(this.preview,null,2), "json", "application/json"); }
  public onCsv(): void { if (this.preview) this.download(exportRevaluationCsv(this.preview), "csv", "text/csv;charset=utf-8"); }
  private download(contents: string, extension: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([contents], {type:mime}));
    const link = document.createElement("a"); link.href=url; link.download=`GGF-REVALUATION-${this.preview!.origin}.${extension}`;
    link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  public override onExit(): void {
    this.revision++; this.abort?.abort();
    const router = (this.getOwnerComponent() as UIComponent).getRouter();
    router.getRoute("ggfRevaluation")?.detachPatternMatched(this.onLoad,this);
    router.detachBeforeRouteMatched(this.onLeaving,this);
  }
}
