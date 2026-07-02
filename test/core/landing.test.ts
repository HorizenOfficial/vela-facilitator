import { describe, it, expect, beforeAll, inject } from "vitest";

type TestFixtures = import("../setup.js").TestFixtures;

let fixtures: TestFixtures;

beforeAll(() => {
  fixtures = inject("testFixtures") as TestFixtures;
});

describe("GET /", () => {
  it("returns HTML by default with the service info", async () => {
    const res = await fetch(fixtures.serverUrl + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);

    const body = await res.text();
    expect(body).toContain("vela-facilitator");
    expect(body).toContain("private-vela-fixed");
    expect(body).toContain(fixtures.contracts.processorEndpoint.address);
    expect(body).toContain(fixtures.facilitatorAccount.address);
    // Endpoint table mentions every mounted route.
    for (const path of ["/supported", "/verify", "/settle", "/submit", "/claim"]) {
      expect(body).toContain(path);
    }
  });

  it("returns JSON when Accept: application/json is sent", async () => {
    const res = await fetch(fixtures.serverUrl + "/", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await res.json()) as Record<string, any>;
    expect(body.service).toBe("vela-facilitator");
    expect(body.scheme?.name).toBe("private-vela-fixed");
    expect(body.facilitator?.address?.toLowerCase()).toBe(
      fixtures.facilitatorAccount.address.toLowerCase(),
    );
    expect(body.vela?.processorEndpoint?.toLowerCase()).toBe(
      fixtures.contracts.processorEndpoint.address.toLowerCase(),
    );
    expect(body.vela?.chainId).toBe(fixtures.chainId);
    expect(body.vela?.network).toBe(`eip155:${fixtures.chainId}`);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.length).toBeGreaterThanOrEqual(5);
  });
});
