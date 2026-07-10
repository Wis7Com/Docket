import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    // Standalone output bundles a minimal Node server in
    // .next/standalone/server.js. The Electron main process spawns it in prod.
    output: "standalone",
    reactCompiler: true,
    skipTrailingSlashRedirect: true,
    // Keep the Next.js dev-tools badge (issue reporting is useful) but move it
    // away from the bottom-left corner, where it overlapped the sidebar user
    // menu and the PDF viewer page indicator.
    devIndicators: { position: "bottom-right" },
};

export default nextConfig;
