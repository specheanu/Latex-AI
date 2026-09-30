/**
 * Verificarea tokenului de design Canva (ghidul "Verifying JWTs"):
 * pluginul trimite `Authorization: Bearer <token>` obținut cu getDesignToken();
 * backend-ul îl verifică cu cheile publice de la
 * https://api.canva.com/rest/v1/apps/{appId}/jwks, audience = appId, RS256 —
 * exact ca @canva/app-middleware, dar cu toleranță de ceas (clockTolerance),
 * pentru că pachetul oficial nu o expune și un PC cu ceasul în urmă cu câteva
 * secunde primea "jwt not active".
 *
 * Dacă CANVA_APP_ID lipsește din .env, cererile trec neverificate (doar
 * dezvoltare locală) și se avertizează o singură dată.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { JwksClient, SigningKeyNotFoundError } from "jwks-rsa";

export type CanvaDesignContext = { appId: string; designId: string };

/** Secunde de toleranță pentru exp/nbf/iat (ceasuri nesincronizate). */
const CLOCK_TOLERANCE_SECONDS = Number(process.env.CANVA_JWT_CLOCK_TOLERANCE ?? 60);

export function createCanvaJwtMiddleware(appId: string | undefined): RequestHandler {
  if (!appId) {
    let warned = false;
    return (_req, _res, next) => {
      if (!warned) {
        console.warn("AUTH: CANVA_APP_ID lipsește — cererile NU sunt verificate (doar dezvoltare).");
        warned = true;
      }
      return next();
    };
  }

  const jwks = new JwksClient({
    jwksUri: `https://api.canva.com/rest/v1/apps/${appId}/jwks`,
    cache: true,
    cacheMaxAge: 60 * 60 * 1000,
    rateLimit: true,
    timeout: 30_000,
  });

  async function verify(token: string): Promise<CanvaDesignContext> {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === "string" || !decoded.header.kid) {
      throw new jwt.JsonWebTokenError("Token fără antet kid");
    }
    const key = await jwks.getSigningKey(decoded.header.kid);
    const verified = jwt.verify(token, key.getPublicKey(), {
      audience: appId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      complete: true,
    }) as jwt.Jwt & { payload: { aud?: string; designId?: string } };

    const { aud, designId } = verified.payload;
    if (!aud || !designId) {
      throw new jwt.JsonWebTokenError("Token fără designId sau aud");
    }
    return { appId: String(aud), designId };
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      console.warn("AUTH: cerere fără token Canva:", req.method, req.path);
      return res.status(401).json({ error: "Lipsește tokenul Canva.", code: "TOKEN_MISSING" });
    }

    try {
      (req as Request & { canva?: CanvaDesignContext }).canva = await verify(token);
      return next();
    } catch (err: unknown) {
      if (err instanceof SigningKeyNotFoundError) {
        console.warn("AUTH: cheie publică negăsită — CANVA_APP_ID greșit?");
        return res.status(401).json({ error: "Token Canva invalid: cheie publică negăsită (verifică CANVA_APP_ID).", code: "TOKEN_INVALID" });
      }
      if (err instanceof jwt.TokenExpiredError) {
        console.warn("AUTH: token expirat la", err.expiredAt.toISOString());
        return res.status(401).json({ error: "Token Canva expirat.", code: "TOKEN_EXPIRED" });
      }
      if (err instanceof jwt.NotBeforeError) {
        console.warn("AUTH: token încă inactiv (nbf =", err.date.toISOString(), ") — ceasul PC-ului e în urmă mai mult de", CLOCK_TOLERANCE_SECONDS, "s");
        return res.status(401).json({ error: "Token Canva încă inactiv — sincronizează ceasul calculatorului.", code: "TOKEN_INVALID" });
      }
      if (err instanceof jwt.JsonWebTokenError) {
        console.warn("AUTH: token respins:", err.message);
        return res.status(401).json({ error: `Token Canva invalid: ${err.message}`, code: "TOKEN_INVALID" });
      }
      console.error("AUTH: verificarea a eșuat (rețea/JWKS):", err);
      return res.status(503).json({
        error: "Nu am putut verifica tokenul Canva (cheile publice nu au putut fi descărcate).",
        code: "JWKS_UNAVAILABLE",
      });
    }
  };
}