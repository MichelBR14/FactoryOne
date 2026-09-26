/** Subconjunto mínimo do `fetch`, para o cliente ser testável com um fake e rodar no browser ou no Node. */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** "include" quando o cookie de sessão é gerenciado pelo Web Client (SSO). */
  credentials?: "include";
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

/**
 * Caminho base do Service Layer. `/b1s/v2` é a versão OData v4.
 * TODO [CONFIRMAR] o caminho na FP 2608 do cliente.
 */
export const DEFAULT_BASE_PATH = "/b1s/v2";
