import { Router, Response, Request } from "express";
import { randomBytes } from "crypto";
import multer from "multer";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { query } from "../db/pool";
import {
  createInviteSchema,
  acceptInviteSchema,
  inviteTokenParamSchema,
  inviteIdParamSchema,
  listInvitesQuerySchema,
} from "../schemas/invites.schema";
import {
  createInvite,
  getInviteByToken,
  getInviteById,
  getInvitesByEmployer,
  updateInviteStatus,
  countPendingInvites,
  expireStaleInvites,
} from "../db/queries";
import { sendInviteEmail } from "../notifier/notifier";
import { logger } from "../logger";

export const invitesRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe invite token (10 chars, ~60 bits of entropy).
 */
function generateInviteToken(): string {
  return randomBytes(8)
    .toString("base64url")
    .replace(/[_-]/g, "")
    .slice(0, 10)
    .toUpperCase();
}

/**
 * Build the frontend invite link for a given token.
 */
function buildInviteLink(token: string): string {
  const base =
    process.env.FRONTEND_URL ||
    (process.env.ALLOWED_ORIGINS ?? "").split(",")[0] ||
    "http://localhost:5173";
  return `${base}/join/${token}`;
}

// ─── Public routes (no auth) ─────────────────────────────────────────────────

/**
 * GET /invites/:token
 * Public — returns invite details for the worker to review before accepting.
 * Does NOT expose sensitive fields (invited_by, email, etc.).
 */
invitesRouter.get(
  "/:token",
  validateRequest({ params: inviteTokenParamSchema }),
  async (req: Request, res: Response): Promise<any> => {
    const token = String(req.params.token);

    const invite = await getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    // Auto-expire if past deadline
    if (invite.status === "pending" && new Date(invite.expires_at) <= new Date()) {
      await updateInviteStatus(invite.id, "expired");
      return res.status(410).json({ error: "Invite has expired", status: "expired" });
    }

    if (invite.status !== "pending") {
      return res.status(410).json({
        error: `Invite is ${invite.status}`,
        status: invite.status,
      });
    }

    // Look up employer name (public info)
    const employerRes = await query<{ business_name: string }>(
      `SELECT business_name FROM employers WHERE stellar_address = $1 LIMIT 1`,
      [invite.employer_address],
    );
    const employerName =
      employerRes.rows[0]?.business_name ?? "Unknown Employer";

    return res.json({
      token: invite.token,
      employerName,
      employerAddress: invite.employer_address,
      purpose: invite.purpose,
      amount: invite.amount,
      tokenAsset: invite.token_asset,
      status: invite.status,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    });
  },
);

/**
 * POST /invites/:token/accept
 * Public — accepts the invite. Behavior depends on invite_type:
 * - worker: creates worker_registration + employee_profile
 * - member: creates org_members entry
 */
