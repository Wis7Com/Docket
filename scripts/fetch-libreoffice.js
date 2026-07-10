/**
 * Fetch and extract LibreOffice into ./vendor/libreoffice/.
 *
 * Idempotent: skips if soffice.exe is already present. Run once per
 * developer machine before `npm run dist`. The build chains this in
 * automatically, but it's safe to invoke directly.
 *
 * Strategy: download the official MSI from The Document Foundation,
 * verify its SHA-256 against the .sha256 sidecar published next to it,
 * then run `msiexec /a` (admin install) to extract a redistributable
 * program tree. We never run the user-facing installer.
 *
 * Windows-only. The bundled binary is shipped only in the Windows NSIS
 * artifact; non-Windows builds skip this step gracefully.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { spawnSync } = require("child_process");
const os = require("os");

// Pinned LibreOffice "Still" channel — the conservative track. Bump
// periodically (track https://www.libreoffice.org/download/release-notes/).
const LO_VERSION = "25.8.6";
const MSI_NAME = `LibreOffice_${LO_VERSION}_Win_x86-64.msi`;
const BASE_URL = `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64`;
const MSI_URL = `${BASE_URL}/${MSI_NAME}`;
const SHA_URL = `${MSI_URL}.sha256`;

const repoRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(repoRoot, "vendor", "libreoffice");
const sentinel = path.join(vendorDir, "program", "soffice.exe");

function log(msg) {
    process.stdout.write(`[fetch-libreoffice] ${msg}\n`);
}

if (process.platform !== "win32") {
    log(`Skipping — host platform is ${process.platform}, bundling is Windows-only.`);
    process.exit(0);
}

if (fs.existsSync(sentinel)) {
    log(`Already present at ${sentinel} — nothing to do.`);
    process.exit(0);
}

function download(url, destPath) {
    return new Promise((resolve, reject) => {
        const fetchWithRedirects = (u, hops) => {
            if (hops > 5) {
                reject(new Error(`Too many redirects fetching ${url}`));
                return;
            }
            https
                .get(u, (res) => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        res.headers.location
                    ) {
                        res.resume();
                        const next = new URL(res.headers.location, u).toString();
                        fetchWithRedirects(next, hops + 1);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(
                            new Error(
                                `HTTP ${res.statusCode} fetching ${u}: ${res.statusMessage}`,
                            ),
                        );
                        res.resume();
                        return;
                    }
                    const out = fs.createWriteStream(destPath);
                    const total = Number(res.headers["content-length"] || 0);
                    let received = 0;
                    let lastPct = -1;
                    res.on("data", (chunk) => {
                        received += chunk.length;
                        if (total) {
                            const pct = Math.floor((received / total) * 100);
                            if (pct !== lastPct && pct % 5 === 0) {
                                log(`  …${pct}% (${(received / 1e6).toFixed(1)} MB)`);
                                lastPct = pct;
                            }
                        }
                    });
                    res.pipe(out);
                    out.on("finish", () => out.close(() => resolve()));
                    out.on("error", reject);
                })
                .on("error", reject);
        };
        fetchWithRedirects(url, 0);
    });
}

function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (d) => hash.update(d));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

async function readExpectedHash(shaFile) {
    const raw = await fs.promises.readFile(shaFile, "utf8");
    // Format: "<hex>  <filename>" — first whitespace-separated token.
    const token = raw.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(token)) {
        throw new Error(`Unexpected sha256 sidecar format: ${raw.slice(0, 80)}`);
    }
    return token.toLowerCase();
}

async function main() {
    fs.mkdirSync(vendorDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-lo-"));
    const msiPath = path.join(tmpDir, MSI_NAME);
    const shaPath = `${msiPath}.sha256`;

    try {
        log(`Downloading ${MSI_URL}`);
        await download(MSI_URL, msiPath);
        log(`Downloading ${SHA_URL}`);
        await download(SHA_URL, shaPath);

        const expected = await readExpectedHash(shaPath);
        log(`Verifying SHA-256 (expected ${expected})…`);
        const actual = await sha256OfFile(msiPath);
        if (actual !== expected) {
            throw new Error(
                `SHA-256 mismatch — expected ${expected}, got ${actual}. Refusing to extract.`,
            );
        }
        log(`OK.`);

        log(`Extracting via msiexec /a → ${vendorDir}`);
        // /a = administrative install (extract files, do not register).
        // /qn = no UI. TARGETDIR must be absolute.
        const result = spawnSync(
            "msiexec.exe",
            ["/a", msiPath, "/qn", `TARGETDIR=${vendorDir}`],
            { stdio: "inherit" },
        );
        if (result.status !== 0) {
            throw new Error(
                `msiexec exited with code ${result.status}. ` +
                    `If you ran this from a non-elevated shell, try again with admin rights.`,
            );
        }

        // The admin install lays the program tree under
        // `LibreOffice/` inside TARGETDIR on some MSI builds. Hoist
        // its contents up if so, so soffice.exe lands at
        // vendor/libreoffice/program/soffice.exe.
        const inner = path.join(vendorDir, "LibreOffice");
        if (fs.existsSync(inner) && !fs.existsSync(sentinel)) {
            log(`Hoisting nested LibreOffice/ contents up one level…`);
            for (const entry of fs.readdirSync(inner)) {
                fs.renameSync(path.join(inner, entry), path.join(vendorDir, entry));
            }
            fs.rmdirSync(inner);
        }

        if (!fs.existsSync(sentinel)) {
            throw new Error(
                `Extraction finished but ${sentinel} is missing. ` +
                    `Inspect ${vendorDir} manually.`,
            );
        }

        // Drop the MSI copy that msiexec /a leaves behind in TARGETDIR
        // (we don't ship it — only the extracted tree is needed).
        const stragglerMsi = path.join(vendorDir, MSI_NAME);
        if (fs.existsSync(stragglerMsi)) fs.unlinkSync(stragglerMsi);

        log(`Done. soffice.exe is at ${sentinel}.`);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
}

main().catch((err) => {
    process.stderr.write(`[fetch-libreoffice] FAILED: ${err.message}\n`);
    process.exit(1);
});
