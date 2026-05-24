import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../logger";

// Read lazily so dotenv.config() in index.ts populates process.env before first use.
function getPrivyAppId() { return process.env.PRIVY_APP_ID ?? ""; }

// Lazy-initialise JWKS per app ID; reset if app ID changes (shouldn't happen in prod).
let cachedAppId = "";
let PRIVY_JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getOrInitJWKS() {
  const appId = getPrivyAppId();
  if (!appId) {
    logger.warn("PRIVY_APP_ID is not set — Privy auth will reject all requests");
    PRIVY_JWKS = null;
    return null;
  }
  if (!PRIVY_JWKS || cachedAppId !== appId) {
    cachedAppId = appId;
    PRIVY_JWKS = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)
    );
  }
  return PRIVY_JWKS;
}

export interface PrivyClaims {
  sub:   string;   // Privy DID: "did:privy:xxxx"
  iss:   string;   // "privy.io"
  aud:   string;   // your app ID
  iat:   number;
  exp:   number;
}

declare global {
  namespace Express {
    interface Request {
      privyUser?: PrivyClaims;
    }
  }
}

export async function requirePrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const jwks = getOrInitJWKS();
  if (!jwks) {
    res.status(401).json({ error: "Auth not configured" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer:   "privy.io",
      audience: getPrivyAppId(),
    });
    req.privyUser = payload as unknown as PrivyClaims;
    next();
  } catch (err) {
    logger.debug({ err }, "Privy token verification failed");
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function optionalPrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const jwks = getOrInitJWKS();
  if (!jwks) return next();
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer:   "privy.io",
      audience: getPrivyAppId(),
    });
    req.privyUser = payload as unknown as PrivyClaims;
  } catch {}
  next();
}
