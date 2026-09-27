import type { MetadataSet } from "../metadata";

/**
 * Tabelas da plataforma (CLAUDE.md, seção 3.2). Todas MasterData com UDO para o Service Layer expô-las
 * como entidade. TODO [CONFIRMAR] tipo das tabelas e nome da entidade de cada UDO no Service Layer da FP 2608.
 * `FBO_LIC` guarda só a flag por módulo no MVP; o modelo de licenciamento real ainda é [CONFIRMAR].
 */
export const CORE_METADATA: MetadataSet = {
  module: "core",
  version: 1,
  tables: [
    {
      name: "SETUP",
      description: "FactoreOne - Setup",
      kind: "masterData",
      fields: [
        { name: "Version", description: "Versão dos metadados", type: "alpha", size: 20 },
        { name: "InstDate", description: "Data da instalação", type: "date" }
      ]
    },
    {
      name: "LIC",
      description: "FactoreOne - Licenças",
      kind: "masterData",
      fields: [
        {
          name: "Enabled",
          description: "Módulo habilitado",
          type: "alpha",
          size: 1,
          defaultValue: "N",
          validValues: [
            { value: "Y", description: "Sim" },
            { value: "N", description: "Não" }
          ]
        }
      ]
    },
    {
      name: "LOG",
      description: "FactoreOne - Log",
      kind: "masterData",
      fields: [
        { name: "Module", description: "Módulo", type: "alpha", size: 10 },
        { name: "Routine", description: "Rotina", type: "alpha", size: 50 },
        { name: "UserCode", description: "Usuário", type: "alpha", size: 30 },
        { name: "StartDate", description: "Data de início", type: "date" },
        { name: "StartTime", description: "Hora de início", type: "date", subType: "time" },
        { name: "EndDate", description: "Data de fim", type: "date" },
        { name: "EndTime", description: "Hora de fim", type: "date", subType: "time" },
        { name: "Status", description: "Status", type: "alpha", size: 10 },
        { name: "Message", description: "Mensagem", type: "memo" },
        { name: "DocRef", description: "Referência do documento", type: "alpha", size: 50 }
      ]
    }
  ],
  objects: [
    { table: "SETUP", name: "FactoreOne - Setup", kind: "masterData" },
    { table: "LIC", name: "FactoreOne - Licenças", kind: "masterData" },
    { table: "LOG", name: "FactoreOne - Log", kind: "masterData" }
  ]
};
