const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the configured limit");
    this.name = "BodyTooLargeError";
  }
}

export class InvalidBodyEncodingError extends Error {
  constructor() {
    super("request body is not valid UTF-8");
    this.name = "InvalidBodyEncodingError";
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (base64UrlEncode(bytes) !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function securePasswordMatch(candidate: string, expected: string): Promise<boolean> {
  if (!candidate || !expected) return false;
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= candidateBytes[index]! ^ expectedBytes[index]!;
  }
  return difference === 0;
}

export async function createSessionToken(
  secret: string,
  ttlSeconds: number,
  nowMilliseconds = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(nowMilliseconds / 1_000) + ttlSeconds;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const payload = `${expiresAt}.${base64UrlEncode(nonceBytes)}`;
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `v1.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowMilliseconds = Date.now(),
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [version, expiresRaw, nonce, signatureRaw] = parts;
  if (version !== "v1" || !expiresRaw || !nonce || !signatureRaw) return false;

  const expiresAt = Number(expiresRaw);
  const signature = base64UrlDecode(signatureRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || nonce.length < 16 || !signature) return false;

  const payload = `${expiresRaw}.${nonce}`;
  try {
    const key = await importHmacKey(secret, ["verify"]);
    const validSignature = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
    if (!validSignature) return false;
  } catch {
    return false;
  }

  return expiresAt > Math.floor(nowMilliseconds / 1_000);
}

export async function readBodyLimited(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new BodyTooLargeError();
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(body);
  } catch {
    throw new InvalidBodyEncodingError();
  }
}

export function requestOriginIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
