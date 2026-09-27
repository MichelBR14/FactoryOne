// Modelo declarativo dos metadados (UDT/UDF/UDO) que cada módulo instala. Puro: sem HTTP.
// Os nomes são os curtos (`SETUP`, `Version`); prefixos (`FBO_`, `U_`, `@`) são aplicados no mapeamento.
import { MAX_UDF_NAME_LENGTH, tableName, type ModuleCode } from "../config/product";

export type FieldType = "alpha" | "memo" | "numeric" | "date" | "float";
export type FieldSubType =
  | "none"
  | "time"
  | "percentage"
  | "price"
  | "quantity"
  | "rate"
  | "sum"
  | "link"
  | "measurement";
export type TableKind = "masterData" | "masterDataLines" | "document" | "documentLines" | "noObject";

export interface ValidValue {
  value: string;
  description: string;
}

export interface FieldDef {
  /** Nome sem o prefixo `U_`. */
  name: string;
  description: string;
  type: FieldType;
  /** Obrigatório para `alpha`. */
  size?: number;
  subType?: FieldSubType;
  mandatory?: boolean;
  defaultValue?: string;
  validValues?: readonly ValidValue[];
}

export interface TableDef {
  /** Nome curto, sem `FBO_` nem o código do módulo (ex.: `SETUP`, `RULE1`). */
  name: string;
  description: string;
  kind: TableKind;
  fields: readonly FieldDef[];
}

export interface ObjectDef {
  /** Tabela principal (nome curto). O código do UDO é o nome completo da tabela. */
  table: string;
  name: string;
  kind: "masterData" | "document";
  /** Tabelas de linhas (nomes curtos). */
  children?: readonly string[];
}

export interface MetadataSet {
  module: ModuleCode;
  /** Versão dos metadados do módulo, inteira e crescente. Gravada na `FBO_SETUP`. */
  version: number;
  tables: readonly TableDef[];
  objects: readonly ObjectDef[];
}

// TODO [CONFIRMAR] limite de tamanho de campo alfanumérico na FP 2608.
const MAX_ALPHA_SIZE = 254;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const LINES_KINDS: readonly TableKind[] = ["masterDataLines", "documentLines"];
const OBJECT_TABLE_KIND = { masterData: "masterData", document: "document" } as const;

/** Nome completo da UDT (`FBO_GGF_RULE`). Lança se exceder o limite. */
export function fullTableName(set: Pick<MetadataSet, "module">, table: string): string {
  return tableName(set.module, table);
}

/** Problemas do conjunto, em português; lista vazia quando está válido. */
export function validateMetadataSet(set: MetadataSet): string[] {
  const problems: string[] = [];

  if (!Number.isInteger(set.version) || set.version < 1) {
    problems.push(`${set.module}: a versão dos metadados deve ser um inteiro maior que zero`);
  }

  const kinds = new Map<string, TableKind>();
  for (const table of set.tables) {
    let full: string;
    try {
      full = fullTableName(set, table.name);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (kinds.has(table.name)) problems.push(`Tabela repetida: ${full}`);
    kinds.set(table.name, table.kind);

    const seen = new Set<string>();
    for (const field of table.fields) {
      const where = `${full}.U_${field.name}`;
      if (!FIELD_NAME.test(field.name)) problems.push(`Nome de campo inválido: ${where}`);
      if (field.name.length > MAX_UDF_NAME_LENGTH) {
        problems.push(`Nome de campo excede ${MAX_UDF_NAME_LENGTH} caracteres: ${where}`);
      }
      if (seen.has(field.name)) problems.push(`Campo repetido: ${where}`);
      seen.add(field.name);
      if (field.type === "alpha" && !(field.size && field.size >= 1 && field.size <= MAX_ALPHA_SIZE)) {
        problems.push(`Campo alfanumérico precisa de tamanho entre 1 e ${MAX_ALPHA_SIZE}: ${where}`);
      }
    }
  }

  const codes = new Set<string>();
  for (const object of set.objects) {
    const kind = kinds.get(object.table);
    if (!kind) {
      problems.push(`UDO ${object.table}: a tabela não está no conjunto`);
      continue;
    }
    if (codes.has(object.table)) problems.push(`UDO repetido: ${object.table}`);
    codes.add(object.table);
    if (kind !== OBJECT_TABLE_KIND[object.kind]) {
      problems.push(`UDO ${object.table}: tipo ${object.kind} incompatível com a tabela (${kind})`);
    }
    for (const child of object.children ?? []) {
      const childKind = kinds.get(child);
      if (!childKind || !LINES_KINDS.includes(childKind)) {
        problems.push(`UDO ${object.table}: "${child}" não é uma tabela de linhas do conjunto`);
      }
    }
  }

  return problems;
}
