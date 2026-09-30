import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type Event from "sap/ui/base/Event";
import type Control from "sap/ui/core/Control";
import { PRODUCT_DISPLAY_NAME } from "../../../core/config/product";
import { GGF_NAVIGATION } from "../../../core/config/navigation";
import { isDevelopmentMode, isSapReadMode } from "../../../core/config/runtime";

/** @namespace factoreone.app.modules.ggf.controller */
export default class Menu extends Controller {
  public override onInit(): void {
    void this.initialize();
  }
  private async initialize(): Promise<void> {
    const texts = await (
      this.getOwnerComponent()!.getModel("i18n") as ResourceModel
    ).getResourceBundle();
    const development = isDevelopmentMode();
    this.getView()!.setModel(
      new JSONModel({
        product: PRODUCT_DISPLAY_NAME,
        development: development && !isSapReadMode(),
        sapRead: isSapReadMode(),
        functions: GGF_NAVIGATION.map((entry) => ({
          ...entry,
          name: texts.getText(entry.title),
          status: texts.getText(
            !entry.route
              ? "inDevelopment"
              : isSapReadMode()
                ? entry.key === "closing"
                  ? "sapReadPreview"
                  : "integrationPending"
                : development
                  ? "localPreview"
                  : "integrationPending"
          ),
          available: !!entry.route && development && (!isSapReadMode() || entry.key === "closing")
        }))
      }),
      "menu"
    );
  }
  public onFunction(event: Event): void {
    if (!isDevelopmentMode()) return;
    const key = (event.getSource() as Control).getBindingContext("menu")?.getProperty("key");
    const entry = GGF_NAVIGATION.find((item) => item.key === key);
    if (isSapReadMode() && entry?.key !== "closing") return;
    if (entry?.route) (this.getOwnerComponent() as UIComponent).getRouter().navTo(entry.route);
  }
  public onHome(): void {
    (this.getOwnerComponent() as UIComponent).getRouter().navTo("main");
  }
}
