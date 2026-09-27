import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../core/config/product";

/**
 * Controller fino: o nome e a versão vêm de product.ts, os textos do i18n.
 * @namespace factoreone.app.controller
 */
export default class Main extends Controller {
  public override onInit(): void {
    const bundle = (this.getOwnerComponent()?.getModel("i18n") as ResourceModel).getResourceBundle() as {
      getText(key: string, args?: string[]): string;
    };
    this.getView()?.setModel(
      new JSONModel({
        title: bundle.getText("mainTitle", [PRODUCT_NAME]),
        message: bundle.getText("helloMessage", [PRODUCT_NAME, PRODUCT_VERSION])
      }),
      "view"
    );
  }
}
