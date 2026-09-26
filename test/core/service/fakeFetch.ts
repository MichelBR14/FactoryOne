import type { FetchInit, FetchLike, FetchResponseLike } from "../../../webapp/core/service/types";

export interface RecordedCall {
  url: string;
  init: FetchInit;
}

export interface FakeReply {
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
}

export function reply({ status = 200, body = "", headers = {} }: FakeReply = {}): FetchResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text
  };
}

type Handler = FakeReply | Error | ((call: RecordedCall) => FakeReply | Error);

/** Fetch simulado: responde em ordem, registra as chamadas e falha se faltar resposta. Nada de rede. */
export function createFakeFetch(...handlers: Handler[]) {
  const calls: RecordedCall[] = [];
  const queue = [...handlers];

  const fetchFn: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Chamada inesperada ao fetch: ${init.method} ${url}`);
    const result = typeof next === "function" ? next(call) : next;
    if (result instanceof Error) throw result;
    return reply(result);
  };

  return { fetch: fetchFn, calls, remaining: () => queue.length };
}

export const LOGIN_OK = (sessionId: string, routeId?: string): FakeReply => ({
  status: 200,
  body: { SessionId: sessionId, Version: "1000000", SessionTimeout: 30 },
  headers: routeId ? { "Set-Cookie": `B1SESSION=${sessionId}; HttpOnly, ROUTEID=${routeId}; path=/b1s` } : {}
});

export const SL_ERROR = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { error: { code, message: { lang: "en-us", value: message } } }
});
