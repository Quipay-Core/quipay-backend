import { Router, Response, Request, NextFunction } from "express";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { requireVerifiedEmployer } from "../middleware/employerVerification";
import { query } from "../db/pool";
import {
  employerOnboardingSchema,
  employerTreasuryDepositSchema,
} from "../schemas/employers.schema";
import {
  getTreasuryBalanceByEmployer,
  getEmployerById,
  recordVaultEvent,
  upsertEmployerVerification,
  updateTreasuryBalance,
} from "../db/queries";
import { verifyBusinessRegistration } from "../services/kybService";
import { getEmployerBalanceBase, getWorkerStreamsBase } from "../services/baseChain";
import type { Address } from "viem";

export const employersRouter = Router();

/**
 * GET /api/employers/by-address?address=G...
 * Public — no auth. Returns an employer by their Stellar address.
 */
employersRouter.get("/by-address", async (req: Request, res: Response) => {
  const address =
    typeof req.query.address === "string" ? req.query.address.trim() : "";
  if (!address) return res.json({ employer: null });

  const result = await query<{
    employer_id: string;
    business_name: string;
    country_code: string;
    stellar_address: string;
  }>(
    `SELECT employer_id, business_name, country_code, stellar_address
     FROM employers
     WHERE stellar_address = $1
     LIMIT 1`,
    [address],
  );

  return res.json({ employer: result.rows[0] ?? null });
});

/**
 * POST /api/employers/worker-registrations
 * Public — no auth. Records an on-chain worker→employer registration and
 * upserts the employee profile (name, role, dept, etc.).
 */
