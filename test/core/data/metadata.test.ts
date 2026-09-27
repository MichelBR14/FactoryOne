import { describe, expect, it } from "vitest";
import { validateMetadataSet, type MetadataSet } from "../../../webapp/core/data/metadata";

const valid: MetadataSet = {
  module: "ggf",
  version: 1,
  tables: [
    {
      name: "RULE",
      description: "Regras",
      kind: "masterData",
      fields: [{ name: "Basis", description: "Critério", type: "alpha", size: 20 }]
    },
    { name: "RULE1", description: "Regras - linhas", kind: "masterDataLines", fields: [] }
  ],
  objects: [{ table: "RULE", name: "Regras", kind: "masterData", children: ["RULE1"] }]
};

const with_ = (patch: Partial<MetadataSet>): MetadataSet => ({ ...valid, ...patch });

describe("validateMetadataSet", () => {
  it("aceita um conjunto válido", () => {
    expect(validateMetadataSet(valid)).toEqual([]);
  });

  it("exige versão inteira maior que zero", () => {
    expect(validateMetadataSet(with_({ version: 0 }))).toHaveLength(1);
    expect(validateMetadataSet(with_({ version: 1.5 }))).toHaveLength(1);
  });

  it("rejeita nome de tabela acima do limite", () => {
    const set = with_({ tables: [{ name: "NOME_MUITO_LONGO_DEMAIS", description: "x", kind: "noObject", fields: [] }], objects: [] });
    expect(validateMetadataSet(set).join()).toMatch(/excede/);
  });

  it("rejeita tabela repetida", () => {
    const table = valid.tables[0]!;
    expect(validateMetadataSet(with_({ tables: [table, table], objects: [] })).join()).toMatch(/repetida/);
  });

  it("valida nome, tamanho e repetição de campos", () => {
    const fields = [
      { name: "Nome_De_Campo_Muito_Longo", description: "x", type: "date" as const },
      { name: "1Invalido", description: "x", type: "date" as const },
      { name: "Dup", description: "x", type: "date" as const },
      { name: "Dup", description: "x", type: "date" as const },
      { name: "SemTamanho", description: "x", type: "alpha" as const }
    ];
    const problems = validateMetadataSet(
      with_({ tables: [{ name: "T", description: "x", kind: "noObject", fields }], objects: [] })
    ).join("\n");
    expect(problems).toMatch(/excede 18/);
    expect(problems).toMatch(/inválido: FBO_GGF_T\.U_1Invalido/);
    expect(problems).toMatch(/repetido: FBO_GGF_T\.U_Dup/);
    expect(problems).toMatch(/precisa de tamanho.*U_SemTamanho/);
  });

  it("valida os UDOs contra as tabelas do conjunto", () => {
    const orphan = validateMetadataSet(with_({ objects: [{ table: "OUTRA", name: "x", kind: "masterData" }] }));
    expect(orphan.join()).toMatch(/não está no conjunto/);

    const wrongKind = validateMetadataSet(with_({ objects: [{ table: "RULE", name: "x", kind: "document" }] }));
    expect(wrongKind.join()).toMatch(/incompatível/);

    const wrongChild = validateMetadataSet(
      with_({ objects: [{ table: "RULE", name: "x", kind: "masterData", children: ["RULE"] }] })
    );
    expect(wrongChild.join()).toMatch(/não é uma tabela de linhas/);
  });
});
