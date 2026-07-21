import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const ORIGIN = "https://life-atlas.test";
const PASSWORD = ["test", "password", "fixture"].join("-");

function requestHeaders(country = "JP", address = "203.0.113.10"): HeadersInit {
  return {
    "x-life-atlas-test-country": country,
    "cf-connecting-ip": address,
  };
}

beforeEach(async () => {
  const gate = env.LOGIN_GATE.getByName("life-atlas-global-password-gate-v1");
  await runInDurableObject(gate, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM login_gate");
  });
});

async function submitPassword(
  password: string,
  address = "203.0.113.10",
  origin = ORIGIN,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...requestHeaders("JP", address),
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ password }).toString(),
  });
}

describe("Life Atlas Hono Worker", () => {
  it("blocks every route outside Japan before serving content", async () => {
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: requestHeaders("US"),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("日本国内");
  });

  it("serves the login shell but withholds location data before authentication", async () => {
    const login = await SELF.fetch(`${ORIGIN}/`, {
      headers: { ...requestHeaders(), accept: "text/html" },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toContain("no-transform");
    expect(await login.text()).toContain("Life Atlas");

    const data = await SELF.fetch(`${ORIGIN}/data/location-data.json`, {
      headers: requestHeaders(),
    });
    expect(data.status).toBe(401);
    expect(await data.text()).toBe("Unauthorized");
  });

  it("rejects cross-origin and oversized login submissions before password verification", async () => {
    const crossOrigin = await submitPassword(PASSWORD, "203.0.113.11", "https://attacker.example");
    expect(crossOrigin.status).toBe(403);

    const body = `password=${"x".repeat(600)}`;
    const oversized = await SELF.fetch(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...requestHeaders("JP", "203.0.113.11"),
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(oversized.status).toBe(413);

    const valid = await submitPassword(PASSWORD, "203.0.113.11");
    expect(valid.status).toBe(303);
  });

  it("turns malformed UTF-8 into 400 without consuming the global gate", async () => {
    const malformed = await SELF.fetch(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...requestHeaders("JP", "203.0.113.23"),
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new Uint8Array([0xff]),
    });
    expect(malformed.status).toBe(400);

    const valid = await submitPassword(PASSWORD, "203.0.113.24");
    expect(valid.status).toBe(303);
  });

  it("enforces one password verification globally per rolling minute across different IPs", async () => {
    const first = await submitPassword("wrong-password", "203.0.113.20");
    expect(first.status).toBe(401);

    const second = await submitPassword(PASSWORD, "203.0.113.21");
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(second.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  it("issues a hardened host-only session and serves authenticated assets", async () => {
    const login = await submitPassword(PASSWORD, "203.0.113.30");
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");

    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("__Host-life_atlas_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const index = await SELF.fetch(`${ORIGIN}/`, {
      headers: { ...requestHeaders("JP", "203.0.113.30"), cookie: cookie! },
    });
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toContain("no-store");
    expect(index.headers.get("cache-control")).toContain("no-transform");
    expect(await index.text()).toContain('id="real-map"');

    const data = await SELF.fetch(`${ORIGIN}/data/location-data.json`, {
      headers: { ...requestHeaders("JP", "203.0.113.30"), cookie: cookie! },
    });
    expect(data.status).toBe(200);
    expect(data.headers.get("cache-control")).toContain("no-store");
    const payload = (await data.json()) as { summary?: { records?: number } };
    expect(payload.summary?.records).toBeGreaterThan(0);
  });

  it("rejects a tampered session token", async () => {
    const login = await submitPassword(PASSWORD, "203.0.113.40");
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const separator = cookie!.indexOf("=");
    const cookieName = cookie!.slice(0, separator);
    const tokenParts = cookie!.slice(separator + 1).split(".");
    const signature = tokenParts[3]!;
    tokenParts[3] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${cookieName}=${tokenParts.join(".")}`;

    const response = await SELF.fetch(`${ORIGIN}/data/location-data.json`, {
      headers: { ...requestHeaders("JP", "203.0.113.40"), cookie: tampered },
    });
    expect(response.status).toBe(401);
  });

  it("returns strict browser security headers", async () => {
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: requestHeaders(),
    });
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("https://*.basemaps.cartocdn.com");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("persists the exact rolling window in the singleton Durable Object", async () => {
    const gate = env.LOGIN_GATE.getByName("controlled-time-window-test");
    const first = await gate.attempt(PASSWORD, 1_000_000);
    const withinWindow = await gate.attempt(PASSWORD, 1_059_999);
    const nextWindow = await gate.attempt(PASSWORD, 1_060_000);

    expect(first).toEqual({ accepted: true, authenticated: true, retryAfterSeconds: 0 });
    expect(withinWindow.accepted).toBe(false);
    expect(withinWindow.retryAfterSeconds).toBe(1);
    expect(nextWindow).toEqual({ accepted: true, authenticated: true, retryAfterSeconds: 0 });
  });
});
