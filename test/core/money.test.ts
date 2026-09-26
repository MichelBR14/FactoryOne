import { describe, expect, it } from "vitest";
import {
  divRound,
  formatDecimal,
  fromNumber,
  mulDiv,
  parseDecimal,
  sum,
  toNumber
} from "../../webapp/core/util/money";

describe("parseDecimal", () => {
  it("converte texto para centavos", () => {
    expect(parseDecimal("1234.56")).toBe(123456n);
    expect(parseDecimal("0.05")).toBe(5n);
    expect(parseDecimal("10")).toBe(1000n);
    expect(parseDecimal("-7.5")).toBe(-750n);
  });

  it("arredonda meio para longe do zero quando há casas a mais", () => {
    expect(parseDecimal("0.005")).toBe(1n);
    expect(parseDecimal("-0.005")).toBe(-1n);
    expect(parseDecimal("1.004")).toBe(100n);
  });

  it("respeita outras casas decimais", () => {
    expect(parseDecimal("1.2345", 4)).toBe(12345n);
    expect(parseDecimal("12", 0)).toBe(12n);
  });

  it("rejeita formatos inválidos", () => {
    expect(() => parseDecimal("1,50")).toThrow(SyntaxError);
    expect(() => parseDecimal("abc")).toThrow(SyntaxError);
    expect(() => parseDecimal("")).toThrow(SyntaxError);
  });
});

describe("formatDecimal", () => {
  it("formata com o número de casas", () => {
    expect(formatDecimal(123456n)).toBe("1234.56");
    expect(formatDecimal(5n)).toBe("0.05");
    expect(formatDecimal(-750n)).toBe("-7.50");
    expect(formatDecimal(0n)).toBe("0.00");
    expect(formatDecimal(12n, 0)).toBe("12");
  });

  it("é o inverso de parseDecimal", () => {
    for (const text of ["0.00", "0.01", "-0.01", "999999999.99", "-123.45"]) {
      expect(formatDecimal(parseDecimal(text))).toBe(text);
    }
  });
});

describe("fromNumber / toNumber", () => {
  it("corrige o ruído de ponto flutuante do Service Layer", () => {
    expect(fromNumber(0.1 + 0.2)).toBe(30n);
    expect(fromNumber(1234.56)).toBe(123456n);
    expect(fromNumber(-19.99)).toBe(-1999n);
  });

  it("rejeita NaN, infinito e valores fora do intervalo", () => {
    expect(() => fromNumber(Number.NaN)).toThrow(RangeError);
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => fromNumber(1e15)).toThrow(RangeError);
  });

  it("volta para number só na saída", () => {
    expect(toNumber(123456n)).toBe(1234.56);
  });
});

describe("divRound / mulDiv", () => {
  it("arredonda meio para longe do zero", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(5n, -2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
  });

  it("rejeita divisão por zero", () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });

  it("multiplica antes de dividir sem perder precisão", () => {
    // 100,00 × 1/3 = 33,33
    expect(mulDiv(10000n, 1n, 3n)).toBe(3333n);
    // valores grandes que estourariam um number
    expect(mulDiv(10n ** 15n, 10n ** 6n, 10n ** 6n)).toBe(10n ** 15n);
  });
});

describe("sum", () => {
  it("soma sem erro de ponto flutuante", () => {
    const values = [parseDecimal("0.10"), parseDecimal("0.20")];
    expect(sum(values)).toBe(30n);
    expect(sum([])).toBe(0n);
  });
});
