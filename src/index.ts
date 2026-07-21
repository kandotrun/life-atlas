import { DurableObject } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  BodyTooLargeError,
  createSessionToken,
  InvalidBodyEncodingError,
  readBodyLimited,
  requestOriginIsSameOrigin,
  securePasswordMatch,
  verifySessionToken,
} from "./security";
import { faviconSvg, geoBlockedHtml, loginCss, loginHtml } from "./templates";

const COOKIE_NAME = "__Host-life_atlas_session";
const GLOBAL_GATE_NAME = "life-atlas-global-password-gate-v1";
const LOGIN_WINDOW_MILLISECONDS = 60_000;
const MAXIMUM_LOGIN_BODY_BYTES = 512;
const MAXIMUM_PASSWORD_CHARACTERS = 128;

interface LoginAttemptResult {
  accepted: boolean;
  authenticated: boolean;
  retryAfterSeconds: number;
}

export class GlobalLoginGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS login_gate (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_attempt_ms INTEGER NOT NULL
        )
      `);
    });
  }

  async attempt(password: string, requestedNowMilliseconds = Date.now()): Promise<LoginAttemptResult> {
    const nowMilliseconds = Number.isFinite(requestedNowMilliseconds)
      ? Math.floor(requestedNowMilliseconds)
      : Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ last_attempt_ms: number }>("SELECT last_attempt_ms FROM login_gate WHERE id = 1")
      .toArray();

    const existingGate = existing[0];
    if (existingGate) {
      const elapsedMilliseconds = nowMilliseconds - Number(existingGate.last_attempt_ms);
      if (elapsedMilliseconds < LOGIN_WINDOW_MILLISECONDS) {
        const remainingMilliseconds = Math.max(1, LOGIN_WINDOW_MILLISECONDS - Math.max(0, elapsedMilliseconds));
        return {
          accepted: false,
          authenticated: false,
          retryAfterSeconds: Math.ceil(remainingMilliseconds / 1_000),
        };
      }
    }

    // No await occurs between the read and this write. A single Durable Object
    // serializes this global gate, so only one verification can reserve a window.
    this.ctx.storage.sql.exec(
      `INSERT INTO login_gate (id, last_attempt_ms) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_attempt_ms = excluded.last_attempt_ms`,
      nowMilliseconds,
    );

    const authenticated = await securePasswordMatch(password, this.env.AUTH_PASSWORD);
    return { accepted: true, authenticated, retryAfterSeconds: 0 };
  }
}

type AppContext = { Bindings: Env };
const app = new Hono<AppContext>();

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.basemaps.cartocdn.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "worker-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

app.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", contentSecurityPolicy);
  context.header("Cross-Origin-Opener-Policy", "same-origin");
  context.header("Cross-Origin-Resource-Policy", "same-origin");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  context.header("Referrer-Policy", "no-referrer");
  context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("X-Robots-Tag", "noindex, nofollow, noarchive");
});

function countryForRequest(request: Request, env: Env): string {
  const platformCountry = typeof request.cf?.country === "string" ? request.cf.country : "";
  if (env.ENVIRONMENT !== "production") {
    return (request.headers.get("x-life-atlas-test-country") ?? platformCountry) || "JP";
  }
  return platformCountry;
}

app.use("*", async (context, next) => {
  if (countryForRequest(context.req.raw, context.env) !== context.env.ALLOWED_COUNTRY) {
    context.header("Cache-Control", "private, no-store, no-transform");
    return context.html(geoBlockedHtml(), 403);
  }
  await next();
});

function sessionTtlSeconds(env: Env): number {
  const parsed = Number(env.SESSION_TTL_SECONDS);
  return Number.isSafeInteger(parsed) && parsed >= 300 && parsed <= 604_800 ? parsed : 86_400;
}

function secretsAreConfigured(env: Env): boolean {
  return Boolean(env.AUTH_PASSWORD && env.SESSION_SECRET && env.AUTH_PASSWORD.length >= 8 && env.SESSION_SECRET.length >= 32);
}

async function hasValidSession(context: Context<AppContext>): Promise<boolean> {
  const token = getCookie(context, COOKIE_NAME);
  return verifySessionToken(token, context.env.SESSION_SECRET);
}

async function rateLimitIdentifier(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "missing-address";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`life-atlas-login:${address}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function noStore(context: { header: (name: string, value: string) => void }): void {
  context.header("Cache-Control", "private, no-store, max-age=0, no-transform");
  context.header("Pragma", "no-cache");
  context.header("Vary", "Cookie");
}

app.get("/login.css", (context) => {
  context.header("Content-Type", "text/css; charset=utf-8");
  context.header("Cache-Control", "private, max-age=3600");
  return context.body(loginCss);
});

