// Instala/atualiza os metadados de um módulo no Service Layer: lê o que existe, planeja e executa.
// Idempotente: só cria o que falta e nunca apaga. Não é transacional; se parar no meio, rodar de novo continua.
import type { ModuleCode } from "../config/product";
import { ServiceLayerError } from "../service/errors";
import type { MetadataSet } from "./metadata";
import { fullTableName } from "./metadata";
import {
  planMetadata,
  type ExistingField,
  type ExistingMetadata,
  type MetadataAction,
  type MetadataPlan
} from "./plan";
import { SetupRepository, type SlReadWrite } from "./SetupRepository";

export interface InstallResult {
  module: ModuleCode;
  plan: MetadataPlan;
  /** Ações concluídas, na ordem. */
  done: MetadataAction[];
  /** Primeira ação que falhou; as seguintes não foram tentadas. */
  failed?: { action: MetadataAction; message: string };
  /** `true` quando a versão foi gravada na FBO_SETUP (só se nada falhou). */
  versionRecorded: boolean;
}

interface Page<T> {
  value?: T[];
  "odata.nextLink"?: string;
  "@odata.nextLink"?: string;
}

interface FieldRow {
  Name?: string;
  Type?: string;
  Size?: number;
}

const MAX_PAGES = 100;

const isNotFound = (error: unknown) => error instanceof ServiceLayerError && error.status === 404;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** O `nextLink` pode vir com ou sem o caminho base (`/b1s/v2/`); o cliente já acrescenta o base. */
const relativeLink = (link: string) => link.replace(/^\/?b1s\/v\d+\//, "");

export class MetadataInstaller {
  private readonly setup: SetupRepository;

  constructor(
    private readonly client: SlReadWrite,
    setup?: SetupRepository
  ) {
    this.setup = setup ?? new SetupRepository(client);
  }

  /** Só leitura. */
  async plan(set: MetadataSet): Promise<MetadataPlan> {
    return planMetadata(set, await this.readExisting(set));
  }

  /** Planeja, executa e, se tudo deu certo, grava a versão dos metadados na FBO_SETUP. */
  async install(set: MetadataSet, onProgress?: (action: MetadataAction) => void): Promise<InstallResult> {
    const plan = await this.plan(set);
    const done: MetadataAction[] = [];

    for (const action of plan.actions) {
      onProgress?.(action);
      try {
        await this.client.post(action.entity, action.body);
        done.push(action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { module: set.module, plan, done, failed: { action, message }, versionRecorded: false };
      }
    }

    // Só depois de criar tudo: no primeiro uso do núcleo a FBO_SETUP ainda não existia antes.
    const installed = await this.setup.getInstalledVersion(set.module);
    const versionRecorded = installed !== set.version;
    if (versionRecorded) await this.setup.setInstalledVersion(set.module, set.version);

    return { module: set.module, plan, done, versionRecorded };
  }

  async readExisting(set: MetadataSet): Promise<ExistingMetadata> {
    const tables = new Set<string>();
    const fields = new Map<string, Map<string, ExistingField>>();
    const objects = new Set<string>();

    for (const table of set.tables) {
      const full = fullTableName(set, table.name);
      if (!(await this.exists(`UserTablesMD(${quote(full)})`))) continue;
      tables.add(full);
      fields.set(full, await this.readFields(full));
    }
    for (const object of set.objects) {
      const full = fullTableName(set, object.table);
      if (await this.exists(`UserObjectsMD(${quote(full)})`)) objects.add(full);
    }
    return { tables, fields, objects };
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return (await this.client.get(path)) !== undefined;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async readFields(full: string): Promise<Map<string, ExistingField>> {
    const found = new Map<string, ExistingField>();
    const filter = encodeURIComponent(`TableName eq ${quote(`@${full}`)}`);
    let path: string | undefined = `UserFieldsMD?$select=Name,Type,Size&$filter=${filter}`;

    for (let page = 0; path && page < MAX_PAGES; page++) {
      const response: Page<FieldRow> | undefined = await this.client.get<Page<FieldRow>>(path);
      for (const row of response?.value ?? []) {
        if (row.Name) found.set(row.Name, { type: row.Type, size: row.Size });
      }
      const next: string | undefined = response?.["@odata.nextLink"] ?? response?.["odata.nextLink"];
      path = next ? relativeLink(next) : undefined;
    }
    return found;
  }
}
