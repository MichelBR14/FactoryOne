// Valores monetários como inteiros (bigint) em unidade menor (centavos com decimals = 2).
// Proibido somar valores com float. Números do Service Layer entram por fromNumber().

export type Minor = bigint;

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new RangeError(`Casas decimais inválidas: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/** a / b arredondando meio para longe do zero. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("Divisão por zero");
  const negative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (2n * absA + absB) / (2n * absB);
  return negative ? -q : q;
}

/** (a × b) / c com arredondamento e sem perda de precisão intermediária. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return divRound(a * b, c);
}

/** Texto decimal com ponto ("1234.56") → unidade menor. Casas a mais são arredondadas. */
export function parseDecimal(input: string, decimals = 2): Minor {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new SyntaxError(`Valor decimal inválido: "${input}"`);
  const [, sign, intPart = "0", fracPart = ""] = match;
  const scale = pow10(decimals);
  let minor: bigint;
  if (fracPart.length <= decimals) {
    minor = BigInt(intPart) * scale + BigInt(fracPart.padEnd(decimals, "0") || "0");
  } else {
    const digits = BigInt(intPart + fracPart);
    minor = divRound(digits, 10n ** BigInt(fracPart.length - decimals));
  }
  return sign ? -minor : minor;
}

/** Número vindo do Service Layer (JSON) → unidade menor. */
export function fromNumber(value: number, decimals = 2): Minor {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) {
    throw new RangeError(`Número fora do intervalo suportado: ${value}`);
  }
  return parseDecimal(value.toFixed(decimals), decimals);
}

/** Unidade menor → texto decimal com ponto ("1234.56"). */
export function formatDecimal(minor: Minor, decimals = 2): string {
  const scale = pow10(decimals);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const intPart = abs / scale;
  const fracPart = abs % scale;
  const frac = decimals > 0 ? `.${fracPart.toString().padStart(decimals, "0")}` : "";
  return `${negative && abs !== 0n ? "-" : ""}${intPart}${frac}`;
}

/** Unidade menor → number, apenas para enviar ao Service Layer. Não fazer contas com o resultado. */
export function toNumber(minor: Minor, decimals = 2): number {
  return Number(formatDecimal(minor, decimals));
}

export function sum(values: readonly Minor[]): Minor {
  return values.reduce((acc, v) => acc + v, 0n);
}
