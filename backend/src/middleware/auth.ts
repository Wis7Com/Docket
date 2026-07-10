import { Request, Response, NextFunction } from "express";
import { verifyLocalJwt } from "../auth/local";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  try {
    const claims = verifyLocalJwt(token);
    res.locals.userId = claims.sub;
    res.locals.userEmail = claims.email.toLowerCase();
    res.locals.token = token;
    next();
  } catch (err) {
    res
      .status(401)
      .json({ detail: (err as Error).message || "Invalid or expired token" });
  }
}