app.get("/favicon.svg", (context) => {
  context.header("Content-Type", "image/svg+xml; charset=utf-8");
  context.header("Cache-Control", "private, max-age=86400");
  return context.body(faviconSvg);
});

app.get("/robots.txt", (context) => {
  context.header("Content-Type", "text/plain; charset=utf-8");
  context.header("Cache-Control", "private, max-age=86400");
  return context.text("User-agent: *\nDisallow: /\n");
});

app.get("/healthz", (context) => {
  context.header("Cache-Control", "private, no-store");
  return context.json({ ok: true, service: "life-atlas", framework: "hono" });
});

app.get("/", async (context, next) => {
  if (secretsAreConfigured(context.env) && (await hasValidSession(context))) {
    return next();
  }
  noStore(context);
  return context.html(loginHtml());
});

app.get("/login", async (context) => {
  if (secretsAreConfigured(context.env) && (await hasValidSession(context))) {
    return context.redirect("/", 303);
  }
  noStore(context);
  return context.html(loginHtml());
});

app.post("/login", async (context) => {
  noStore(context);
  if (!secretsAreConfigured(context.env)) {
    console.error(JSON.stringify({ event: "auth_configuration_missing", path: "/login" }));
    return context.html(loginHtml("認証設定を確認できません。"), 503);
  }
  if (!requestOriginIsSameOrigin(context.req.raw)) {
    return context.html(loginHtml("認証リクエストを確認できません。"), 403);
  }

  const contentType = context.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return context.html(loginHtml("認証リクエストの形式が正しくありません。"), 415);
  }

  let encodedBody: string;
  try {
    encodedBody = await readBodyLimited(context.req.raw, MAXIMUM_LOGIN_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return context.html(loginHtml("認証リクエストが大きすぎます。"), 413);
    }
    if (error instanceof InvalidBodyEncodingError) {
      return context.html(loginHtml("送信形式が正しくありません。"), 400);
    }
    throw error;
  }

  const params = new URLSearchParams(encodedBody);
  const password = params.get("password") ?? "";
  if (!password || password.length > MAXIMUM_PASSWORD_CHARACTERS) {
    return context.html(loginHtml("パスワードを確認してください。"), 400);
  }

  const localLimit = await context.env.LOGIN_IP_LIMITER.limit({
    key: await rateLimitIdentifier(context.req.raw),
  });
  if (!localLimit.success) {
    context.header("Retry-After", "60");
    return context.html(loginHtml("しばらく待ってから再試行してください。", 60), 429);
  }

  const gate = context.env.LOGIN_GATE.getByName(GLOBAL_GATE_NAME);
  const result = await gate.attempt(password);
  if (!result.accepted) {
    context.header("Retry-After", String(result.retryAfterSeconds));
    return context.html(
      loginHtml("パスワード照合は全体で1分に1回までです。", result.retryAfterSeconds),
      429,
    );
  }
  if (!result.authenticated) {
    return context.html(loginHtml("認証できませんでした。"), 401);
  }

  const ttlSeconds = sessionTtlSeconds(context.env);
  const token = await createSessionToken(context.env.SESSION_SECRET, ttlSeconds);
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: ttlSeconds,
  });
  return context.redirect("/", 303);
});

app.post("/logout", async (context) => {
  noStore(context);
  if (!requestOriginIsSameOrigin(context.req.raw)) return context.text("Forbidden", 403);
  deleteCookie(context, COOKIE_NAME, { path: "/", secure: true });
  return context.redirect("/", 303);
});

app.all("*", async (context) => {
  if (!secretsAreConfigured(context.env)) {
    console.error(JSON.stringify({ event: "auth_configuration_missing", path: context.req.path }));
    return context.text("Service unavailable", 503);
  }
  if (!(await hasValidSession(context))) {
    noStore(context);
    const accept = context.req.header("accept") ?? "";
    if (accept.includes("text/html") && (context.req.method === "GET" || context.req.method === "HEAD")) {
      return context.html(loginHtml(), 401);
    }
    return context.text("Unauthorized", 401);
  }
  if (context.req.method !== "GET" && context.req.method !== "HEAD") {
    return context.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  }

  const assetUrl = new URL(context.req.url);
  if (assetUrl.pathname === "/") assetUrl.pathname = "/index.html";
  const assetRequest = new Request(assetUrl, context.req.raw);
  const assetResponse = await context.env.ASSETS.fetch(assetRequest);
  const response = new Response(assetResponse.body, assetResponse);
  response.headers.set("Vary", "Cookie");

  if (assetUrl.pathname === "/index.html" || assetUrl.pathname.startsWith("/data/")) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0, no-transform");
  } else {
    response.headers.set("Cache-Control", "private, max-age=3600");
  }
  return response;
});

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      event: "unhandled_request_error",
      method: context.req.method,
      path: context.req.path,
      error: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  noStore(context);
  return context.text("Internal Server Error", 500);
});

export default app;
