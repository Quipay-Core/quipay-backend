import { Router } from "express";
import { requirePrivyAuth } from "../middleware/privyAuth";
import { getWorkerStreamsBase, getStreamBase } from "../services/baseChain";
import { getWorkerStreamsStellar } from "../services/stellarChain";
import { query } from "../db/pool";
import { logger } from "../logger";

export const workersRouter = Router();
workersRouter.use(requirePrivyAuth);

/**
 * GET /workers/me/streams
 * All active streams across Stellar + Base for the logged-in worker.
 * Stellar streams are read directly from the Soroban contract (not the DB sync table).
 */
workersRouter.get("/me/streams", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;

    const workerResult = await query(
      `SELECT wallet_stellar, wallet_base FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId]
    );

    if (!workerResult.rows.length) {
      res.json({ streams: [], totalAvailableUSDC: 0 });
      return;
    }

    const { wallet_stellar, wallet_base } = workerResult.rows[0];
    const now = Math.floor(Date.now() / 1000);

    // ── Stellar streams (live from Soroban contract) ──────────────────────
    let stellarStreams: any[] = [];
    if (wallet_stellar) {
      try {
        const { streams } = await getWorkerStreamsStellar(wallet_stellar);
        stellarStreams = streams.map(s => {
          const effectiveCliff = s.cliffTs > 0 ? s.cliffTs : s.startTs;
          const elapsed  = Math.max(0, now - s.startTs);
          const vested   = Math.min(elapsed * s.ratePerSecond, s.totalAmount);
          const available = now >= effectiveCliff
            ? Math.max(0, vested - s.withdrawnAmount)
            : 0;
          return {
            streamId:      s.streamId,
            chain:         "stellar",
            employer:      s.employer,
            ratePerSecond: parseFloat(s.ratePerSecond.toFixed(8)),
            startTs:       s.startTs,
            endTs:         s.endTs,
            cliffTs:       s.cliffTs,
            available:     parseFloat(available.toFixed(6)),
            withdrawn:     parseFloat(s.withdrawnAmount.toFixed(6)),
            token:         "USDC",
            status:        s.status === 0 ? "active" : s.status === 1 ? "cancelled" : "completed",
          };
        });
      } catch (err) {
        logger.warn({ err }, "Stellar chain read failed");
      }
    }

    // ── Base streams (live from chain via viem) ───────────────────────────
    let baseStreams: any[] = [];
    if (wallet_base) {
      try {
        const ids     = await getWorkerStreamsBase(wallet_base as `0x${string}`);
        const details = await Promise.all(ids.map(id => getStreamBase(id)));
        baseStreams   = details
          .filter(Boolean)
          .filter((s: any) => !s.cancelled)
          .map((s: any) => ({
            streamId:      s.streamId,
            chain:         "base",
            employer:      s.employer,
            ratePerSecond: s.ratePerSecond,
            startTs:       s.startTs,
            endTs:         s.endTs,
            cliffTs:       0,
            available:     s.available,
            withdrawn:     s.withdrawn,
            token:         "USDC",
            status:        "active",
          }));
      } catch (err) {
        logger.warn({ err }, "Base chain read failed — returning Stellar only");
      }
    }

    const all        = [...stellarStreams, ...baseStreams];
    const totalAvail = all.reduce((sum, s) => sum + (s.available ?? 0), 0);

    res.json({
      streams:            all,
      totalAvailableUSDC: parseFloat(totalAvail.toFixed(6)),
      chains:             { stellar: stellarStreams.length, base: baseStreams.length },
    });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/streams failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /workers/me/balance
 * Lightweight real-time balance — mobile polls this on mount and every 30s.
 * Reads directly from the Soroban contract so it always reflects on-chain state.
 */
workersRouter.get("/me/balance", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;

    const workerResult = await query(
      `SELECT wallet_stellar FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId]
    );

    if (!workerResult.rows.length || !workerResult.rows[0].wallet_stellar) {
      const now = Math.floor(Date.now() / 1000);
      res.json({ available: "0.000000", streamingPerSec: "0.00000000", withdrawn: "0.000000", currency: "USDC", timestamp: now });
      return;
    }

    const { wallet_stellar } = workerResult.rows[0];
    const now = Math.floor(Date.now() / 1000);

    const { totalAvailable, streamingPerSec, withdrawn } =
      await getWorkerStreamsStellar(wallet_stellar);

    res.json({
      available:       totalAvailable.toFixed(6),
      streamingPerSec: streamingPerSec.toFixed(8),
      withdrawn:       withdrawn.toFixed(6),
      currency:        "USDC",
      timestamp:       now,
    });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/balance failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /workers/me/register
 * Called by mobile app after Privy login to link wallet addresses.
 */
workersRouter.post("/me/register", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const { walletStellar, walletBase, email } = req.body as {
      walletStellar?: string;
      walletBase?:    string;
      email?:         string;
    };

    await query(
      `INSERT INTO workers (privy_id, email, wallet_stellar, wallet_base, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (privy_id) DO UPDATE
         SET wallet_stellar = COALESCE(EXCLUDED.wallet_stellar, workers.wallet_stellar),
             wallet_base    = COALESCE(EXCLUDED.wallet_base,    workers.wallet_base),
             email          = COALESCE(EXCLUDED.email,          workers.email)`,
      [privyId, email ?? null, walletStellar ?? null, walletBase ?? null]
    );

    res.json({ success: true, privyId });
  } catch (err) {
    logger.error({ err }, "POST /workers/me/register failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /workers/me/profile
 * Returns the worker's registered wallet addresses and Privy DID.
 */
workersRouter.get("/me/profile", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const result  = await query(
      `SELECT privy_id, email, wallet_stellar, wallet_base, created_at
       FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId]
    );

    if (!result.rows.length) {
      res.json({ registered: false });
      return;
    }

    res.json({ registered: true, ...result.rows[0] });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/profile failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
