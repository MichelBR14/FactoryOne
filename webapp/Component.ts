import UIComponent from "sap/ui/core/UIComponent";

/**
 * Componente raiz da extensão. Só liga o roteamento; a lógica fica em services/engine.
 * @namespace factoreone.app
 */
export default class Component extends UIComponent {
  public static metadata = {
    manifest: "json",
    interfaces: ["sap.ui.core.IAsyncContentCreation"]
  };

  public override init(): void {
    super.init();
    this.getRouter().initialize();
  }
}
