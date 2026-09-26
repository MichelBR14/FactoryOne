// Erros do Service Layer e tradução para mensagens legíveis ao usuário.
// TODO: mover os textos para o i18n do núcleo (/webapp/i18n) quando ele existir.

export class ServiceLayerError extends Error {
  constructor(
    /** Mensagem legível, pronta para exibir ao usuário. */
    message: string,
    /** Status HTTP; 0 quando não houve resposta (rede). */
    readonly status: number,
    /** Código de erro do Service Layer (`error.code`), quando vier no corpo. */
    readonly code?: number | string,
    /** Texto original do Service Layer (`error.message.value`), para log e diagnóstico. */
    readonly detail?: string
  ) {
    super(message);
    this.name = "ServiceLayerError";
  }
}

export interface ErrorMessages {
  network: string;
  sessionExpired: string;
  forbidden: string;
  notFound: string;
  badRequest: (detail?: string) => string;
  server: (status: number, detail?: string) => string;
  login: (detail?: string) => string;
  unknown: (status: number, detail?: string) => string;
}

const withDetail = (base: string, detail?: string): string => (detail ? `${base}: ${detail}` : base);

export const MESSAGES_PT_BR: ErrorMessages = {
  network: "Não foi possível conectar ao Service Layer. Verifique a rede e o endereço do servidor.",
  sessionExpired: "A sessão do Service Layer expirou ou é inválida. Entre novamente.",
  forbidden: "Você não tem permissão no SAP Business One para executar esta operação.",
  notFound: "Registro ou recurso não encontrado no SAP Business One.",
  badRequest: (detail) => withDetail("O SAP Business One recusou a requisição", detail),
  server: (status, detail) =>
    withDetail(`Erro interno no Service Layer (HTTP ${status})`, detail),
  login: (detail) => withDetail("Falha no login do Service Layer", detail),
  unknown: (status, detail) => withDetail(`Resposta inesperada do Service Layer (HTTP ${status})`, detail)
};

/**
 * Código de erro do Service Layer para sessão inválida/expirada.
 * TODO [CONFIRMAR] o código na FP 2608; o sinal principal é o HTTP 401.
 */
const SESSION_EXPIRED_CODE = 301;

export interface ParsedErrorBody {
  code?: number | string;
  message?: string;
}

/** Formato do Service Layer: `{"error":{"code":-2028,"message":{"lang":"en-us","value":"..."}}}`. */
export function parseErrorBody(bodyText: string | undefined): ParsedErrorBody {
  if (!bodyText) return {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (!error) return {};
    const rawMessage = error.message;
    const message =
      typeof rawMessage === "string"
        ? rawMessage
        : (rawMessage as { value?: unknown } | undefined)?.value;
    return {
      code: typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined,
      message: typeof message === "string" ? message : undefined
    };
  } catch {
    return {};
  }
}

export function isSessionExpired(status: number, bodyText: string | undefined): boolean {
  return status === 401 || Number(parseErrorBody(bodyText).code) === SESSION_EXPIRED_CODE;
}

export function translateServiceLayerError(
  status: number,
  bodyText: string | undefined,
  messages: ErrorMessages = MESSAGES_PT_BR
): ServiceLayerError {
  const { code, message: detail } = parseErrorBody(bodyText);
  const build = (text: string) => new ServiceLayerError(text, status, code, detail);

  if (isSessionExpired(status, bodyText)) return build(messages.sessionExpired);
  if (status === 403) return build(messages.forbidden);
  if (status === 404) return build(messages.notFound);
  if (status >= 500) return build(messages.server(status, detail));
  if (status >= 400) return build(messages.badRequest(detail));
  return build(messages.unknown(status, detail));
}

export function loginError(
  status: number,
  bodyText: string | undefined,
  messages: ErrorMessages = MESSAGES_PT_BR
): ServiceLayerError {
  const { code, message: detail } = parseErrorBody(bodyText);
  return new ServiceLayerError(messages.login(detail), status, code, detail);
}

export function networkError(cause: unknown, messages: ErrorMessages = MESSAGES_PT_BR): ServiceLayerError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ServiceLayerError(messages.network, 0, undefined, detail);
}
