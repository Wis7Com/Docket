import * as crypto from "crypto";

// Mirror of backend/src/auth/local.ts so the Electron main can mint tokens
// the backend will verify with the same secret.

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function signLocalJwt(
  secretHex: string,
  sub: string,
  email: string,
  ttlSeconds: number,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub, email, iat: now, exp: now + ttlSeconds }),
  );
  const signing = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(signing)
    .digest();
  return `${signing}.${b64url(sig)}`;
}
