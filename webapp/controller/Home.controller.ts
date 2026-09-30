import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from "../core/config/product";
import { MODULE_NAVIGATION } from "../core/config/navigation";
import { isDevelopmentMode, isSapReadMode } from "../core/config/runtime";
import UIComponent from "sap/ui/core/UIComponent";
import type Event from "sap/ui/base/Event";
import type Control from "sap/ui/core/Control";

type Texts = { getText(key: string, args?: string[]): string };

/**
 * Tela inicial da suíte: nome, versão e estado de cada módulo.
 * @namespace factoreone.app.controller
 */
export default class Home extends Controller {
  public override onInit(): void {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const texts = (await (
      this.getOwnerComponent()!.getModel("i18n") as ResourceModel
    ).getResourceBundle()) as Texts;
    const modules = MODULE_NAVIGATION.map((module) => ({
      ...module,
      name: texts.getText(module.title),
      status: texts.getText(
        module.route
          ? isDevelopmentMode()
            ? isSapReadMode()
              ? "sapReadPreview"
              : "localPreview"
            : "integrationPending"
          : "moduleUnavailable"
      ),
      available: !!module.route
    }));

    this.getView()?.setModel(
      new JSONModel({
        title: PRODUCT_DISPLAY_NAME,
        version: texts.getText("homeVersion", [PRODUCT_VERSION]),
        modulesHeader: texts.getText("modulesHeader"),
        development: isDevelopmentMode() && !isSapReadMode(),
        sapRead: isSapReadMode(),
        modules
      }),
      "view"
    );
  }

  public onModule(event: Event): void {
    const key = (event.getSource() as Control).getBindingContext("view")?.getProperty("key");
    const entry = MODULE_NAVIGATION.find((module) => module.key === key);
    if (entry?.route) (this.getOwnerComponent() as UIComponent).getRouter().navTo(entry.route);
  }
}
