"use client";

import { useEffect } from "react";
import { Inter, EB_Garamond } from "next/font/google";

// global-error replaces the root layout, so the fonts it sets up — and the
// CSS variables they define — are not available here. Load our own instances:
// next/font downloads them at build time and serves them from our own origin,
// which keeps this page working offline like the rest of the app.
const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500"],
});

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        console.error("Global error:", error);
    }, [error]);

    return (
        <html lang="en" className={`${inter.variable} ${ebGaramond.variable}`}>
            <head>
                <title>Something went wrong – Docket</title>
                <style>{`
                    * { margin: 0; padding: 0; box-sizing: border-box; }

                    body {
                        font-family: var(--font-inter, -apple-system), BlinkMacSystemFont, sans-serif;
                        background-color: #ffffff;
                        color: #111;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .error-container {
                        text-align: center;
                        max-width: 480px;
                        padding: 2rem;
                    }

                    .error-title {
                        font-family: var(--font-eb-garamond, Georgia), serif;
                        font-size: 1.75rem;
                        font-weight: 400;
                        color: #111;
                        margin-bottom: 0.75rem;
                    }

                    .error-message {
                        font-size: 0.9375rem;
                        color: #6b7280;
                        line-height: 1.6;
                        margin-bottom: 2rem;
                    }

                    .btn-back {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        padding: 0.625rem 1.25rem;
                        border-radius: 0.5rem;
                        font-size: 0.875rem;
                        font-weight: 500;
                        font-family: var(--font-inter, -apple-system), sans-serif;
                        cursor: pointer;
                        transition: all 0.15s ease;
                        text-decoration: none;
                        border: none;
                        background-color: rgb(0, 136, 255);
                        color: white;
                    }

                    .btn-back:hover {
                        background-color: rgb(0, 120, 230);
                    }

                    .btn-back:active {
                        transform: scale(0.98);
                    }
                `}</style>
            </head>
            <body>
                <div className="error-container">
                    <h1 className="error-title">Something went wrong</h1>
                    <p className="error-message">
                        We encountered an unexpected error. This has been logged
                        and our team will look into it.
                    </p>
                    <button
                        className="btn-back"
                        onClick={() => window.history.back()}
                    >
                        Back
                    </button>
                </div>
            </body>
        </html>
    );
}
