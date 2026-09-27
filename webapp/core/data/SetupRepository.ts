// Versão dos metadados instalada por módulo, na FBO_SETUP (uma linha por módulo, Code = código do módulo).
import { PRODUCT_NAME, tableName, type ModuleCode } from "../config/product";
import { ServiceLayerError } from "../service/errors";

/** O que o repositório precisa do cliente do Service Layer. */
export interface SlReadWrite {
  get<T = unknown>(path: string): Promise<T | undefined>;
  post<T = unknown>(path: string, body: unknown): Promise<T | undefined>;
  patch<T = unknown>(path: string, body: unknown): Promise<T | undefined>;
}

// TODO [CONFIRMAR] o nome da entidade do UDO no Service Layer (código do UDO com ou sem `U_`).
const ENTITY = tableName("core", "SETUP");

interface SetupRow {
  Code: string;
  U_Version?: string;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export class SetupRepository {
  constructor(
    private readonly client: SlReadWrite,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async readRow(module: ModuleCode): Promise<SetupRow | undefined> {
    try {
      return await this.client.get<SetupRow>(`${ENTITY}('${module}')`);
    } catch (error) {
      if (error instanceof ServiceLayerError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `undefined` quando o módulo nunca foi instalado (ou a versão gravada não é legível). */
  async getInstalledVersion(module: ModuleCode): Promise<number | undefined> {
    const version = Number((await this.readRow(module))?.U_Version);
    return Number.isInteger(version) && version > 0 ? version : undefined;
  }

  async setInstalledVersion(module: ModuleCode, version: number): Promise<void> {
    const fields = { U_Version: String(version), U_InstDate: isoDate(this.now()) };
    if ((await this.readRow(module)) === undefined) {
      await this.client.post(ENTITY, { Code: module, Name: `${PRODUCT_NAME} ${module}`, ...fields });
    } else {
      await this.client.patch(`${ENTITY}('${module}')`, fields);
    }
  }
}