invitesRouter.post(
  "/:token/accept",
  validateRequest({ params: inviteTokenParamSchema, body: acceptInviteSchema }),
  async (req: Request, res: Response): Promise<any> => {
    const token = String(req.params.token);
    const { workerAddress, userId, fullName, jobTitle } = req.body;

    const invite = await getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    if (invite.status !== "pending") {
      return res.status(410).json({
        error: `Invite is ${invite.status}`,
        status: invite.status,
      });
    }

    if (new Date(invite.expires_at) <= new Date()) {
      await updateInviteStatus(invite.id, "expired");
      return res.status(410).json({ error: "Invite has expired" });
    }

    const inviteType = (invite as any).invite_type ?? "worker";

    // ── Member invite ─────────────────────────────────────────────────────
    if (inviteType === "member") {
      if (!userId) {
        return res.status(400).json({ error: "userId is required for member invites" });
      }

      // Mark invite as accepted
      await updateInviteStatus(invite.id, "accepted");

      // Add to org_members
      try {
        await query(
          `INSERT INTO org_members (org_id, user_id, role, invited_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
          [invite.employer_address, userId, (invite as any).role ?? "viewer", invite.invited_by],
        );
      } catch (err) {
        logger.warn({ err }, "Failed to insert org_member");
      }

      logger.info(
        { inviteId: invite.id, orgId: invite.employer_address, userId },
        "Member invite accepted",
      );

      return res.json({
        success: true,
        inviteType: "member",
        orgId: invite.employer_address,
        userId,
        role: (invite as any).role ?? "viewer",
      });
    }

    // ── Worker invite (default) ───────────────────────────────────────────
    if (!workerAddress) {
      return res.status(400).json({ error: "workerAddress is required for worker invites" });
    }

    // Mark invite as accepted
    await updateInviteStatus(invite.id, "accepted", workerAddress);

    // Create worker registration
    try {
      await query(
        `INSERT INTO worker_registrations (worker_address, employer_address, registered_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (worker_address, employer_address) DO NOTHING`,
        [workerAddress, invite.employer_address],
      );
    } catch (err) {
      logger.warn({ err }, "Failed to insert worker_registration");
    }

    // Create/upsert employee profile if name provided
    if (fullName) {
      try {
        await query(
          `INSERT INTO employee_profiles (worker_address, employer_address, full_name, job_title)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (worker_address, employer_address)
           DO UPDATE SET full_name = EXCLUDED.full_name, job_title = EXCLUDED.job_title`,
          [workerAddress, invite.employer_address, fullName, jobTitle ?? null],
        );
      } catch (err) {
        logger.warn({ err }, "Failed to upsert employee_profile");
      }
    }

    logger.info(
      { inviteId: invite.id, employerAddress: invite.employer_address, workerAddress },
      "Worker invite accepted",
    );

    return res.json({
      success: true,
      inviteType: "worker",
      employerAddress: invite.employer_address,
      workerAddress,
      purpose: invite.purpose,
    });
  },
);

/**
 * POST /invites/:token/decline
 * Public — worker declines the invite.
 */
invitesRouter.post(
  "/:token/decline",
  validateRequest({ params: inviteTokenParamSchema }),
  async (req: Request, res: Response): Promise<any> => {
    const token = String(req.params.token);

    const invite = await getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    if (invite.status !== "pending") {
      return res.status(410).json({
        error: `Invite is ${invite.status}`,
        status: invite.status,
      });
    }

    await updateInviteStatus(invite.id, "declined");

    return res.json({ success: true, status: "declined" });
  },
);

// ─── Authenticated routes (employer) ─────────────────────────────────────────

invitesRouter.use(authenticateRequest, requireUser);

/**
 * POST /invites
 * Create a new invite. Employer must be authenticated.
 */
invitesRouter.post(
  "/",
  validateRequest({ body: createInviteSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employerAddress = req.user.stellarAddress ?? req.user.id;
    const {
      email,
      workerAddress,
      purpose,
      amount,
      tokenAsset,
      expiresInDays,
      inviteType,
      role,
    } = req.body;

    // Limit: max 50 pending invites per employer
    const pendingCount = await countPendingInvites(employerAddress);
    if (pendingCount >= 50) {
      return res.status(429).json({
        error: "Too many pending invites (max 50). Cancel some before creating new ones.",
      });
    }

    const token = generateInviteToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays ?? 7));

    const invite = await createInvite({
      token,
      employerAddress,
      email,
      workerAddress,
      purpose,
      amount,
      tokenAsset,
      invitedBy: req.user.id,
      expiresAt,
      inviteType: inviteType ?? "worker",
      role,
    });

    const link = buildInviteLink(token);

    // Send email if email provided
    if (email) {
      try {
        // Look up employer name for the email
        const employerRes = await query<{ business_name: string }>(
          `SELECT business_name FROM employers WHERE stellar_address = $1 LIMIT 1`,
          [employerAddress],
        );
        const employerName =
          employerRes.rows[0]?.business_name ?? "Your employer";

        await sendInviteEmail({
          to: email,
          employerName,
          purpose,
          amount,
          tokenAsset: tokenAsset ?? "USDC",
          inviteLink: link,
          inviteCode: token,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to send invite email");
        // Don't fail the request — invite was created
      }
    }

    logger.info(
      { inviteId: invite.id, employerAddress, email, workerAddress },
      "Invite created",
    );

    return res.status(201).json({
      id: invite.id,
      token: invite.token,
      link,
      code: token,
      status: invite.status,
      expiresAt: invite.expires_at,
    });
  },
);

/**
 * GET /invites
 * List invites for the authenticated employer.
 */
invitesRouter.get(
  "/",
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const employerAddress = req.user.stellarAddress ?? req.user.id;
      const status =
        typeof req.query.status === "string" ? req.query.status : undefined;
      const limit =
        typeof req.query.limit === "string"
          ? parseInt(req.query.limit, 10)
          : 50;
      const offset =
        typeof req.query.offset === "string"
          ? parseInt(req.query.offset, 10)
          : 0;

      const invites = await getInvitesByEmployer(employerAddress, {
        status,
        limit,
        offset,
      });

      const pendingCount = await countPendingInvites(employerAddress);

      return res.json({
        invites: invites.map((inv) => ({
          id: inv.id,
          token: inv.token,
          link: buildInviteLink(inv.token),
          code: inv.token,
          email: inv.email,
          workerAddress: inv.worker_address,
          purpose: inv.purpose,
          amount: inv.amount,
          tokenAsset: inv.token_asset,
          status: inv.status,
          expiresAt: inv.expires_at,
          acceptedAt: inv.accepted_at,
          declinedAt: inv.declined_at,
          createdAt: inv.created_at,
        })),
        pendingCount,
      });
    } catch (err) {
      logger.error({ err }, "GET /invites failed");
      return res
        .status(500)
        .json({ error: "Internal server error", detail: String(err) });
    }
  },
);

/**
 * DELETE /invites/:id
 * Cancel/revoke an invite. Only the employer who created it can cancel.
 */
invitesRouter.delete(
  "/:id",
  validateRequest({ params: inviteIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = String(req.params.id);
    const invite = await getInviteById(Number(id));

    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const employerAddress = req.user.stellarAddress ?? req.user.id;
    if (invite.employer_address !== employerAddress) {
      return res.status(403).json({ error: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res
        .status(410)
        .json({ error: `Invite is already ${invite.status}` });
    }

    // Use "declined" as the cancelled status (or we could add "cancelled" to the check constraint)
    await updateInviteStatus(invite.id, "declined");

    return res.json({ success: true, status: "declined" });
  },
);

/**
 * POST /invites/:id/resend
 * Resend an invite email. Only works for email-based invites.
 */
invitesRouter.post(
  "/:id/resend",
  validateRequest({ params: inviteIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = String(req.params.id);
    const invite = await getInviteById(Number(id));

    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const employerAddress = req.user.stellarAddress ?? req.user.id;
    if (invite.employer_address !== employerAddress) {
      return res.status(403).json({ error: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res
        .status(410)
        .json({ error: `Invite is already ${invite.status}` });
    }

    if (!invite.email) {
      return res
        .status(400)
        .json({ error: "Invite has no email address — cannot resend" });
    }

    if (new Date(invite.expires_at) <= new Date()) {
      return res.status(410).json({ error: "Invite has expired" });
    }

    // Look up employer name
    const employerRes = await query<{ business_name: string }>(
      `SELECT business_name FROM employers WHERE stellar_address = $1 LIMIT 1`,
      [employerAddress],
    );
    const employerName =
      employerRes.rows[0]?.business_name ?? "Your employer";

    try {
      await sendInviteEmail({
        to: invite.email,
        employerName,
        purpose: invite.purpose ?? undefined,
        amount: invite.amount ?? undefined,
        tokenAsset: invite.token_asset ?? "USDC",
        inviteLink: buildInviteLink(invite.token),
        inviteCode: invite.token,
      });
    } catch (err) {
      logger.error({ err }, "Failed to resend invite email");
      return res.status(502).json({ error: "Failed to send email" });
    }

    return res.json({ success: true, message: "Invite email resent" });
  },
);

// ─── CSV upload for bulk invites ─────────────────────────────────────────────

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 }, // 512KB max
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.originalname.endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

interface CsvRow {
  email?: string;
  worker_address?: string;
  amount?: string;
  purpose?: string;
  lineNumber: number;
}

interface CsvPreviewRow extends CsvRow {
  status: "valid" | "new_invite" | "error";
  error?: string;
  matchedEmployee?: string;
}

/**
 * Parse a simple CSV string into rows.
 * Expected columns (case-insensitive, trimmed):
 *   email, worker_address (or wallet/address), amount, purpose
 */
function parseCsv(raw: string): CsvRow[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Parse header
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));

  const emailIdx = header.findIndex(
    (h) => h === "email" || h === "worker_email",
  );
  const walletIdx = header.findIndex(
    (h) =>
      h === "worker_address" ||
      h === "wallet" ||
      h === "address" ||
      h === "wallet_address" ||
      h === "stellar_address",
  );
  const amountIdx = header.findIndex(
    (h) => h === "amount" || h === "usdc" || h === "payment",
  );
  const purposeIdx = header.findIndex(
    (h) => h === "purpose" || h === "description" || h === "label",
  );

  if (emailIdx === -1 && walletIdx === -1) {
    throw new Error(
      "CSV must have an 'email' or 'worker_address' column",
    );
  }

  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse (handles quoted fields)
    const cols: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cols.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    cols.push(current.trim());

    const email = emailIdx >= 0 ? cols[emailIdx]?.trim() : undefined;
    const wallet = walletIdx >= 0 ? cols[walletIdx]?.trim() : undefined;
    const amount = amountIdx >= 0 ? cols[amountIdx]?.trim() : undefined;
    const purpose = purposeIdx >= 0 ? cols[purposeIdx]?.trim() : undefined;

    // Skip completely empty rows
    if (!email && !wallet) continue;

    rows.push({
      email: email || undefined,
      worker_address: wallet || undefined,
      amount: amount || undefined,
      purpose: purpose || undefined,
      lineNumber: i + 1,
    });
  }

  return rows;
}

/**
 * Validate a Stellar address.
 */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

/**
 * POST /invites/csv/preview
 * Upload a CSV file and preview the results before creating invites.
 * Returns matched employees, new invites, and errors.
 */
invitesRouter.post(
  "/csv/preview",
  authenticateRequest,
  requireUser,
  csvUpload.single("file"),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const employerAddress = req.user.stellarAddress ?? req.user.id;

    let rows: CsvRow[];
    try {
      rows = parseCsv(file.buffer.toString("utf-8"));
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to parse CSV",
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({
        error: "CSV is empty or has no valid rows",
      });
    }

    if (rows.length > 500) {
      return res.status(400).json({
        error: "CSV has too many rows (max 500)",
      });
    }

    // Check each row against existing employees and validate
    const preview: CsvPreviewRow[] = [];

    // Fetch existing employee wallets for this employer
    let existingWorkers: Set<string> = new Set();
    try {
      const workersRes = await query<{ worker_address: string }>(
        `SELECT worker_address FROM worker_registrations WHERE employer_address = $1`,
        [employerAddress],
      );
      existingWorkers = new Set(
        workersRes.rows.map((r) => r.worker_address),
      );
    } catch {
      // Table might not exist — continue with empty set
    }

    for (const row of rows) {
      const previewRow: CsvPreviewRow = { ...row, status: "valid" };

      // Validate wallet address if provided
      if (row.worker_address) {
        if (!isValidStellarAddress(row.worker_address)) {
          previewRow.status = "error";
          previewRow.error = "Invalid Stellar address";
        } else if (existingWorkers.has(row.worker_address)) {
          previewRow.status = "valid";
          previewRow.matchedEmployee = row.worker_address;
        } else {
          previewRow.status = "new_invite";
        }
      } else if (row.email) {
        // Email-only invite — always a new invite
        previewRow.status = "new_invite";
      }

      // Validate amount if provided
      if (row.amount && previewRow.status !== "error") {
        if (!/^\d+$/.test(row.amount)) {
          previewRow.status = "error";
          previewRow.error = "Amount must be a positive integer (stroops)";
        }
      }

      preview.push(previewRow);
    }

    const validCount = preview.filter(
      (r) => r.status === "valid" || r.status === "new_invite",
    ).length;
    const errorCount = preview.filter((r) => r.status === "error").length;
    const newInviteCount = preview.filter(
      (r) => r.status === "new_invite",
    ).length;

    return res.json({
      rows: preview,
      summary: {
        total: rows.length,
        valid: validCount,
        errors: errorCount,
        newInvites: newInviteCount,
        matched: validCount - newInviteCount,
      },
    });
  },
);

/**
 * POST /invites/csv/create
 * Create invites from a CSV preview (the validated rows).
 * Expects JSON body with { rows: CsvRow[] } from the preview step.
 */
invitesRouter.post(
  "/csv/create",
  authenticateRequest,
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employerAddress = req.user.stellarAddress ?? req.user.id;
    const { rows, expiresInDays } = req.body as {
      rows?: CsvRow[];
      expiresInDays?: number;
    };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    if (rows.length > 500) {
      return res.status(400).json({ error: "Too many rows (max 500)" });
    }

    // Check pending invite limit
    const pendingCount = await countPendingInvites(employerAddress);
    if (pendingCount + rows.length > 500) {
      return res.status(429).json({
        error: `Would exceed 500 pending invites limit (currently ${pendingCount}, adding ${rows.length})`,
      });
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays ?? 7));

    // Look up employer name for emails
    const employerRes = await query<{ business_name: string }>(
      `SELECT business_name FROM employers WHERE stellar_address = $1 LIMIT 1`,
      [employerAddress],
    );
    const employerName =
      employerRes.rows[0]?.business_name ?? "Your employer";

    const results: Array<{
      row: CsvRow;
      success: boolean;
      token?: string;
      link?: string;
      error?: string;
    }> = [];

    for (const row of rows) {
      try {
        // Validate
        if (row.worker_address && !isValidStellarAddress(row.worker_address)) {
          results.push({ row, success: false, error: "Invalid Stellar address" });
          continue;
        }

        const token = generateInviteToken();
        const invite = await createInvite({
          token,
          employerAddress,
          email: row.email,
          workerAddress: row.worker_address,
          purpose: row.purpose,
          amount: row.amount,
          invitedBy: req.user.id,
          expiresAt,
        });

        const link = buildInviteLink(token);

        // Send email if email provided
        if (row.email) {
          try {
            await sendInviteEmail({
              to: row.email,
              employerName,
              purpose: row.purpose,
              amount: row.amount,
              tokenAsset: "USDC",
              inviteLink: link,
              inviteCode: token,
            });
          } catch {
            // Don't fail the row — invite was created
          }
        }

        results.push({ row, success: true, token, link });
      } catch (err) {
        results.push({
          row,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    logger.info(
      { employerAddress, total: rows.length, success: successCount, failed: failCount },
      "Bulk invite creation completed",
    );

    return res.json({
      results,
      summary: {
        total: rows.length,
        success: successCount,
        failed: failCount,
      },
    });
  },
);
