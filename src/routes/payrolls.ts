import { Router, Response } from "express";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { z } from "zod";
import {
  createPayroll,
  getPayrollsByOrg,
  getPayrollById,
  getPayrollEntries,
  createPayrollTemplate,
  getPayrollTemplatesByOrg,
  deletePayrollTemplate,
} from "../db/queries";
import { logger } from "../logger";

export const payrollsRouter = Router();

// All payroll routes require authentication
payrollsRouter.use(authenticateRequest, requireUser);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createPayrollSchema = z.object({
  orgId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  entries: z
    .array(
      z.object({
        workerAddress: z
          .string()
          .trim()
          .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
        amount: z
          .string()
          .trim()
          .regex(/^\d+$/, "Amount must be numeric (stroops)"),
      }),
    )
    .min(1, "At least one entry required")
    .max(20, "Max 20 entries per payroll"),
});

const createTemplateSchema = z.object({
  orgId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  entries: z
    .array(
      z.object({
        workerAddress: z.string().trim(),
        amount: z.string().trim(),
        purpose: z.string().trim().max(200).optional(),
      }),
    )
    .min(1),
});

const payrollIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const templateIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /payrolls
 * Create a new payroll group with entries.
 */
payrollsRouter.post(
  "/",
  validateRequest({ body: createPayrollSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId, name, entries } = req.body;

    try {
      const payroll = await createPayroll({
        orgId,
        name,
        createdBy: req.user.id,
        entries,
      });

      logger.info(
        { payrollId: payroll.id, orgId, entryCount: entries.length },
        "Payroll created",
      );

      return res.status(201).json({ payroll });
    } catch (err) {
      logger.error({ err }, "POST /payrolls failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /payrolls
 * List payrolls for an org.
 */
payrollsRouter.get(
  "/",
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orgId =
      typeof req.query.orgId === "string" ? req.query.orgId : undefined;
    if (!orgId) {
      return res.status(400).json({ error: "orgId query parameter is required" });
    }

    const limit =
      typeof req.query.limit === "string"
        ? parseInt(req.query.limit, 10)
        : 20;
    const offset =
      typeof req.query.offset === "string"
        ? parseInt(req.query.offset, 10)
        : 0;

    try {
      const payrolls = await getPayrollsByOrg(orgId, limit, offset);
      return res.json({ payrolls });
    } catch (err) {
      logger.error({ err }, "GET /payrolls failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /payrolls/:id
 * Get a single payroll with its entries.
 */
payrollsRouter.get(
  "/:id",
  validateRequest({ params: payrollIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;

    try {
      const payroll = await getPayrollById(Number(id));
      if (!payroll) {
        return res.status(404).json({ error: "Payroll not found" });
      }

      const entries = await getPayrollEntries(payroll.id);

      return res.json({ payroll, entries });
    } catch (err) {
      logger.error({ err }, "GET /payrolls/:id failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * POST /payrolls/templates
 * Save a payroll template for reuse.
 */
payrollsRouter.post(
  "/templates",
  validateRequest({ body: createTemplateSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId, name, entries } = req.body;

    try {
      const template = await createPayrollTemplate({
        orgId,
        name,
        createdBy: req.user.id,
        templateJson: entries,
      });

      return res.status(201).json({ template });
    } catch (err) {
      logger.error({ err }, "POST /payrolls/templates failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /payrolls/templates
 * List payroll templates for an org.
 */
payrollsRouter.get(
  "/templates",
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orgId =
      typeof req.query.orgId === "string" ? req.query.orgId : undefined;
    if (!orgId) {
      return res.status(400).json({ error: "orgId query parameter is required" });
    }

    try {
      const templates = await getPayrollTemplatesByOrg(orgId);
      return res.json({ templates });
    } catch (err) {
      logger.error({ err }, "GET /payrolls/templates failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * DELETE /payrolls/templates/:id
 * Delete a payroll template.
 */
payrollsRouter.delete(
  "/templates/:id",
  validateRequest({ params: templateIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const orgId =
      typeof req.query.orgId === "string" ? req.query.orgId : undefined;

    if (!orgId) {
      return res.status(400).json({ error: "orgId query parameter is required" });
    }

    try {
      await deletePayrollTemplate(Number(id), orgId);
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "DELETE /payrolls/templates/:id failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);
