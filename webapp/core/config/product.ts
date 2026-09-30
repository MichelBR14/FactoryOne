// Única fonte do nome, prefixos e versão do produto. Não espalhar estes valores pelo código.
export const PRODUCT_NAME = "FactoreOne";
/** Nome exibido; PRODUCT_NAME permanece como identidade tecnica do pacote existente. */
export const PRODUCT_DISPLAY_NAME = "FactoryOne";
export const PRODUCT_VERSION = "0.1.0";

/** Prefixo das tabelas de usuário (UDTs). Decisão registrada na seção 9 do CLAUDE.md. */
export const TABLE_PREFIX = "FBO_";

/** Prefixo das referências (Ref3/Memo) dos documentos gerados pela suíte. */
export const REF_PREFIX = "FO";

export const MODULES = ["core", "ggf", "ind"] as const;
export type ModuleCode = (typeof MODULES)[number];

// TODO [CONFIRMAR] limite de tamanho do nome de UDT na FP 2608 (validar no instalador).
export const MAX_UDT_NAME_LENGTH = 19;

// TODO [CONFIRMAR] limite de tamanho do nome de UDF (sem o prefixo `U_`) na FP 2608 (validar no instalador).
export const MAX_UDF_NAME_LENGTH = 18;

/** Nome da UDT de um módulo: `FBO_GGF_RULE`. Para o núcleo, `FBO_SETUP`. */
export function tableName(module: ModuleCode, name: string): string {
  const base = module === "core" ? name : `${module.toUpperCase()}_${name}`;
  const full = `${TABLE_PREFIX}${base}`;
  if (full.length > MAX_UDT_NAME_LENGTH) {
    throw new Error(`Nome de tabela excede ${MAX_UDT_NAME_LENGTH} caracteres: ${full}`);
  }
  return full;
}

/** Referência de documento gerado: `FO-GGF-2026-09`. */
export function documentRef(module: ModuleCode, ...parts: Array<string | number>): string {
  return [REF_PREFIX, module.toUpperCase(), ...parts].join("-");
}
