import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLocalTestHttpsTransport } from "../../scripts/ggf-local-test-https-transport.mjs";

describe("local expired-certificate HTTPS exception", () => {
  it("keeps HTTPS, scopes the unverified agent to one origin, and does not set a global TLS bypass", async () => {
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    req.write = vi.fn();
    req.end = vi.fn(() => {
      const response = new EventEmitter() as EventEmitter & { rawHeaders: string[]; statusCode: number };
      response.rawHeaders = ["Content-Type", "application/json", "Set-Cookie", "B1SESSION=test-only"];
      response.statusCode = 200;
      setImmediate(() => {
        req.emit("response", response);
        response.emit("data", Buffer.from('{"ok":true}'));
        response.emit("end");
      });
    });
    let observedOptions: { agent?: unknown } | undefined;
    const request = vi.fn((_url: URL, options: { agent?: unknown }) => { observedOptions = options; return req; });
    const transport = createLocalTestHttpsTransport("https://sap-test.invalid", request as never);
    const result = await transport("https://sap-test.invalid/b1s/v2/Login", {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: "{}"
    });
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie()).toEqual(["B1SESSION=test-only"]);
    expect(JSON.parse(await result.text())).toEqual({ ok: true });
    expect((observedOptions?.agent as { options?: { rejectUnauthorized?: boolean } })?.options?.rejectUnauthorized).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe("0");
  });

  it("rejects HTTP, redirects, and requests outside the explicit origin", async () => {
    const request = vi.fn();
    const transport = createLocalTestHttpsTransport("https://sap-test.invalid", request as never);
    await expect(transport("http://sap-test.invalid/b1s/v2/Login", { redirect: "error" })).rejects.toThrow("off-origin");
    await expect(transport("https://other.invalid/b1s/v2/Login", { redirect: "error" })).rejects.toThrow("off-origin");
    await expect(transport("https://sap-test.invalid/b1s/v2/Login", { redirect: "follow" })).rejects.toThrow("off-origin");
    expect(request).not.toHaveBeenCalled();
    expect(() => createLocalTestHttpsTransport("http://sap-test.invalid")).toThrow("Invalid local HTTPS test origin");
  });
});
