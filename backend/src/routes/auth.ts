import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  probeLibreOffice,
  LIBREOFFICE_DOWNLOAD_URL,
} from "../lib/libreofficeStatus";

export const authRouter = Router();

// GET /auth/me — returns the JWT-bound user identity.
// Useful for the frontend to confirm the backend accepts its token.
authRouter.get("/me", requireAuth, (_req, res) => {
  res.json({
    id: res.locals.userId as string,
    email: res.locals.userEmail as string,
  });
});

// GET /auth/health — public probe used by Electron main to detect backend ready.
authRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// GET /auth/capabilities — what local tooling is available.
// Used by the frontend to decide whether to show the "Install LibreOffice"
// banner before a DOC/DOCX upload.
authRouter.get("/capabilities", requireAuth, async (_req, res) => {
  const lo = await probeLibreOffice();
  res.json({
    libreoffice: {
      available: lo.available,
      version: lo.version,
      install_url: lo.available ? null : LIBREOFFICE_DOWNLOAD_URL,
    },
  });
});
