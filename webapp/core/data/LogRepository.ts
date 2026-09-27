// Log de processamentos na FBO_LOG: módulo, rotina, usuário, início/fim, status, mensagem e documento.
import { tableName, type ModuleCode } from "../config/product";
import type { SlReadWrite } from "./SetupRepository";

// TODO [CONFIRMAR] o nome da entidade do UDO no Service Layer (código do UDO com ou sem `U_`).
const ENTITY = tableName("core", "LOG");
// Limites da FBO_LOG (ver definitions/core.ts); o Name do UDO aceita até 100 caracteres.
const MAX_NAME = 100;

export type LogStatus = "RUNNING" | "OK" | "ERROR";

export interface LogStart {
  module: ModuleCode;
  routine: string;
  /** Usuário do B1 que executou. */
  user: string;
  /** Referência do documento (ex.: `FO-GGF-2026-09`), quando já se conhece. */
  docRef?: string;
}

export interface LogFinish {
  status: Exclude<LogStatus, "RUNNING">;
  message?: string;
  docRef?: string;
}

/** Identifica a linha aberta por `start`, para `finish` fechá-la. */
export interface LogHandle {
  code: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// TODO [CONFIRMAR] o formato de hora aceito pelo Service Layer em campo de data com subtipo hora.
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export class LogRepository {
  constructor(
    private readonly client: SlReadWrite,
    private readonly now: () => Date = () => new Date(),
    private readonly newCode: () => string = () => crypto.randomUUID()
  ) {}

  async start(entry: LogStart): Promise<LogHandle> {
    const code = this.newCode();
    const started = this.now();
    await this.client.post(ENTITY, {
      Code: code,
      Name: entry.routine.slice(0, MAX_NAME),
      U_Module: entry.module,
      U_Routine: entry.routine,
      U_UserCode: entry.user,
      U_StartDate: dateOf(started),
      U_StartTime: timeOf(started),
      U_Status: "RUNNING" satisfies LogStatus,
      ...(entry.docRef !== undefined && { U_DocRef: entry.docRef })
    });
    return { code };
  }

  async finish(handle: LogHandle, result: LogFinish): Promise<void> {
    const ended = this.now();
    await this.client.patch(`${ENTITY}('${handle.code}')`, {
      U_EndDate: dateOf(ended),
      U_EndTime: timeOf(ended),
      U_Status: result.status,
      ...(result.message !== undefined && { U_Message: result.message }),
      ...(result.docRef !== undefined && { U_DocRef: result.docRef })
    });
  }

  /**
   * Registra a rotina em volta de `work`: abre a linha, executa e fecha com OK ou ERROR.
   * Se `work` falhar, o erro original sempre é o que sobe, mesmo que fechar o log também falhe.
   * Se não der para abrir o log, `work` não roda: rotina sem rastro não deve executar.
   */
  async run<T>(entry: LogStart, work: (handle: LogHandle) => Promise<T>): Promise<T> {
    const handle = await this.start(entry);
    let result: T;
    try {
      result = await work(handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(handle, { status: "ERROR", message }).catch(() => undefined);
      throw error;
    }
    await this.finish(handle, { status: "OK" });
    return result;
  }
}
