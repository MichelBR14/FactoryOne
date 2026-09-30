import { describe, expect, it, vi, afterEach } from "vitest";

const modulePath = "../../scripts/ggf-sap-session.mjs";
const { createReadSession } = await import(modulePath);
const env = {
  FBO_ENV: "test",
  FBO_SL_COMPANY_DB: "SBODEMOBR2",
  FBO_SL_URL: "https://simulated.invalid",
  FBO_SL_USER: "TEST_ONLY_USER",
  FBO_SL_PASSWORD: "TEST_ONLY_NOT_A_SECRET"
};
const login = () =>
  new Response(
    JSON.stringify({ SessionId: "TEST-ONLY-SESSION", Version: "1000000", SessionTimeout: 30 }),
    { headers: { "Content-Type": "application/json", "Set-Cookie": "ROUTEID=.test; HttpOnly" } }
  );
afterEach(() => vi.unstubAllEnvs());
describe("local SAP transport security (no real connection)", () => {
  it.each([
    { FBO_ENV: "prod" },
    { FBO_SL_COMPANY_DB: "OTHER" },
    { FBO_SL_COMPANY_DB: "SBO_DEMO_ECOMMERCE" },
    { FBO_SL_URL: "http://simulated.invalid" },
    { FBO_SL_URL: "https://test:fake@simulated.invalid" },
    { FBO_SL_URL: "not a URL" },
    { FBO_SL_URL: "https://simulated.invalid/?secret=TEST" },
    { FBO_SL_PASSWORD: "" }
  ])("rejects unsafe configuration before transport %j", async (change) => {
    const transport = vi.fn();
    await expect(createReadSession({ ...env, ...change }, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects global TLS bypass", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const transport = vi.fn();
    await expect(createReadSession(env, transport)).rejects.toThrow("TLS override");
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses only GET for business reads, contains cookies and never follows redirects", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(new Response("0", { headers: { "Content-Type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const session = await createReadSession(env, transport);
    expect(JSON.stringify(session.info)).not.toMatch(/TEST_ONLY|SESSION|ROUTEID/);
    expect(session.post).toBeUndefined();
    expect((await session.get("ProductionOrders/$count")).data).toBe("0");
    await session.close();
    expect(transport.mock.calls.map((c) => c[1].method)).toEqual(["POST", "GET", "POST"]);
    expect(transport.mock.calls.map((c) => c[1].redirect)).toEqual(["error", "error", "error"]);
    expect(transport.mock.calls[1]![1].headers.Cookie).toContain("TEST-ONLY-SESSION");
  });
  it.each([
    "https://other.invalid",
    "//other.invalid",
    "/b1s/v2/JournalEntries",
    "../Login",
    "Login",
    "Logout",
    "foo\\bar"
  ])("rejects off-boundary path %s without transmitting a cookie", async (path) => {
    const transport = vi.fn().mockResolvedValue(login());
    const session = await createReadSession(env, transport);
    await expect(session.get(path)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("withholds response bodies and transport details from errors", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: -1, message: "TEST_ONLY_NOT_A_SECRET" } }), {
          status: 400
        })
      );
    const session = await createReadSession(env, transport);
    expect(await session.get("JournalEntries")).toEqual({ ok: false, status: 400, code: -1 });
    transport.mockRejectedValue(new Error("TEST_ONLY_NOT_A_SECRET"));
    await expect(session.get("JournalEntries")).rejects.toThrow("details withheld");
    await expect(session.close()).rejects.toThrow("details withheld");
  });
  it("preserves a string SAP error code without exposing the response body", async () => {
    const transport = vi.fn().mockResolvedValueOnce(login()).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "-1002", message: "Service Not Found" } }),
        { status: 400 })
    );
    const session = await createReadSession(env, transport);
    expect(await session.get("FBO_GGF_CVERS/$count")).toEqual({
      ok: false, status: 400, code: "-1002"
    });
  });
  it("permits only the fixed read-only FIFO action and never exposes its credentials", async () => {
    const transport=vi.fn().mockResolvedValueOnce(login())
      .mockResolvedValueOnce(new Response(JSON.stringify({Layers:[]}),{headers:{"Content-Type":"application/json"}}))
      .mockResolvedValueOnce(new Response(null,{status:204}));
    const session=await createReadSession(env,transport);
    await expect(session.readFifoLayers("../Items","01")).rejects.toThrow("scope");
    expect((await session.readFifoLayers("F1GGF26P01","01")).data.Layers).toEqual([]);
    expect(transport.mock.calls[1]![0]).toBe("https://simulated.invalid/b1s/v2/MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO");
    expect(JSON.parse(transport.mock.calls[1]![1].body)).toEqual({MaterialRevaluationFIFOParams:{
      ItemCode:"F1GGF26P01",LocationCode:"01",LocationType:"64",ShowIssuedLayers:"tNO"}});
    await session.close();
  });
});
