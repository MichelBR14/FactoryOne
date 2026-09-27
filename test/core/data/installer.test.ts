import { describe, expect, it } from "vitest";
import { CORE_METADATA } from "../../../webapp/core/data/definitions/core";
import { MetadataInstaller } from "../../../webapp/core/data/MetadataInstaller";
import { SetupRepository } from "../../../webapp/core/data/SetupRepository";
import { SL_ERROR } from "../service/fakeFetch";
import { createFakeServiceLayer } from "./fakeServiceLayer";

const FIELDS_IN_CORE = CORE_METADATA.tables.reduce((n, t) => n + t.fields.length, 0);
const ACTIONS_IN_CORE = CORE_METADATA.tables.length + FIELDS_IN_CORE + CORE_METADATA.objects.length;

describe("MetadataInstaller", () => {
  it("instala o núcleo do zero: tabelas, campos, objetos e a versão", async () => {
    const sl = createFakeServiceLayer();
    const result = await new MetadataInstaller(sl.client).install(CORE_METADATA);

    expect(result.failed).toBeUndefined();
    expect(result.done).toHaveLength(ACTIONS_IN_CORE);
    expect(result.versionRecorded).toBe(true);
    expect([...sl.tables.keys()]).toEqual(["FBO_SETUP", "FBO_LIC", "FBO_LOG"]);
    expect(sl.fields).toHaveLength(FIELDS_IN_CORE);
    expect([...sl.objects.keys()]).toEqual(["FBO_SETUP", "FBO_LIC", "FBO_LOG"]);
    expect(sl.setup.get("core")).toMatchObject({ Code: "core", U_Version: "1" });
  });

  it("é idempotente: a segunda execução não grava nada", async () => {
    const sl = createFakeServiceLayer();
    const installer = new MetadataInstaller(sl.client);
    await installer.install(CORE_METADATA);
    const writesAfterFirst = sl.posts().length;

    const second = await installer.install(CORE_METADATA);

    expect(second.plan.actions).toEqual([]);
    expect(second.done).toEqual([]);
    expect(second.versionRecorded).toBe(false);
    expect(sl.posts()).toHaveLength(writesAfterFirst);
  });

  it("plan() só lê: não faz POST nem PATCH", async () => {
    const sl = createFakeServiceLayer();
    const plan = await new MetadataInstaller(sl.client).plan(CORE_METADATA);
    expect(plan.actions).toHaveLength(ACTIONS_IN_CORE);
    expect(sl.posts()).toEqual([]);
  });

  it("para na primeira falha, não grava a versão e a nova execução continua de onde parou", async () => {
    let failOnce = true;
    const sl = createFakeServiceLayer({
      fail: (call) => {
        if (failOnce && call.method === "POST" && call.body?.Name === "Routine") {
          failOnce = false;
          return SL_ERROR(400, -5002, "Field already in use");
        }
        return undefined;
      }
    });
    const installer = new MetadataInstaller(sl.client);

    const first = await installer.install(CORE_METADATA);
    expect(first.failed?.action.description).toBe("Criar campo FBO_LOG.U_Routine");
    expect(first.failed?.message).toMatch(/Field already in use/);
    expect(first.versionRecorded).toBe(false);
    expect(sl.setup.size).toBe(0);
    expect(sl.objects.size).toBe(0);

    const second = await installer.install(CORE_METADATA);
    expect(second.failed).toBeUndefined();
    expect(second.done.map((a) => a.kind)).not.toContain("createTable");
    expect(second.done[0]?.description).toBe("Criar campo FBO_LOG.U_Routine");
    expect(sl.fields).toHaveLength(FIELDS_IN_CORE);
    expect(sl.setup.get("core")).toMatchObject({ U_Version: "1" });
  });

  it("completa só o que falta numa tabela que já existe e avisa divergência", async () => {
    const sl = createFakeServiceLayer();
    sl.tables.set("FBO_SETUP", { TableName: "FBO_SETUP" });
    sl.fields.push({ TableName: "@FBO_SETUP", Name: "Version", Type: "db_Alpha", Size: 10 });

    const plan = await new MetadataInstaller(sl.client).plan(CORE_METADATA);

    expect(plan.actions.map((a) => a.description)).not.toContain("Criar tabela FBO_SETUP");
    expect(plan.actions.map((a) => a.description)).not.toContain("Criar campo FBO_SETUP.U_Version");
    expect(plan.actions.map((a) => a.description)).toContain("Criar campo FBO_SETUP.U_InstDate");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/U_Version.*tamanho 10.*20/);
  });

  it("lê os campos existentes por todas as páginas (nextLink com caminho base)", async () => {
    const sl = createFakeServiceLayer({ pageSize: 3 });
    const installer = new MetadataInstaller(sl.client);
    await installer.install(CORE_METADATA);

    const again = await installer.plan(CORE_METADATA);

    expect(again.actions).toEqual([]);
    expect(sl.calls.filter((c) => c.path.includes("$skip=")).length).toBeGreaterThan(0);
  });

  it("propaga erro de leitura que não seja 404", async () => {
    const sl = createFakeServiceLayer({
      fail: (call) => (call.path.startsWith("UserTablesMD(") ? SL_ERROR(500, -1, "boom") : undefined)
    });
    await expect(new MetadataInstaller(sl.client).plan(CORE_METADATA)).rejects.toThrow(/Erro interno/);
  });

  it("não instala conjunto inválido e não chama o Service Layer para escrever", async () => {
    const sl = createFakeServiceLayer();
    await expect(new MetadataInstaller(sl.client).install({ ...CORE_METADATA, version: 0 })).rejects.toThrow(
      /Metadados inválidos/
    );
    expect(sl.posts()).toEqual([]);
  });
});

describe("SetupRepository", () => {
  it("cria a linha na primeira gravação e atualiza nas seguintes", async () => {
    const sl = createFakeServiceLayer();
    const repo = new SetupRepository(sl.client, () => new Date("2026-09-26T12:00:00Z"));

    expect(await repo.getInstalledVersion("core")).toBeUndefined();
    await repo.setInstalledVersion("core", 1);
    await repo.setInstalledVersion("core", 2);

    expect(await repo.getInstalledVersion("core")).toBe(2);
    expect(sl.setup.get("core")).toMatchObject({ U_Version: "2", U_InstDate: "2026-09-26" });
    expect(sl.posts().map((c) => c.method)).toEqual(["POST", "PATCH"]);
  });

  it("linha com versão ilegível é atualizada, não duplicada", async () => {
    const sl = createFakeServiceLayer();
    sl.setup.set("core", { Code: "core", U_Version: "abc" });
    const repo = new SetupRepository(sl.client);

    expect(await repo.getInstalledVersion("core")).toBeUndefined();
    await repo.setInstalledVersion("core", 1);

    expect(sl.posts().map((c) => c.method)).toEqual(["PATCH"]);
  });
});
