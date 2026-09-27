import { ServiceLayerClient } from "../../../webapp/core/service/ServiceLayerClient";
import type { FetchInit, FetchLike } from "../../../webapp/core/service/types";
import { loadIntegrationConfig } from "../../../webapp/core/config/integration";
import { reply, SL_ERROR, type FakeReply } from "../service/fakeFetch";

export interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface Options {
  /** Devolve uma resposta de erro para forçar falha numa chamada; `undefined` segue o fluxo normal. */
  fail?: (call: Call) => FakeReply | undefined;
  /** Tamanho da página de UserFieldsMD, para exercitar `nextLink`. */
  pageSize?: number;
}

const BASE = "https://sl.exemplo.com:50000/b1s/v2/";
const NOT_FOUND = () => SL_ERROR(404, -2028, "Not found");

/**
 * Service Layer simulado em memória, só o que o instalador usa: UserTablesMD, UserFieldsMD, UserObjectsMD
 * e a entidade do FBO_SETUP. Guarda o que é criado, então dá para testar idempotência e retomada.
 */
export function createFakeServiceLayer(options: Options = {}) {
  const tables = new Map<string, Record<string, unknown>>();
  const fields: Array<Record<string, unknown>> = [];
  const objects = new Map<string, Record<string, unknown>>();
  const setup = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];

  const ok = (body: unknown, status = 200): FakeReply => ({ status, body: body as object });

  const handle = (call: Call): FakeReply => {
    const injected = options.fail?.(call);
    if (injected) return injected;

    const { method, path, body } = call;
    const key = /\('([^']+)'\)/.exec(path)?.[1];

    if (method === "GET" && path.startsWith("UserTablesMD(")) {
      return key && tables.has(key) ? ok(tables.get(key)) : NOT_FOUND();
    }
    if (method === "GET" && path.startsWith("UserObjectsMD(")) {
      return key && objects.has(key) ? ok(objects.get(key)) : NOT_FOUND();
    }
    if (method === "GET" && path.startsWith("UserFieldsMD?")) {
      const rawTable = /TableName%20eq%20'([^']+)'/.exec(path)?.[1] ?? "";
      const skip = Number(/\$skip=(\d+)/.exec(path)?.[1] ?? 0);
      const all = fields.filter((f) => f.TableName === rawTable.replace("%40", "@"));
      const size = options.pageSize ?? all.length;
      const page = all.slice(skip, skip + size).map(({ Name, Type, Size }) => ({ Name, Type, Size }));
      const nextSkip = skip + size;
      // O nextLink repete o filtro e vem com o caminho base, como o Service Layer costuma devolver.
      const nextLink =
        nextSkip < all.length
          ? `/b1s/v2/UserFieldsMD?$filter=TableName%20eq%20'${rawTable}'&$skip=${nextSkip}`
          : undefined;
      return ok({ value: page, ...(nextLink ? { "odata.nextLink": nextLink } : {}) });
    }
    if (method === "POST" && path === "UserTablesMD") {
      tables.set(String(body?.TableName), body ?? {});
      return ok(body, 201);
    }
    if (method === "POST" && path === "UserFieldsMD") {
      fields.push(body ?? {});
      return ok(body, 201);
    }
    if (method === "POST" && path === "UserObjectsMD") {
      objects.set(String(body?.Code), body ?? {});
      return ok(body, 201);
    }
    if (path.startsWith("FBO_SETUP")) {
      if (method === "GET") return key && setup.has(key) ? ok(setup.get(key)) : NOT_FOUND();
      if (method === "POST") {
        setup.set(String(body?.Code), body ?? {});
        return ok(body, 201);
      }
      if (method === "PATCH" && key) {
        setup.set(key, { ...setup.get(key), ...body });
        return { status: 204 };
      }
    }
    return SL_ERROR(400, -1, `Fake: rota não tratada ${method} ${path}`);
  };

  const fetch: FetchLike = async (url: string, init: FetchInit) => {
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const call: Call = {
      method: init.method,
      path,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    };
    calls.push(call);
    return reply(handle(call));
  };

  const client = new ServiceLayerClient({
    config: loadIntegrationConfig({
      FBO_ENV: "dev",
      FBO_SL_URL: "https://sl.exemplo.com:50000",
      FBO_SL_COMPANY_DB: "SBO_TESTE"
    }),
    session: { acquire: async () => ({ kind: "host" }) },
    fetch
  });

  return {
    client,
    calls,
    tables,
    fields,
    objects,
    setup,
    posts: () => calls.filter((c) => c.method !== "GET")
  };
}
