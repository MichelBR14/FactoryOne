import { describe, expect, it } from "vitest";
import { CORE_METADATA } from "../../../webapp/core/data/definitions/core";
import type { MetadataSet } from "../../../webapp/core/data/metadata";
import { planMetadata, type ExistingMetadata } from "../../../webapp/core/data/plan";

const set: MetadataSet = {
  module: "ggf",
  version: 1,
  tables: [
    {
      name: "RUN",
      description: "Apurações",
      kind: "document",
      fields: [
        { name: "Year", description: "Ano", type: "numeric", size: 4 },
        {
          name: "Status",
          description: "Status",
          type: "alpha",
          size: 12,
          mandatory: true,
          defaultValue: "DRAFT",
          validValues: [{ value: "DRAFT", description: "Rascunho" }]
        },
        { name: "PostDate", description: "Data", type: "date", subType: "time" }
      ]
    },
    { name: "RUN1", description: "Apuração - saldos", kind: "documentLines", fields: [] }
  ],
  objects: [{ table: "RUN", name: "Apuração GGF", kind: "document", children: ["RUN1"] }]
};

const existing = (patch: Partial<ExistingMetadata>): ExistingMetadata => ({
  tables: new Set(),
  fields: new Map(),
  objects: new Set(),
  ...patch
});

describe("planMetadata", () => {
  it("sem nada existente cria tabelas, depois campos, depois objetos", () => {
    const plan = planMetadata(set);
    expect(plan.actions.map((a) => a.description)).toEqual([
      "Criar tabela FBO_GGF_RUN",
      "Criar tabela FBO_GGF_RUN1",
      "Criar campo FBO_GGF_RUN.U_Year",
      "Criar campo FBO_GGF_RUN.U_Status",
      "Criar campo FBO_GGF_RUN.U_PostDate",
      "Criar objeto FBO_GGF_RUN"
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.module).toBe("ggf");
    expect(plan.version).toBe(1);
  });

  it("monta os corpos no formato do Service Layer", () => {
    const [table, , year, status, postDate, object] = planMetadata(set).actions;
    expect(table).toMatchObject({
      entity: "UserTablesMD",
      body: { TableName: "FBO_GGF_RUN", TableDescription: "Apurações", TableType: "bott_Document" }
    });
    expect(year?.body).toEqual({
      TableName: "@FBO_GGF_RUN",
      Name: "Year",
      Description: "Ano",
      Type: "db_Numeric",
      Size: 4
    });
    expect(status?.body).toMatchObject({
      Type: "db_Alpha",
      Size: 12,
      Mandatory: "tYES",
      DefaultValue: "DRAFT",
      ValidValuesMD: [{ Value: "DRAFT", Description: "Rascunho" }]
    });
    expect(postDate?.body).toMatchObject({ Type: "db_Date", SubType: "st_Time" });
    expect(postDate?.body).not.toHaveProperty("Size");
    expect(object).toMatchObject({
      entity: "UserObjectsMD",
      body: {
        Code: "FBO_GGF_RUN",
        TableName: "FBO_GGF_RUN",
        ObjectType: "boud_Document",
        UserObjectMD_ChildTables: [{ TableName: "FBO_GGF_RUN1" }]
      }
    });
  });

  it("não cria o que já existe (idempotente)", () => {
    const plan = planMetadata(
      set,
      existing({
        tables: new Set(["FBO_GGF_RUN", "FBO_GGF_RUN1"]),
        fields: new Map([
          [
            "FBO_GGF_RUN",
            new Map([
              ["Year", { type: "db_Numeric", size: 4 }],
              ["Status", { type: "db_Alpha", size: 12 }],
              ["PostDate", { type: "db_Date" }]
            ])
          ]
        ]),
        objects: new Set(["FBO_GGF_RUN"])
      })
    );
    expect(plan.actions).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("cria só o campo que falta numa tabela existente", () => {
    const plan = planMetadata(
      set,
      existing({
        tables: new Set(["FBO_GGF_RUN", "FBO_GGF_RUN1"]),
        fields: new Map([["FBO_GGF_RUN", new Map([["Year", { type: "db_Numeric", size: 4 }]])]]),
        objects: new Set(["FBO_GGF_RUN"])
      })
    );
    expect(plan.actions.map((a) => a.description)).toEqual([
      "Criar campo FBO_GGF_RUN.U_Status",
      "Criar campo FBO_GGF_RUN.U_PostDate"
    ]);
  });

  it("avisa, sem alterar, quando o campo existe com tipo ou tamanho diferente", () => {
    const plan = planMetadata(
      set,
      existing({
        tables: new Set(["FBO_GGF_RUN", "FBO_GGF_RUN1"]),
        fields: new Map([
          [
            "FBO_GGF_RUN",
            new Map([
              ["Year", { type: "db_Alpha", size: 4 }],
              ["Status", { type: "db_Alpha", size: 30 }],
              ["PostDate", { type: "db_Date" }]
            ])
          ]
        ]),
        objects: new Set(["FBO_GGF_RUN"])
      })
    );
    expect(plan.actions).toEqual([]);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toMatch(/U_Year.*db_Alpha.*db_Numeric/);
    expect(plan.warnings[1]).toMatch(/U_Status.*tamanho 30.*12/);
  });

  it("nunca gera ação de exclusão ou alteração", () => {
    const kinds = new Set(planMetadata(set).actions.map((a) => a.kind));
    expect([...kinds].sort()).toEqual(["createField", "createObject", "createTable"]);
  });

  it("rejeita conjunto inválido listando os problemas", () => {
    expect(() => planMetadata({ ...set, version: 0 })).toThrow(/Metadados inválidos/);
  });
});

describe("metadados do núcleo", () => {
  it("são válidos e criam FBO_SETUP, FBO_LIC e FBO_LOG", () => {
    const plan = planMetadata(CORE_METADATA);
    const tables = plan.actions.filter((a) => a.kind === "createTable").map((a) => a.body.TableName);
    expect(tables).toEqual(["FBO_SETUP", "FBO_LIC", "FBO_LOG"]);
    expect(plan.actions.filter((a) => a.kind === "createObject")).toHaveLength(3);
  });
});
