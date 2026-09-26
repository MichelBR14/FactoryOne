// Montagem e leitura de requisições `$batch` (multipart/mixed) do Service Layer. Puro, sem HTTP.
import { ServiceLayerError, translateServiceLayerError } from "./errors";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface BatchOperation {
  method: HttpMethod;
  /** Relativo ao Service Layer, ex.: `JournalEntries` ou `Items('A001')`. */
  path: string;
  body?: unknown;
  /** Identificador devolvido em `BatchResult.contentId`. */
  contentId?: number;
}

/** Operações de escrita atômicas: se uma falhar, todas são desfeitas. GET não é permitido aqui. */
export interface ChangeSet {
  changeset: BatchOperation[];
}

export type BatchPart = BatchOperation | ChangeSet;

export interface BatchResult {
  status: number;
  contentId?: string;
  headers: Record<string, string>;
  /** JSON já convertido; texto puro se a resposta não for JSON; `undefined` se vazio. */
  body?: unknown;
  /** Preenchido quando `status >= 400`. */
  error?: ServiceLayerError;
}

const CRLF = "\r\n";

const isChangeSet = (part: BatchPart): part is ChangeSet => "changeset" in part;

export function isWriteBatch(parts: readonly BatchPart[]): boolean {
  return parts.some((part) =>
    isChangeSet(part) ? part.changeset.length > 0 : part.method !== "GET"
  );
}

function operationBlock(op: BatchOperation, basePath: string, contentId?: number): string[] {
  const path = op.path.replace(/^\/+/, "");
  const lines = ["Content-Type: application/http", "Content-Transfer-Encoding: binary"];
  if (contentId !== undefined) lines.push(`Content-ID: ${contentId}`);
  lines.push("", `${op.method} ${basePath}/${path} HTTP/1.1`);
  if (op.body !== undefined) {
    lines.push("Content-Type: application/json", "", JSON.stringify(op.body));
  } else {
    lines.push("");
  }
  return lines;
}

export interface BuiltBatch {
  contentType: string;
  body: string;
}

/** `newId` gera os sufixos dos boundaries (injetável para testes determinísticos). */
export function buildBatch(
  parts: readonly BatchPart[],
  basePath: string,
  newId: () => string
): BuiltBatch {
  if (parts.length === 0) throw new RangeError("$batch sem operações");

  const batchBoundary = `batch_${newId()}`;
  const lines: string[] = [];
  let nextContentId = 1;

  for (const part of parts) {
    lines.push(`--${batchBoundary}`);
    if (isChangeSet(part)) {
      if (part.changeset.length === 0) throw new RangeError("changeset vazio");
      const changesetBoundary = `changeset_${newId()}`;
      lines.push(`Content-Type: multipart/mixed; boundary=${changesetBoundary}`, "");
      for (const op of part.changeset) {
        if (op.method === "GET") throw new RangeError("GET não é permitido dentro de um changeset");
        lines.push(`--${changesetBoundary}`);
        lines.push(...operationBlock(op, basePath, op.contentId ?? nextContentId++));
      }
      lines.push(`--${changesetBoundary}--`);
    } else {
      lines.push(...operationBlock(part, basePath));
    }
  }
  lines.push(`--${batchBoundary}--`, "");

  return {
    contentType: `multipart/mixed;boundary=${batchBoundary}`,
    body: lines.join(CRLF)
  };
}

// ---------------------------------------------------------------------------------------------
// Leitura da resposta

function splitHeadBody(text: string): [string, string] {
  const index = text.indexOf("\n\n");
  return index === -1 ? [text, ""] : [text.slice(0, index), text.slice(index + 2)];
}

function parseHeaders(head: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function boundaryOf(contentType: string | null | undefined): string | undefined {
  return /boundary="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
}

function splitParts(body: string, boundary: string): string[] {
  const segments = body.split(`--${boundary}`).slice(1);
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith("--")) break; // delimitador de fechamento
    parts.push(segment.replace(/^\n/, "").replace(/\n$/, ""));
  }
  return parts;
}

function parseHttpResponse(text: string, contentId: string | undefined): BatchResult {
  const [head, payload] = splitHeadBody(text);
  const [statusLine = "", ...headerLines] = head.split("\n");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) {
    throw new ServiceLayerError(`Resposta de $batch inválida: "${statusLine}"`, 0);
  }

  const trimmed = payload.trim();
  let body: unknown;
  if (trimmed) {
    try {
      body = JSON.parse(trimmed);
    } catch {
      body = trimmed;
    }
  }

  const result: BatchResult = {
    status,
    contentId,
    headers: parseHeaders(headerLines.join("\n")),
    body
  };
  if (status >= 400) result.error = translateServiceLayerError(status, trimmed);
  return result;
}

/** Lê o corpo `multipart/mixed` da resposta e devolve os resultados na ordem, com changesets achatados. */
export function parseBatchResponse(body: string, boundary: string): BatchResult[] {
  const results: BatchResult[] = [];
  for (const raw of splitParts(body.replace(/\r\n/g, "\n"), boundary)) {
    const [head, content] = splitHeadBody(raw);
    const headers = parseHeaders(head);
    const contentType = headers["content-type"] ?? "";
    const nested = contentType.toLowerCase().includes("multipart/mixed")
      ? boundaryOf(contentType)
      : undefined;
    if (nested) {
      results.push(...parseBatchResponse(content, nested));
    } else {
      results.push(parseHttpResponse(content, headers["content-id"]));
    }
  }
  return results;
}
