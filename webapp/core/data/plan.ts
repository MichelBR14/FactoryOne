// Planejador dos metadados: compara o desejado (MetadataSet) com o que já existe e lista só o que falta.
// Puro e idempotente: nunca apaga nem altera; divergência em campo existente vira aviso.
import {
  fullTableName,
  validateMetadataSet,
  type FieldDef,
  type FieldSubType,
  type FieldType,
  type MetadataSet,
  type ObjectDef,
  type TableDef,
  type TableKind
} from "./metadata";

// TODO [CONFIRMAR] os nomes de propriedades e enums abaixo contra o Service Layer da FP 2608
// (UserTablesMD, UserFieldsMD, UserObjectsMD). Nenhuma chamada real foi feita ainda.
const TABLE_TYPE: Record<TableKind, string> = {
  masterData: "bott_MasterData",
  masterDataLines: "bott_MasterDataLines",
  document: "bott_Document",
  documentLines: "bott_DocumentLines",
  noObject: "bott_NoObject"
};
const FIELD_TYPE: Record<FieldType, string> = {
  alpha: "db_Alpha",
  memo: "db_Memo",
  numeric: "db_Numeric",
  date: "db_Date",
  float: "db_Float"
};
const FIELD_SUBTYPE: Record<FieldSubType, string> = {
  none: "st_None",
  time: "st_Time",
  percentage: "st_Percentage",
  price: "st_Price",
  quantity: "st_Quantity",
  rate: "st_Rate",
  sum: "st_Sum",
  link: "st_Link",
  measurement: "st_Measurement"
};
const OBJECT_TYPE = { masterData: "boud_MasterData", document: "boud_Document" } as const;

export type MetadataEntity = "UserTablesMD" | "UserFieldsMD" | "UserObjectsMD";

export interface MetadataAction {
  kind: "createTable" | "createField" | "createObject";
  /** Descrição para mostrar ao usuário (ex.: `Criar campo FBO_SETUP.U_Version`). */
  description: string;
  entity: MetadataEntity;
  body: Record<string, unknown>;
}

export interface MetadataPlan {
  module: MetadataSet["module"];
  version: number;
  actions: MetadataAction[];
  /** Divergências de tipo/tamanho. Bloqueiam install(); plan() permite conferência sem escrever. */
  warnings: string[];
}

export interface ExistingField {
  /** Tipo como o Service Layer devolve (`db_Alpha`). */
  type?: string;
  size?: number;
  subType?: string;
}

export interface ExistingMetadata {
  /** Nomes completos das UDTs (`FBO_SETUP`). */
  tables: ReadonlySet<string>;
  /** Por UDT (nome completo), os campos existentes por nome sem `U_`. */
  fields: ReadonlyMap<string, ReadonlyMap<string, ExistingField>>;
  /** Códigos dos UDOs. */
  objects: ReadonlySet<string>;
}

export const NOTHING_EXISTS: ExistingMetadata = { tables: new Set(), fields: new Map(), objects: new Set() };

export function toUserTableBody(full: string, table: TableDef): Record<string, unknown> {
  return { TableName: full, TableDescription: table.description, TableType: TABLE_TYPE[table.kind] };
}

export function toUserFieldBody(full: string, field: FieldDef): Record<string, unknown> {
  const body: Record<string, unknown> = {
    TableName: `@${full}`,
    Name: field.name,
    Description: field.description,
    Type: FIELD_TYPE[field.type]
  };
  if (field.subType && field.subType !== "none") body.SubType = FIELD_SUBTYPE[field.subType];
  if (field.size !== undefined) body.Size = field.size;
  if (field.mandatory) body.Mandatory = "tYES";
  if (field.defaultValue !== undefined) body.DefaultValue = field.defaultValue;
  if (field.validValues?.length) {
    body.ValidValuesMD = field.validValues.map((v) => ({ Value: v.value, Description: v.description }));
  }
  return body;
}

export function toUserObjectBody(
  set: MetadataSet,
  object: ObjectDef,
  full: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Code: full,
    Name: object.name,
    TableName: full,
    ObjectType: OBJECT_TYPE[object.kind],
    CanFind: "tYES",
    CanDelete: object.canDelete === false ? "tNO" : "tYES",
    ...(object.applyAuthorization && { ApplyAuthorization: "tYES" }),
    CanCancel: "tNO",
    CanClose: "tNO",
    CanYearTransfer: "tNO",
    CanLog: "tNO",
    CanCreateDefaultForm: "tNO",
    ManageSeries: "tNO"
  };
  if (object.children?.length) {
    body.UserObjectMD_ChildTables = object.children.map((child) => ({
      TableName: fullTableName(set, child)
    }));
  }
  return body;
}

function divergence(full: string, field: FieldDef, existing: ExistingField): string | undefined {
  const wantedType = FIELD_TYPE[field.type];
  const where = `${full}.U_${field.name}`;
  // SAP stores a Time UDF as db_Numeric/st_Time even when created with db_Date/st_Time.
  const sapTime = field.type === "date" && field.subType === "time" &&
    existing.type === "db_Numeric" && existing.subType === "st_Time";
  if (existing.type && existing.type !== wantedType && !sapTime) {
    return `${where} já existe como ${existing.type} e o FactoreOne espera ${wantedType}; não foi alterado.`;
  }
  if (field.subType && field.subType !== "none" && existing.subType &&
      existing.subType !== FIELD_SUBTYPE[field.subType])
    return `${where} já existe com subtipo ${existing.subType} e o FactoreOne espera ${FIELD_SUBTYPE[field.subType]}; não foi alterado.`;
  if (field.type === "alpha" && existing.size !== undefined && existing.size !== field.size) {
    return `${where} já existe com tamanho ${existing.size} e o FactoreOne espera ${field.size}; não foi alterado.`;
  }
  return undefined;
}

/** Lança se o conjunto for inválido. Ordem das ações: tabelas, campos, objetos. */
export function planMetadata(set: MetadataSet, existing: ExistingMetadata = NOTHING_EXISTS): MetadataPlan {
  const problems = validateMetadataSet(set);
  if (problems.length) throw new Error(`Metadados inválidos:\n- ${problems.join("\n- ")}`);

  const tables: MetadataAction[] = [];
  const fields: MetadataAction[] = [];
  const objects: MetadataAction[] = [];
  const warnings: string[] = [];

  for (const table of set.tables) {
    const full = fullTableName(set, table.name);
    if (!existing.tables.has(full)) {
      tables.push({
        kind: "createTable",
        description: `Criar tabela ${full}`,
        entity: "UserTablesMD",
        body: toUserTableBody(full, table)
      });
    }
    const current = existing.fields.get(full);
    for (const field of table.fields) {
      const found = current?.get(field.name);
      if (found) {
        const warning = divergence(full, field, found);
        if (warning) warnings.push(warning);
        continue;
      }
      fields.push({
        kind: "createField",
        description: `Criar campo ${full}.U_${field.name}`,
        entity: "UserFieldsMD",
        body: toUserFieldBody(full, field)
      });
    }
  }

  for (const object of set.objects) {
    const full = fullTableName(set, object.table);
    if (existing.objects.has(full)) continue;
    objects.push({
      kind: "createObject",
      description: `Criar objeto ${full}`,
      entity: "UserObjectsMD",
      body: toUserObjectBody(set, object, full)
    });
  }

  return {
    module: set.module,
    version: set.version,
    actions: [...tables, ...fields, ...objects],
    warnings
  };
}