employersRouter.post(
  "/worker-registrations",
  async (req: Request, res: Response) => {
    const {
      workerAddress,
      employerAddress,
      fullName,
      jobTitle,
      department,
      workEmail,
      startDate,
      employeeRef,
    } = req.body as {
      workerAddress?: string;
      employerAddress?: string;
      fullName?: string;
      jobTitle?: string;
      department?: string;
      workEmail?: string;
      startDate?: string;
      employeeRef?: string;
    };

    if (!workerAddress || !employerAddress) {
      return res
        .status(400)
        .json({ error: "workerAddress and employerAddress are required" });
    }
    if (!fullName || !jobTitle) {
      return res.status(400).json({ error: "fullName and jobTitle are required" });
    }

    await query(
      `INSERT INTO worker_registrations (worker_address, employer_address)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workerAddress, employerAddress],
    );

    await query(
      `INSERT INTO employee_profiles
         (worker_address, employer_address, full_name, job_title, department, work_email, start_date, employee_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
       ON CONFLICT (worker_address, employer_address) DO UPDATE SET
         full_name    = EXCLUDED.full_name,
         job_title    = EXCLUDED.job_title,
         department   = EXCLUDED.department,
         work_email   = EXCLUDED.work_email,
         start_date   = EXCLUDED.start_date::date,
         employee_ref = EXCLUDED.employee_ref,
         updated_at   = NOW()`,
      [
        workerAddress,
        employerAddress,
        fullName,
        jobTitle,
        department ?? null,
        workEmail ?? null,
        startDate ?? null,
        employeeRef ?? null,
      ],
    );

    return res.json({ success: true });
  },
);

/**
 * GET /api/employers/worker-registrations/:workerAddress
 * Public — no auth. Returns all employers a worker is registered under.
 */
employersRouter.get(
  "/worker-registrations/:workerAddress",
  async (req: Request, res: Response) => {
    const { workerAddress } = req.params;
    const result = await query<{
      employer_id: string;
      business_name: string;
      country_code: string;
      stellar_address: string;
    }>(
      `SELECT e.employer_id, e.business_name, e.country_code, e.stellar_address
       FROM worker_registrations wr
       JOIN employers e ON e.stellar_address = wr.employer_address
       WHERE wr.worker_address = $1
       ORDER BY wr.registered_at DESC`,
      [workerAddress],
    );
    return res.json({ employers: result.rows });
  },
);

/**
 * GET /api/employers/search?q=acme
 * Public — no auth. Returns verified employers matching the query.
 */
employersRouter.get("/search", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q || q.length < 2) {
    return res.json({ employers: [] });
  }

  const result = await query<{
    employer_id: string;
    business_name: string;
    country_code: string;
    stellar_address: string | null;
  }>(
    `SELECT employer_id, business_name, country_code, stellar_address
     FROM employers
     WHERE verification_status = 'verified'
       AND business_name ILIKE $1
     ORDER BY business_name
     LIMIT 10`,
    [`%${q}%`],
  );

  return res.json({ employers: result.rows });
});

/**
 * POST /api/employers/withdrawal-events
 * Public — records a worker withdrawal after the on-chain TX succeeds.
 */
employersRouter.post(
  "/withdrawal-events",
  async (req: Request, res: Response) => {
    const { workerAddress, employerAddress, streamId, amount, tokenSymbol, txHash } =
      req.body as {
        workerAddress?: string;
        employerAddress?: string;
        streamId?: string;
        amount?: string;
        tokenSymbol?: string;
        txHash?: string;
      };

    if (!workerAddress || !streamId || !amount || !txHash) {
      return res.status(400).json({ error: "workerAddress, streamId, amount and txHash are required" });
    }

    await query(
      `INSERT INTO worker_withdrawal_events
         (worker_address, employer_address, stream_id, amount, token_symbol, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        workerAddress,
        employerAddress ?? null,
        streamId,
        amount,
        tokenSymbol ?? "USDC",
        txHash,
      ],
    );

    return res.json({ success: true });
  },
);

/**
 * GET /api/employers/withdrawal-events?address=G...
 * Public — returns all recorded withdrawal events for a worker address.
 */
employersRouter.get(
  "/withdrawal-events",
  async (req: Request, res: Response) => {
    const address =
      typeof req.query.address === "string" ? req.query.address.trim() : "";
    if (!address) return res.json({ withdrawals: [] });

    const result = await query<{
      id: number;
      worker_address: string;
      employer_address: string | null;
      stream_id: string;
      amount: string;
      token_symbol: string;
      tx_hash: string;
      created_at: string;
    }>(
      `SELECT id, worker_address, employer_address, stream_id, amount, token_symbol, tx_hash, created_at
       FROM worker_withdrawal_events
       WHERE worker_address = $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [address],
    );

    return res.json({ withdrawals: result.rows });
  },
);

employersRouter.use(authenticateRequest, requireUser);

employersRouter.post(
  "/onboard",
  validateRequest({ body: employerOnboardingSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const verification = await verifyBusinessRegistration(req.body);
    const employer = await upsertEmployerVerification({
      employerId: req.user.id,
      businessName: req.body.businessName,
      registrationNumber: req.body.registrationNumber,
      countryCode: req.body.countryCode,
      contactName: req.body.contactName,
      contactEmail: req.body.contactEmail,
      stellarAddress: req.body.stellarAddress,
      verificationStatus: verification.status,
      verificationReason: verification.reason ?? null,
      verificationMetadata: verification.metadata ?? {},
    });

    const stellarAddress = req.body.stellarAddress as Address;
    const [existingStreams, vaultBalance] = await Promise.allSettled([
      getWorkerStreamsBase(stellarAddress),
      getEmployerBalanceBase(stellarAddress),
    ]);

    res.status(verification.status === "verified" ? 200 : 202).json({
      employer,
      status: employer.verification_status,
      chain: {
        stellarAddress,
        existingStreams:
          existingStreams.status === "fulfilled"
            ? existingStreams.value.length
            : 0,
        vaultBalance:
          vaultBalance.status === "fulfilled" ? vaultBalance.value : 0,
      },
    });
  },
);

employersRouter.get(
  "/status",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    if (!employer) {
      return res.json({ status: "not_started" });
    }

    res.json({
      status: employer.verification_status,
      employer,
    });
  },
);

/**
 * GET /api/employers/employees
 * Auth required. Returns all employees registered under the authenticated employer,
 * including their profile details.
 */
employersRouter.get(
  "/employees",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    if (!employer?.stellar_address) {
      return res.json({ employees: [] });
    }

    const result = await query<{
      worker_address: string;
      full_name: string;
      job_title: string;
      department: string | null;
      work_email: string | null;
      start_date: string | null;
      employee_ref: string | null;
      registered_at: string;
    }>(
      `SELECT
         ep.worker_address,
         ep.full_name,
         ep.job_title,
         ep.department,
         ep.work_email,
         ep.start_date,
         ep.employee_ref,
         wr.registered_at
       FROM employee_profiles ep
       JOIN worker_registrations wr
         ON wr.worker_address = ep.worker_address
        AND wr.employer_address = ep.employer_address
       WHERE ep.employer_address = $1
       ORDER BY wr.registered_at DESC`,
      [employer.stellar_address],
    );

    return res.json({ employees: result.rows });
  },
);

employersRouter.post(
  "/treasury/deposit",
  validateRequest({ body: employerTreasuryDepositSchema }),
  requireVerifiedEmployer,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const existingBalance = await getTreasuryBalanceByEmployer(req.user.id);
    const currentBalance = BigInt(existingBalance?.balance ?? "0");
    const amount = req.body.amount as bigint;
    const token = req.body.token as string;

    await updateTreasuryBalance(req.user.id, currentBalance + amount, token);
    await recordVaultEvent({
      eventType: "deposit",
      address: req.user.id,
      token,
      amount,
      ledger: 0,
      ledgerTs: Math.floor(Date.now() / 1000),
    });

    res.status(201).json({
      employerId: req.user.id,
      amount: amount.toString(),
      token,
      status: "accepted",
    });
  },
);

employersRouter.use(
  (err: any, req: Request, res: Response, next: NextFunction) => {
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("pkey") || constraint.includes("employer_id")) {
        return res.status(409).json({ error: "Employer with this Stellar address already exists." });
      }
      if (constraint.includes("email")) {
        return res.status(409).json({ error: "Employer with this email already exists." });
      }
      if (constraint.includes("organization_name") || constraint.includes("business_name")) {
        return res.status(409).json({ error: "Employer with this organization name already exists." });
      }
      return res.status(409).json({ error: "Duplicate employer record exists." });
    }
    next(err);
  }
);
