import type { IntegrationConfig } from "../config/integration";
import { ServiceLayerError, loginError, networkError } from "./errors";
import { DEFAULT_BASE_PATH, type FetchLike } from "./types";

export type SessionInfo =
  /** Sessão explícita: o cliente envia os cookies B1SESSION/ROUTEID (ferramentas, testes, Node). */
  | { kind: "cookie"; sessionId: string; routeId?: string }
  /** Sessão gerenciada pelo Web Client: o browser envia os cookies (SSO). */
  | { kind: "host" };

/**
 * De onde vem a sessão do Service Layer. O cliente não sabe como ela é obtida.
 * `acquire()` é chamado na primeira requisição e de novo quando a sessão expira.
 *
 * TODO [CONFIRMAR] como a extensão obtém a sessão por SSO no Web Client (FP 2608). A implementação
 * de SSO será outra classe que implementa esta interface; nenhum outro código precisa mudar.
 */
export interface SessionProvider {
  acquire(): Promise<SessionInfo>;
}

/**
 * Login com usuário e senha do `.env`. Só para desenvolvimento, testes e ferramentas:
 * em produção a sessão vem por SSO.
 */
export class CredentialsSessionProvider implements SessionProvider {
  constructor(
    private readonly config: IntegrationConfig,
    private readonly fetchFn: FetchLike,
    private readonly basePath: string = DEFAULT_BASE_PATH
  ) {}

  async acquire(): Promise<SessionInfo> {
    const { userName, password } = this.config;
    if (!userName || !password) {
      throw new ServiceLayerError(
        "Login por credenciais requer FBO_SL_USER e FBO_SL_PASSWORD.",
        0
      );
    }

    let response;
    try {
      response = await this.fetchFn(`${this.config.serviceLayerUrl}${this.basePath}/Login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          CompanyDB: this.config.companyDb,
          UserName: userName,
          Password: password
        })
      });
    } catch (cause) {
      throw networkError(cause);
    }

    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw loginError(response.status, text);
    }

    let sessionId: unknown;
    try {
      sessionId = (JSON.parse(text) as { SessionId?: unknown }).SessionId;
    } catch {
      sessionId = undefined;
    }
    if (typeof sessionId !== "string" || !sessionId) {
      throw new ServiceLayerError("Resposta de login sem SessionId.", response.status);
    }

    const routeId = /ROUTEID=([^;,\s]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    return { kind: "cookie", sessionId, routeId };
  }
}
