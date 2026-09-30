import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import MessageToast from "sap/m/MessageToast";
import Device from "sap/ui/Device";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import type JSONListBinding from "sap/ui/model/json/JSONListBinding";
import type List from "sap/m/List";
import type { ListBase$SelectionChangeEvent, ListBase$ItemPressEvent } from "sap/m/ListBase";
import type { SearchField$LiveChangeEvent } from "sap/m/SearchField";
import type Page from "sap/m/Page";
import type Wizard from "sap/m/Wizard";
import type { Wizard$NavigationChangeEvent } from "sap/m/Wizard";
import type { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import type { Router$BeforeRouteMatchedEvent } from "sap/ui/core/routing/Router";
import type Event from "sap/ui/base/Event";
import type Control from "sap/ui/core/Control";
import { isDevelopmentMode, isSapReadMode } from "../../../core/config/runtime";
import { formatDecimal } from "../../../core/util/money";
import { PRODUCT_DISPLAY_NAME } from "../../../core/config/product";
import { GgfError, validateConfiguration, validatePeriod } from "../engine/allocation";
import { CRITERIA, type Configuration, type PeriodFilter } from "../engine/types";
import { DevelopmentGgfRepository } from "../development/DevelopmentGgfRepository";
import { demoConfiguration } from "../development/fixtures";
import { ClosingSession } from "../service/ClosingSession";
import { exportCsv } from "../service/export";
import { previewRevaluation } from "../service/RevaluationPreview";
import { demoRevaluationInput } from "../development/revaluation";

type Texts = { getText(key: string, args?: string[]): string };
type RecordKind = "classifications" | "accounts";
const FUNCTION_ROUTES = {
  ggfClosing: "closing",
  ggfClassifications: "classifications",
  ggfAllocations: "allocations"
} as const;

function emptyCalculation() {
  return {
    busy: false,
    calculated: false,
    error: "",
    step: "1",
    total: "",
    distributed: "",
    difference: "",
    snapshotId: "",
    orders: [],
    traces: [],
    accountMemory: [],
    costComponents: [],
    balances: [],
    groupBases: [],
    criterionTotals: [],
    sapReport: null,
    integrityStatus: "NOT_APPLICABLE",
    integrityBusy: false,
    integrityReport: null,
    integrityDetectedAt: "",
    integrityDocument: ""
  };
}

/** @namespace factoreone.app.modules.ggf.controller */
export default class Closing extends Controller {
  private model = new JSONModel();
  private texts?: Texts;
  private repository?: DevelopmentGgfRepository;
  private session?: ClosingSession;
  private calculationRevision = 0;
  private integrityRevision = 0;

  public override onInit(): void {
    const i18n = new ResourceModel({
      bundleName: "factoreone.app.modules.ggf.i18n.i18n",
      supportedLocales: [""],
      fallbackLocale: ""
    });
    this.getView()!.setModel(i18n, "ggfText");
    this.model.setSizeLimit(10000);
    this.model.setData({
      product: PRODUCT_DISPLAY_NAME,
      development: isDevelopmentMode() && !isSapReadMode(),
      sapRead: isSapReadMode(),
      ready: false,
      workspace: "closing",
      dirty: false,
      narrow: Device.resize.width <= 600,
      detailOpen: false,
      classificationsSelected: false,
      accountsSelected: false,
      classificationsSearch: "",
      accountsSearch: "",
      ...emptyCalculation(),
      config: { classifications: [], accounts: [], groupShares: [] },
      filter: {
        start: "2026-09-01",
        end: "2026-09-30",
        branch: "DEV-01",
        costCenter: ""
      },
      criteria: [],
      branches: [],
      costCenters: [],
      resourceGroups: [],
      closingId: ""
    });
    this.getView()!.setModel(this.model, "ggf");
    Device.resize.attachHandler(this.onResize, this);
    const router = (this.getOwnerComponent() as UIComponent).getRouter();
    for (const name of Object.keys(FUNCTION_ROUTES))
      router.getRoute(name)!.attachPatternMatched(this.onFunctionMatched, this);
    router.attachBeforeRouteMatched(this.onBeforeRouteMatched, this);
    (this.byId("steps") as Wizard).addEventDelegate({
      onAfterRendering: () => {
        const wizard = this.byId("steps") as Wizard;
        const step = wizard.getSteps()[Number(this.model.getProperty("/step")) - 1];
        if (step) wizard.goToStep(step, false);
      }
    });
    void this.initialize(i18n);
  }
  private async initialize(i18n: ResourceModel): Promise<void> {
    this.texts = (await i18n.getResourceBundle()) as Texts;
    if (!isDevelopmentMode()) return;
    if (isSapReadMode()) {
      this.model.setProperty("/filter", {
        start: "2026-09-01",
        end: "2026-09-30",
        branch: "",
        costCenter: ""
      });
      this.model.setProperty("/branches", [{ key: "", name: this.text("all") }]);
      this.model.setProperty("/costCenters", [{ key: "", name: this.text("all") }]);
      this.model.setProperty("/ready", this.model.getProperty("/workspace") === "closing");
      return;
    }
    try {
      this.repository = new DevelopmentGgfRepository(window.localStorage);
      this.session = new ClosingSession(this.repository);
      const catalog = await this.repository.getCatalog();
      this.model.setProperty(
        "/criteria",
        CRITERIA.map((key) => ({ key, name: this.text(`criterion_${key}`) }))
      );
      for (const field of ["branches", "costCenters"] as const)
        this.model.setProperty(`/${field}`, [
          { key: "", name: this.text("all") },
          ...catalog[field].map((key) => ({ key, name: key }))
        ]);
      this.model.setProperty(
        "/resourceGroups",
        catalog.resourceGroups.map((key) => ({ key, name: key }))
      );
      this.model.setProperty("/ready", true);
      this.model.setProperty("/config", await this.repository.loadConfiguration());
      this.filterRecords("classifications", "");
      this.filterRecords("accounts", "");
    } catch (error) {
      this.showError(error);
    }
  }
  private text(key: string, args?: string[]): string {
    return this.texts?.getText(key, args) ?? key;
  }
  private showError(error: unknown): void {
    this.model.setProperty(
      "/error",
      error instanceof GgfError
        ? this.text(`error_${error.code}`, error.details)
        : this.text("error_unexpected", [error instanceof Error ? error.message : String(error)])
    );
    (this.byId("closingPage") as Page).scrollTo(0, 0);
  }
  public onHome(): void {
    (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggf");
  }
  private onFunctionMatched(event: Route$PatternMatchedEvent): void {
    const name = event.getParameter("name") as keyof typeof FUNCTION_ROUTES;
    this.model.setProperty("/workspace", FUNCTION_ROUTES[name]);
    this.model.setProperty("/detailOpen", false);
    this.onEdit();
    if (isSapReadMode()) this.model.setProperty("/ready", FUNCTION_ROUTES[name] === "closing");
    (this.byId("closingPage") as Page).scrollTo(0, 0);
  }
  private onBeforeRouteMatched(event: Router$BeforeRouteMatchedEvent): void {
    if (!(event.getParameter("name")! in FUNCTION_ROUTES)) this.onEdit();
  }
  public onConfigurationEdit(): void {
    this.model.setProperty("/dirty", true);
    this.onEdit();
  }
  private onResize(event: { width: number }): void {
    this.model.setProperty("/narrow", event.width <= 600);
  }
  public criterionName(criterion: string): string {
    return this.text(`criterion_${criterion}`);
  }
  private selectRecord(kind: RecordKind, path?: string, open = false): void {
    const detail = this.byId(`${kind}Detail`)!;
    if (path) detail.bindElement({ path, model: "ggf" });
    else detail.unbindElement("ggf");
    this.model.setProperty(`/${kind}Selected`, !!path);
    this.model.setProperty("/detailOpen", open && !!path);
    const list = this.byId(kind) as List;
    list.removeSelections(true);
    const item = list.getItems().find((item) => item.getBindingContext("ggf")?.getPath() === path);
    if (item) list.setSelectedItem(item);
  }
  private filterRecords(kind: RecordKind, query: string, selectedPath?: string): void {
    this.model.setProperty(`/${kind}Search`, query);
    const fields =
      kind === "classifications" ? ["id", "name"] : ["account", "name", "classificationId"];
    const binding = (this.byId(kind) as List).getBinding("items") as JSONListBinding;
    binding.filter(
      query.trim()
        ? [
            new Filter({
              filters: fields.map(
                (field) => new Filter(field, FilterOperator.Contains, query.trim())
              ),
              and: false
            })
          ]
        : []
    );
    this.selectRecord(
      kind,
      selectedPath ?? binding.getContexts(0, 1)[0]?.getPath(),
      !!selectedPath
    );
  }
  public onClassificationSearch(event: SearchField$LiveChangeEvent): void {
    this.filterRecords("classifications", event.getParameter("newValue") ?? "");
  }
  public onAccountSearch(event: SearchField$LiveChangeEvent): void {
    this.filterRecords("accounts", event.getParameter("newValue") ?? "");
  }
  public onRecordSelect(event: ListBase$SelectionChangeEvent | ListBase$ItemPressEvent): void {
    const path = event.getParameters().listItem?.getBindingContext("ggf")?.getPath();
    if (!path) return;
    const kind = path.split("/")[2] as RecordKind;
    this.selectRecord(kind, path, true);
    if (this.model.getProperty("/narrow")) (this.byId("closingPage") as Page).scrollTo(0, 0);
  }
  public onRecordList(): void {
    this.model.setProperty("/detailOpen", false);
    (this.byId("closingPage") as Page).scrollTo(0, 0);
  }
  public onEdit(): void {
    this.calculationRevision++;
    this.integrityRevision++;
    this.session?.invalidate();
    this.model.setData({ ...this.model.getData(), ...emptyCalculation() });
    const wizard = this.byId("steps") as Wizard;
    if (wizard.getProgress() > 1) wizard.discardProgress(wizard.getSteps()[0]!, false);
  }
  public override onExit(): void {
    Device.resize.detachHandler(this.onResize, this);
    this.calculationRevision++;
    this.integrityRevision++;
    this.session?.invalidate();
    const router = (this.getOwnerComponent() as UIComponent).getRouter();
    for (const name of Object.keys(FUNCTION_ROUTES))
      router.getRoute(name)!.detachPatternMatched(this.onFunctionMatched, this);
    router.detachBeforeRouteMatched(this.onBeforeRouteMatched, this);
  }
  public async onCalculate(): Promise<void> {
    if (isSapReadMode()) return this.onReadSap();
    if (!this.session) return;
    this.onEdit();
    const revision = this.calculationRevision;
    this.model.setProperty("/busy", true);
    try {
      const result = await this.session.calculate(
        this.model.getProperty("/config") as Configuration,
        this.model.getProperty("/filter") as PeriodFilter
      );
      if (revision !== this.calculationRevision || !result) return;
      this.model.setProperty(
        "/criterionTotals",
        result.criteria.map((c) => ({
          name: this.text(`criterion_${c.criterion}`),
          amount: formatDecimal(c.amount)
        }))
      );
      this.model.setProperty(
        "/balances",
        result.snapshot.balances.map((b) => ({
          ...b,
          name: result.configuration.accounts.find((a) => a.account === b.account)!.name,
          refs: b.sourceRefs.join(", ")
        }))
      );
      this.model.setProperty(
        "/orders",
        result.orders.map((o) => ({
          ...o.order,
          allocated: formatDecimal(o.allocated),
          current: o.current === null ? this.text("basisUnavailable") : formatDecimal(o.current),
          resulting:
            o.resulting === null ? this.text("basisUnavailable") : formatDecimal(o.resulting)
        }))
      );
      this.model.setProperty(
        "/groupBases",
        result.orders.flatMap((o) =>
          Object.entries(o.order.groupHours).map(([group, hours]) => ({
            order: o.order.number,
            group,
            hours
          }))
        )
      );
      this.model.setProperty(
        "/traces",
        result.traces.map((t) => ({
          ...t,
          criterion: this.text(`criterion_${t.criterion}`),
          order: result.snapshot.orders.find((o) => o.id === t.orderId)!.number,
          accountAmount: formatDecimal(t.accountAmount),
          applicableAmount: formatDecimal(t.applicableAmount),
          accountRoundingNumerator: `${t.accountRoundingNumerator}/10000`,
          groupRoundingMinor: String(t.groupRoundingMinor),
          groupRemainder: `${t.groupRemainder}/10000`,
          poolAmount: formatDecimal(t.poolAmount),
          basis: formatDecimal(t.basis, t.basisDecimals),
          totalBasis: formatDecimal(t.totalBasis, t.basisDecimals),
          amount: formatDecimal(t.amount),
          roundingMinor: String(t.roundingMinor),
          remainder: `${t.remainder}/${t.totalBasis}`
        }))
      );
      this.model.setProperty(
        "/accountMemory",
        result.accounts.map((a) => ({
          account: a.account,
          percent: a.percent,
          periodAmount: formatDecimal(a.periodAmount),
          applicableAmount: formatDecimal(a.applicableAmount),
          rounding: `${a.roundingNumerator}/10000`,
          distributed: formatDecimal(a.distributed),
          difference: formatDecimal(a.difference)
        }))
      );
      this.model.setProperty(
        "/costComponents",
        result.orders.flatMap(({ order }) =>
          (order.directCostComponents ?? []).map((c) => ({
            ...c,
            order: order.number,
            refs: c.sourceRefs.join(", ")
          }))
        )
      );
      for (const key of ["total", "distributed", "difference"] as const)
        this.model.setProperty(`/${key}`, formatDecimal(result[key]));
      this.model.setProperty("/snapshotId", result.snapshot.id);
      this.model.setProperty("/calculated", true);
    } catch (error) {
      if (revision === this.calculationRevision) this.showError(error);
    } finally {
      if (revision === this.calculationRevision) this.model.setProperty("/busy", false);
    }
  }
  public async onInspectIntegrity(): Promise<void> {
    if (!isSapReadMode()) return;
    const id = String(this.model.getProperty("/closingId") ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(id)) {
      this.model.setProperty("/error", this.text("integrityInvalidId"));
      return;
    }
    const revision = ++this.integrityRevision;
    this.model.setProperty("/integrityStatus", "NOT_APPLICABLE");
    this.model.setProperty("/integrityReport", null);
    this.model.setProperty("/integrityBusy", true);
    this.model.setProperty("/error", "");
    try {
      const response = await fetch(`/__ggf/closing-integrity?${new URLSearchParams({ closingId: id })}`, {
        headers: { "X-FactoryOne-Read": "1" }, credentials: "omit", cache: "no-store"
      });
      if (response.status === 503) {
        const issue = await response.json().catch(() => null);
        if (issue?.code === "SAP_METADATA_UNAVAILABLE") {
          if (revision === this.integrityRevision)
            this.model.setProperty("/integrityStatus", "SAP_METADATA_UNAVAILABLE");
          return;
        }
      }
      if (response.status === 404) throw new Error(this.text("integrityNotFound"));
      if (!response.ok) throw new Error(this.text("integrityReadFailed"));
      const report = await response.json();
      if (report.closingId !== id || !["VALID", "INTEGRITY_VIOLATION", "NOT_APPLICABLE"].includes(report.status) ||
          !Array.isArray(report.divergentFields) || !Number.isSafeInteger(report.version) ||
          typeof report.closingStatus !== "string" ||
          !Number.isFinite(Date.parse(report.detectedAt)))
        throw new Error(this.text("integrityReadFailed"));
      if (revision !== this.integrityRevision) return;
      this.model.setProperty("/integrityStatus", report.status);
      this.model.setProperty("/integrityReport", report);
      this.model.setProperty("/integrityDetectedAt", new Date(report.detectedAt).toLocaleString("pt-BR"));
      this.model.setProperty("/integrityDocument", report.sapDocEntry === null ? "-" :
        `DocEntry ${report.sapDocEntry} / DocNum ${report.sapDocNum ?? "-"}`);
    } catch (error) {
      if (revision === this.integrityRevision) this.showError(error);
    } finally {
      if (revision === this.integrityRevision) this.model.setProperty("/integrityBusy", false);
    }
  }
  private async onReadSap(): Promise<void> {
    this.onEdit();
    const revision = this.calculationRevision;
    this.model.setProperty("/busy", true);
    try {
      const filter = this.model.getProperty("/filter") as PeriodFilter;
      validatePeriod(filter);
      if (filter.branch || filter.costCenter) throw new Error(this.text("sapReadScope"));
      const response = await fetch(
        `/__ggf/read?${new URLSearchParams({ start: filter.start, end: filter.end })}`,
        {
          headers: { "X-FactoryOne-Read": "1" },
          credentials: "omit",
          cache: "no-store"
        }
      );
      if (!response.ok) throw new Error(this.text("sapReadFailed"));
      const report = await response.json();
      if (
        report.origin !== "sap" ||
        report.company !== "SBODEMOBR2" ||
        report.allocationReady !== false ||
        report.postingBlocked !== true ||
        !Array.isArray(report.blockers) ||
        !Array.isArray(report.reads) ||
        !Array.isArray(report.accounts) ||
        !Array.isArray(report.differences) ||
        !report.journal ||
        report.filter?.start !== filter.start ||
        report.filter?.end !== filter.end ||
        report.filter?.branch !== "" ||
        report.filter?.costCenter !== ""
      )
        throw new Error(this.text("sapReadFailed"));
      if (revision !== this.calculationRevision) return;
      this.model.setProperty("/sapReport", report);
      this.model.setProperty("/error", report.blockers.join(" "));
    } catch (error) {
      if (revision === this.calculationRevision) this.showError(error);
    } finally {
      if (revision === this.calculationRevision) this.model.setProperty("/busy", false);
    }
  }
  public onNext(): void {
    if (!this.session?.result || this.model.getProperty("/busy")) return;
    this.navigateStep(Math.min(3, Number(this.model.getProperty("/step")) + 1));
  }
  public onPrevious(): void {
    this.navigateStep(Math.max(1, Number(this.model.getProperty("/step")) - 1));
  }
  private navigateStep(index: number): void {
    const wizard = this.byId("steps") as Wizard;
    this.model.setProperty("/step", String(index));
    if (index > wizard.getProgress()) wizard.nextStep();
    else wizard.goToStep(wizard.getSteps()[index - 1]!, true);
    (this.byId("closingPage") as Page).scrollTo(0, 0);
  }
  public onStepNavigation(event: Wizard$NavigationChangeEvent): void {
    const wizard = this.byId("steps") as Wizard;
    const step = event.getParameter("step");
    if (step) this.model.setProperty("/step", String(wizard.getSteps().indexOf(step) + 1));
  }
  public async onSave(): Promise<void> {
    if (!this.repository) return;
    this.onEdit();
    try {
      await this.repository.saveConfiguration(this.model.getProperty("/config") as Configuration);
      this.model.setProperty("/dirty", false);
      MessageToast.show(this.text("saved"));
    } catch (error) {
      this.showError(error);
    }
  }
  public onValidate(): void {
    try {
      validateConfiguration(this.model.getProperty("/config") as Configuration);
      this.model.setProperty("/error", "");
      MessageToast.show(this.text("valid"));
    } catch (error) {
      this.showError(error);
    }
  }
  public onReset(): void {
    this.onConfigurationEdit();
    const parts =
      this.model.getProperty("/workspace") === "classifications"
        ? (["classifications"] as const)
        : (["accounts", "groupShares"] as const);
    for (const part of parts)
      this.model.setProperty(`/config/${part}`, structuredClone(demoConfiguration[part]));
    this.filterRecords(parts[0], "");
  }
  private add(path: string, value: unknown): void {
    this.onConfigurationEdit();
    this.model.setProperty(path, [...(this.model.getProperty(path) as unknown[]), value]);
    const kind = path.split("/")[2];
    if (kind === "classifications" || kind === "accounts") {
      const index = (this.model.getProperty(path) as unknown[]).length - 1;
      this.filterRecords(kind, "", `${path}/${index}`);
    }
  }
  public onAddClassification(): void {
    this.add("/config/classifications", { id: "", name: "" });
  }
  public onAddAccount(): void {
    this.add("/config/accounts", {
      account: "",
      name: "",
      classificationId: "",
      criterion: "DIRECT_COST",
      percent: "100",
      active: true
    });
  }
  public onAddGroup(): void {
    this.add("/config/groupShares", { account: "", group: "", percent: "", basis: "HOURS" });
  }
  public onGroupBasisChange(event: Event): void {
    const source = event.getSource() as import("sap/m/Select").default;
    const path = source.getBindingContext("ggf")!.getPath();
    this.model.setProperty(`${path}/basis`, source.getSelectedKey());
    this.onConfigurationEdit();
  }
  public onRemove(event: Event): void {
    const path = (event.getSource() as Control).getBindingContext("ggf")!.getPath();
    const parent = path.slice(0, path.lastIndexOf("/"));
    const index = Number(path.slice(path.lastIndexOf("/") + 1));
    const values = [...(this.model.getProperty(parent) as unknown[])];
    values.splice(index, 1);
    this.onConfigurationEdit();
    this.model.setProperty(parent, values);
    const kind = parent.split("/")[2];
    if (kind === "classifications" || kind === "accounts")
      this.filterRecords(kind, this.model.getProperty(`/${kind}Search`) as string);
  }
  public onRevaluation(): void {
    if (!this.session?.result || !this.model.getProperty("/calculated")) return;
    const preview = previewRevaluation(demoRevaluationInput(this.session.result));
    this.getOwnerComponent()!.setModel(new JSONModel({ result: preview }), "ggfRevaluation");
    (this.getOwnerComponent() as UIComponent).getRouter().navTo("ggfRevaluation");
  }
  public onExport(): void {
    if (!this.session?.result) return;
    const blob = new Blob([exportCsv(this.session.result)], {
      type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `GGF-DEVELOPMENT-${this.session.result.snapshot.filter.start}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  public onConfirm(): void {
    try {
      this.session?.confirm();
    } catch (error) {
      this.showError(error);
    }
  }
}
