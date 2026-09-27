import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import { FlagLicenseProvider } from "../core/auth/License";
import { listModuleStatus } from "../core/auth/moduleStatus";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../core/config/product";

type Texts = { getText(key: string, args?: string[]): string };

/**
 * Tela inicial da suíte: nome, versão e estado de cada módulo.
 * @namespace factoreone.app.controller
 */
export default class Home extends Controller {
  public override onInit(): void {
    const texts = (this.getOwnerComponent()?.getModel("i18n") as ResourceModel).getResourceBundle() as Texts;
    // TODO: ler as flags da FBO_LIC quando o instalador do núcleo existir (por ora só o núcleo está habilitado).
    const modules = listModuleStatus(new FlagLicenseProvider({})).map(({ code, enabled }) => ({
      name: texts.getText(`module_${code}`),
      status: texts.getText(enabled ? "statusEnabled" : "statusDisabled"),
      state: enabled ? "Success" : "None"
    }));

    this.getView()?.setModel(
      new JSONModel({
        title: texts.getText("homeTitle", [PRODUCT_NAME]),
        version: texts.getText("homeVersion", [PRODUCT_VERSION]),
        modulesHeader: texts.getText("modulesHeader"),
        modules
      }),
      "view"
    );
  }
}
