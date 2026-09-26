import { assertWriteAllowed, type IntegrationConfig } from "../config/integration";
import {
  boundaryOf,
  buildBatch,
  isWriteBatch,
  parseBatchResponse,
  type BatchPart,
  type BatchResult,
  type HttpMethod
} from "./batch";
import {
  ServiceLayerError,
  isSessionExpired,
  networkError,
  translateServiceLayerError
} from "./errors";
import type { SessionInfo, SessionProvider } from "./SessionProvider";
import { DEFAULT_BASE_PATH, type FetchLike, type FetchResponseLike } from "./types";

export interface ServiceLayerClientOptions {
  config: IntegrationConfig;
  session: SessionProvider;
  fetch: FetchLike;
  basePath?: string;
  /** Gera os sufixos dos boundaries do $batch. Injetável para testes. */
  newId?: () => string;
}

export interface BatchOptions {
  /** Padrão `true`: lança o primeiro erro. Com `false`, devolve todos os resultados para o chamador decidir. */
  throwOnError?: boolean;
}

interface RawResponse {
  status: number;
  text: string;
  headers: FetchResponseLike["headers"];
}

export class ServiceLayerClient {
  private readonly config: IntegrationConfig;
  private readonly sessionProvider: SessionProvider;
  private readonly fetchFn: FetchLike;
  private readonly basePath: string;
  private readonly newId: () => string;
  private sessionPromise?: Promise<SessionInfo>;

  constructor(options: ServiceLayerClientOptions) {
    this.config = options.config;
    this.sessionProvider = options.session;
    this.fetchFn = options.fetch;
    this.basePath = options.basePath ?? DEFAULT_BASE_PATH;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  get<T = unknown>(path: string): Promise<T | undefined> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown): Promise<T | undefined> {
    return this.request<T>("POST", path, body);
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T | undefined> {
    return this.request<T>("PATCH", path, body);
  }

  delete(path: string): Promise<undefined> {
    return this.request<undefined>("DELETE", path);
  }

  /** Devolve o JSON da resposta, ou `undefined` quando vazia (ex.: 204). Erros viram `ServiceLayerError`. */
  async request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T | undefined> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.send(method, this.url(path), headers, {
      body: body === undefined ? undefined : JSON.stringify(body),
      write: method !== "GET"
    });

    if (response.status >= 400) throw translateServiceLayerError(response.status, response.text);
    if (!response.text.trim()) return undefined;
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new ServiceLayerError("Resposta do Service Layer não é um JSON válido.", response.status);
    }
  }

  /**
   * Envia um `$batch`. Cada item é uma operação avulsa (só leitura, na prática) ou um `{ changeset }`
   * atômico. Os resultados voltam na ordem enviada, com os changesets achatados.
   * Em falha de um changeset, o Service Layer desfaz o conjunto e devolve o erro dele.
   */
  async batch(parts: readonly BatchPart[], options: BatchOptions = {}): Promise<BatchResult[]> {
    const built = buildBatch(parts, this.basePath, this.newId);
    const response = await this.send(
      "POST",
      this.url("$batch"),
      { "Content-Type": built.contentType, Accept: "multipart/mixed" },
      { body: built.body, write: isWriteBatch(parts) }
    );

    if (response.status >= 400) throw translateServiceLayerError(response.status, response.text);

    const boundary = boundaryOf(response.headers.get("content-type"));
    if (!boundary) {
      throw new ServiceLayerError("Resposta de $batch sem boundary.", response.status);
    }

    const results = parseBatchResponse(response.text, boundary);
    if (options.throwOnError !== false) {
      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
    }
    return results;
  }

  private url(path: string): string {
    return `${this.config.serviceLayerUrl}${this.basePath}/${path.replace(/^\/+/, "")}`;
  }

  private getSession(): Promise<SessionInfo> {
    if (!this.sessionPromise) {
      const pending = this.sessionProvider.acquire();
      this.sessionPromise = pending;
      // Falha de login não fica em cache: a próxima chamada tenta de novo.
      pending.catch(() => {
        if (this.sessionPromise === pending) this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  /**
   * Envia com a sessão atual. Se o Service Layer responder que a sessão expirou, descarta, obtém
   * outra e reenvia uma única vez (um 401 significa que a requisição não foi processada).
   * Requisições simultâneas compartilham a mesma renovação.
   */
  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    { body, write }: { body?: string; write: boolean }
  ): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      const sessionPromise = this.getSession();
      const session = await sessionPromise;

      // Sessão por credenciais é de ferramenta/teste: escrita só em dev/test (CLAUDE.md, seção 7).
      // Sessão do Web Client (SSO) é a operação real do cliente e não passa por esta trava.
      if (write && session.kind === "cookie") assertWriteAllowed(this.config);

      const requestHeaders = { ...headers };
      if (session.kind === "cookie") {
        requestHeaders.Cookie =
          `B1SESSION=${session.sessionId}` + (session.routeId ? `; ROUTEID=${session.routeId}` : "");
      }

      let response: FetchResponseLike;
      try {
        response = await this.fetchFn(url, {
          method,
          headers: requestHeaders,
          body,
          credentials: session.kind === "host" ? "include" : undefined
        });
      } catch (cause) {
        throw networkError(cause);
      }

      const text = await response.text();
      if (attempt === 0 && isSessionExpired(response.status, text)) {
        if (this.sessionPromise === sessionPromise) this.sessionPromise = undefined;
        continue;
      }
      return { status: response.status, text, headers: response.headers };
    }
  }
}
