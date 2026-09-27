import { describe, expect, it } from "vitest";
import { LogRepository } from "../../../webapp/core/data/LogRepository";
import { SL_ERROR } from "../service/fakeFetch";
import { createFakeServiceLayer } from "./fakeServiceLayer";

// Datas locais, para o teste não depender do fuso da máquina.
const clock = (...dates: Date[]) => {
  let i = 0;
  return () => dates[Math.min(i++, dates.length - 1)]!;
};
const t0 = new Date(2026, 8, 26, 9, 5, 7);
const t1 = new Date(2026, 8, 26, 9, 6, 30);

const entry = { module: "ggf", routine: "Simular apuração 2026-09", user: "manager" } as const;

describe("LogRepository", () => {
  it("start grava a linha em andamento com data e hora de início", async () => {
    const sl = createFakeServiceLayer();
    const log = new LogRepository(sl.client, clock(t0), () => "L1");

    const handle = await log.start({ ...entry, docRef: "FO-GGF-2026-09" });

    expect(handle).toEqual({ code: "L1" });
    expect(sl.log.get("L1")).toEqual({
      Code: "L1",
      Name: "Simular apuração 2026-09",
      U_Module: "ggf",
      U_Routine: "Simular apuração 2026-09",
      U_UserCode: "manager",
      U_StartDate: "2026-09-26",
      U_StartTime: "09:05:07",
      U_Status: "RUNNING",
      U_DocRef: "FO-GGF-2026-09"
    });
  });

  it("finish fecha a linha com fim, status e mensagem", async () => {
    const sl = createFakeServiceLayer();
    const log = new LogRepository(sl.client, clock(t0, t1), () => "L1");

    const handle = await log.start(entry);
    await log.finish(handle, { status: "ERROR", message: "Período fechado" });

    expect(sl.log.get("L1")).toMatchObject({
      U_Status: "ERROR",
      U_Message: "Período fechado",
      U_EndDate: "2026-09-26",
      U_EndTime: "09:06:30",
      U_StartTime: "09:05:07"
    });
  });

  it("corta o Name do UDO em 100 caracteres, mas guarda a rotina inteira", async () => {
    const sl = createFakeServiceLayer();
    const routine = "x".repeat(120);
    await new LogRepository(sl.client, clock(t0), () => "L1").start({ ...entry, routine });
    expect(String(sl.log.get("L1")?.Name)).toHaveLength(100);
    expect(sl.log.get("L1")?.U_Routine).toBe(routine);
  });

  it("run fecha com OK e devolve o resultado", async () => {
    const sl = createFakeServiceLayer();
    const log = new LogRepository(sl.client, clock(t0, t1), () => "L1");

    const value = await log.run(entry, async () => 42);

    expect(value).toBe(42);
    expect(sl.log.get("L1")).toMatchObject({ U_Status: "OK" });
    expect(sl.log.get("L1")).not.toHaveProperty("U_Message");
  });

  it("run fecha com ERROR e relança o erro original", async () => {
    const sl = createFakeServiceLayer();
    const log = new LogRepository(sl.client, clock(t0, t1), () => "L1");
    const boom = new Error("falhou no meio");

    await expect(log.run(entry, async () => Promise.reject(boom))).rejects.toBe(boom);

    expect(sl.log.get("L1")).toMatchObject({ U_Status: "ERROR", U_Message: "falhou no meio" });
  });

  it("run relança o erro da rotina mesmo se fechar o log também falhar", async () => {
    const sl = createFakeServiceLayer({
      fail: (call) => (call.method === "PATCH" ? SL_ERROR(500, -1, "sem log") : undefined)
    });
    const log = new LogRepository(sl.client, clock(t0, t1), () => "L1");
    const boom = new Error("erro da rotina");

    await expect(log.run(entry, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("run propaga a falha de fechar o log quando a rotina deu certo", async () => {
    const sl = createFakeServiceLayer({
      fail: (call) => (call.method === "PATCH" ? SL_ERROR(500, -1, "sem log") : undefined)
    });
    const log = new LogRepository(sl.client, clock(t0, t1), () => "L1");

    await expect(log.run(entry, async () => "ok")).rejects.toThrow(/Erro interno/);
  });

  it("run não executa a rotina se não conseguir abrir o log", async () => {
    const sl = createFakeServiceLayer({
      fail: (call) => (call.method === "POST" ? SL_ERROR(400, -1, "recusado") : undefined)
    });
    const log = new LogRepository(sl.client, clock(t0), () => "L1");
    let ran = false;

    await expect(
      log.run(entry, async () => {
        ran = true;
      })
    ).rejects.toThrow(/recusou/);
    expect(ran).toBe(false);
  });
});
