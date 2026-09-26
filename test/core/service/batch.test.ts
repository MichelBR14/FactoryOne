import { describe, expect, it } from "vitest";
import {
  boundaryOf,
  buildBatch,
  isWriteBatch,
  parseBatchResponse
} from "../../../webapp/core/service/batch";

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

describe("buildBatch", () => {
  it("monta um changeset com Content-ID sequencial", () => {
    const { contentType, body } = buildBatch(
      [
        {
          changeset: [
            { method: "POST", path: "JournalEntries", body: { Memo: "a" } },
            { method: "POST", path: "/MaterialRevaluation", body: { Memo: "b" } }
          ]
        }
      ],
      "/b1s/v2",
      ids()
    );

    expect(contentType).toBe("multipart/mixed;boundary=batch_id1");
    expect(body).toBe(
      [
        "--batch_id1",
        "Content-Type: multipart/mixed; boundary=changeset_id2",
        "",
        "--changeset_id2",
        "Content-Type: application/http",
        "Content-Transfer-Encoding: binary",
        "Content-ID: 1",
        "",
        "POST /b1s/v2/JournalEntries HTTP/1.1",
        "Content-Type: application/json",
        "",
        '{"Memo":"a"}',
        "--changeset_id2",
        "Content-Type: application/http",
        "Content-Transfer-Encoding: binary",
        "Content-ID: 2",
        "",
        "POST /b1s/v2/MaterialRevaluation HTTP/1.1",
        "Content-Type: application/json",
        "",
        '{"Memo":"b"}',
        "--changeset_id2--",
        "--batch_id1--",
        ""
      ].join("\r\n")
    );
  });

  it("leitura avulsa fica fora de changeset e sem Content-ID", () => {
    const { body } = buildBatch([{ method: "GET", path: "Items('A1')" }], "/b1s/v2", ids());
    expect(body).toBe(
      [
        "--batch_id1",
        "Content-Type: application/http",
        "Content-Transfer-Encoding: binary",
        "",
        "GET /b1s/v2/Items('A1') HTTP/1.1",
        "",
        "--batch_id1--",
        ""
      ].join("\r\n")
    );
  });

  it("respeita contentId explícito e mistura leitura com changesets", () => {
    const { body } = buildBatch(
      [
        { method: "GET", path: "Items" },
        { changeset: [{ method: "PATCH", path: "Items('A1')", body: { X: 1 }, contentId: 7 }] },
        { changeset: [{ method: "DELETE", path: "Items('A2')" }] }
      ],
      "/b1s/v2",
      ids()
    );
    expect(body).toContain("Content-ID: 7");
    expect(body).toContain("PATCH /b1s/v2/Items('A1') HTTP/1.1");
    expect(body).toContain("DELETE /b1s/v2/Items('A2') HTTP/1.1");
    expect(body.match(/boundary=changeset_/g)).toHaveLength(2);
  });

  it("rejeita batch vazio, changeset vazio e GET dentro de changeset", () => {
    expect(() => buildBatch([], "/b1s/v2", ids())).toThrow(/sem operações/);
    expect(() => buildBatch([{ changeset: [] }], "/b1s/v2", ids())).toThrow(/vazio/);
    expect(() =>
      buildBatch([{ changeset: [{ method: "GET", path: "Items" }] }], "/b1s/v2", ids())
    ).toThrow(/GET/);
  });
});

describe("isWriteBatch", () => {
  it("só leituras não são escrita", () => {
    expect(isWriteBatch([{ method: "GET", path: "Items" }])).toBe(false);
    expect(isWriteBatch([{ method: "GET", path: "Items" }, { changeset: [{ method: "POST", path: "X" }] }])).toBe(true);
    expect(isWriteBatch([{ method: "DELETE", path: "X" }])).toBe(true);
  });
});

describe("boundaryOf", () => {
  it("extrai o boundary com ou sem aspas", () => {
    expect(boundaryOf("multipart/mixed;boundary=b_1")).toBe("b_1");
    expect(boundaryOf('multipart/mixed; boundary="b_2"')).toBe("b_2");
    expect(boundaryOf(null)).toBeUndefined();
  });
});

describe("parseBatchResponse", () => {
  const changesetOk = [
    "--b_1",
    "Content-Type: multipart/mixed; boundary=cs_1",
    "",
    "--cs_1",
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "Content-ID: 1",
    "",
    "HTTP/1.1 201 Created",
    "Content-Type: application/json;odata.metadata=minimal",
    "Location: https://sl/b1s/v2/JournalEntries(10)",
    "",
    '{"JdtNum":10}',
    "--cs_1",
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "Content-ID: 2",
    "",
    "HTTP/1.1 204 No Content",
    "",
    "",
    "--cs_1--",
    "--b_1--",
    ""
  ];

  it("lê changeset com CRLF, achatando as respostas em ordem", () => {
    const results = parseBatchResponse(changesetOk.join("\r\n"), "b_1");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: 201, contentId: "1", body: { JdtNum: 10 } });
    expect(results[0]?.headers.location).toBe("https://sl/b1s/v2/JournalEntries(10)");
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]).toMatchObject({ status: 204, contentId: "2", body: undefined });
  });

  it("lê a mesma resposta com LF", () => {
    expect(parseBatchResponse(changesetOk.join("\n"), "b_1")).toHaveLength(2);
  });

  it("changeset com falha vira um resultado com erro traduzido", () => {
    const text = [
      "--b_1",
      "Content-Type: multipart/mixed; boundary=cs_1",
      "",
      "--cs_1",
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      "",
      "HTTP/1.1 400 Bad Request",
      "Content-Type: application/json",
      "",
      '{"error":{"code":-5002,"message":{"lang":"en-us","value":"Period is locked"}}}',
      "--cs_1--",
      "--b_1--",
      ""
    ].join("\r\n");

    const [result] = parseBatchResponse(text, "b_1");
    expect(result?.status).toBe(400);
    expect(result?.error?.message).toBe("O SAP Business One recusou a requisição: Period is locked");
    expect(result?.error?.code).toBe(-5002);
  });

  it("lê resposta avulsa (GET) fora de changeset", () => {
    const text = [
      "--b_1",
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      '{"ItemCode":"A1"}',
      "--b_1--",
      ""
    ].join("\r\n");
    expect(parseBatchResponse(text, "b_1")).toEqual([
      expect.objectContaining({ status: 200, body: { ItemCode: "A1" } })
    ]);
  });

  it("mantém texto que não é JSON", () => {
    const text = [
      "--b_1",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 502 Bad Gateway",
      "",
      "gateway",
      "--b_1--"
    ].join("\n");
    const [result] = parseBatchResponse(text, "b_1");
    expect(result?.body).toBe("gateway");
    expect(result?.error?.status).toBe(502);
  });

  it("rejeita status line inválida", () => {
    const text = ["--b_1", "Content-Type: application/http", "", "lixo", "", "--b_1--"].join("\n");
    expect(() => parseBatchResponse(text, "b_1")).toThrow(/inválida/);
  });
});
