// Configuração de integração por cliente. Pura: recebe as variáveis (process.env, .env carregado
// pelo tooling ou parâmetros do app) e devolve um objeto validado. Nunca registra a senha em log.

export type Environment = "dev" | "test" | "prod";

export interface IntegrationConfig {
  environment: Environment;
  serviceLayerUrl: string;
  companyDb: string;
  /** Vazios quando a sessão vem por SSO do Web Client. */
  userName?: string;
  password?: string;
  verifyTls: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const ENVIRONMENTS: readonly Environment[] = ["dev", "test", "prod"];

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Configuração de integração ausente: ${key}`);
  return value;
}

export function loadIntegrationConfig(env: Env): IntegrationConfig {
  // Sem FBO_ENV assume "prod" (o mais restritivo): escrita só com opt-in explícito.
  const rawEnvironment = env.FBO_ENV?.trim() || "prod";
  if (!ENVIRONMENTS.includes(rawEnvironment as Environment)) {
    throw new Error(`FBO_ENV inválido: "${rawEnvironment}" (use dev, test ou prod)`);
  }

  const url = new URL(required(env, "FBO_SL_URL"));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FBO_SL_URL deve começar com http:// ou https://");
  }

  const userName = env.FBO_SL_USER?.trim() || undefined;
  const password = env.FBO_SL_PASSWORD || undefined;
  if (Boolean(userName) !== Boolean(password)) {
    throw new Error("Informe FBO_SL_USER e FBO_SL_PASSWORD juntos, ou nenhum (SSO)");
  }

  return {
    environment: rawEnvironment as Environment,
    serviceLayerUrl: url.origin,
    companyDb: required(env, "FBO_SL_COMPANY_DB"),
    userName,
    password,
    verifyTls: env.FBO_SL_VERIFY_TLS?.trim().toLowerCase() !== "false"
  };
}

/** Regra da seção 7 do CLAUDE.md: POST/PATCH/DELETE só em ambiente de desenvolvimento/teste. */
export function assertWriteAllowed(config: IntegrationConfig): void {
  if (config.environment === "prod") {
    throw new Error("Escrita no Service Layer bloqueada: FBO_ENV=prod");
  }
}

/** Versão segura para log: sem a senha. */
export function describeConfig(config: IntegrationConfig): string {
  const auth = config.userName ? `usuário ${config.userName}` : "SSO";
  return `${config.serviceLayerUrl} / ${config.companyDb} (${config.environment}, ${auth})`;
}
