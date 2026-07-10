/**
 * Single source of truth for the backend's actual listening port.
 *
 * Backend is spawned with PORT=0 (OS-assigned port — see C3 in the security
 * plan). The actual port is only known after `app.listen()` callback fires.
 * Modules that need to construct self-referential URLs (notably
 * `getSignedUrl` in storage.ts) read it from here instead of reaching for
 * `process.env.PORT`, which would yield "0".
 */

let actualPort: number | null = null;

export function setServerPort(port: number): void {
  actualPort = port;
}

export function getServerPort(): number {
  if (actualPort !== null) return actualPort;
  // Fallback for `npm --prefix backend run dev` where PORT is set explicitly.
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return 3001;
}
