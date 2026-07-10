import * as crypto from "crypto";

/**
 * Minimal HS256 JWT helpers backed by Node `crypto`. Avoids the `jsonwebtoken`
 * dependency for a self-contained desktop build.
 *
 * The signing secret is supplied via the JWT_SECRET env var. Electron creates
 * a fresh random secret for each local desktop session and passes it at spawn
 * time.
 */

interface Payload {
  sub: string;
  email?: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function getSecret(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  // Buffer.from(..., "hex") silently stops at the first non-hex character,
  // so validate the encoding explicitly before checking key strength.
  if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) {
    throw new Error("JWT_SECRET must be a hex string");
  }
  const key = Buffer.from(secret, "hex");
  if (key.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 bytes of hex");
  }
  return key;
}

export function signLocalJwt(
  sub: string,
  email: string,
  ttlSeconds = 60 * 60 * 24,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub,
      email,
      iat: now,
      exp: now + ttlSeconds,
    } satisfies Payload),
  );
  const signing = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(signing)
    .digest();
  return `${signing}.${b64url(sig)}`;
}

export interface VerifiedJwt {
  sub: string;
  email: string;
}

export function verifyLocalJwt(token: string): VerifiedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString()) as {
      alg?: unknown;
      typ?: unknown;
    };
  } catch {
    throw new Error("Malformed token header");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("Unsupported token alg/typ");
  }

  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = b64urlDecode(sigB64);
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(b64urlDecode(payloadB64).toString()) as Payload;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Invalid token exp");
  }
  if (payload.exp * 1000 < Date.now()) {
    throw new Error("Token expired");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Invalid token sub");
  }
  return { sub: payload.sub, email: payload.email ?? "" };
}
