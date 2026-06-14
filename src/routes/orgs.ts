import { Router, Response } from "express";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { query } from "../db/pool";
import {
  addOrgMemberSchema,
  updateOrgMemberSchema,
  orgIdParamSchema,
  orgMemberParamSchema,
} from "../schemas/orgs.schema";
import {
  getUserOrgs,
  getOrgMembers,
  getUserOrgRole,
  addOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
  isOrgAdmin,
  isOrgOwner,
} from "../db/queries";
import { logger } from "../logger";

export const orgsRouter = Router();

// All org routes require authentication
orgsRouter.use(authenticateRequest, requireUser);

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface OrgInfo {
  orgId: string;
  businessName: string;
  stellarAddress: string;
  role: string;
  joinedAt: Date;
}

/**
 * Get org details (business name, stellar address) for a list of org IDs.
 */
async function getOrgDetails(
  orgIds: string[],
): Promise<Map<string, { businessName: string; stellarAddress: string }>> {
  if (orgIds.length === 0) return new Map();

  const res = await query<{
    employer_id: string;
    business_name: string;
    stellar_address: string;
  }>(
    `SELECT employer_id, business_name, stellar_address
     FROM employers WHERE employer_id = ANY($1)`,
    [orgIds],
  );

  const map = new Map<
    string,
    { businessName: string; stellarAddress: string }
  >();
  for (const row of res.rows) {
    map.set(row.employer_id, {
      businessName: row.business_name,
      stellarAddress: row.stellar_address,
    });
  }
  return map;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /orgs
 * List all orgs the current user belongs to.
 */
orgsRouter.get(
  "/",
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const memberships = await getUserOrgs(req.user.id);
      const orgIds = memberships.map((m) => m.org_id);
      const details = await getOrgDetails(orgIds);

      const orgs: OrgInfo[] = memberships.map((m) => {
        const detail = details.get(m.org_id);
        return {
          orgId: m.org_id,
          businessName: detail?.businessName ?? "Unknown",
          stellarAddress: detail?.stellarAddress ?? "",
          role: m.role,
          joinedAt: m.joined_at,
        };
      });

      return res.json({ orgs });
    } catch (err) {
      logger.error({ err }, "GET /orgs failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /orgs/:orgId
 * Get org details. Requires membership.
 */
orgsRouter.get(
  "/:orgId",
  validateRequest({ params: orgIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId } = req.params;
    const role = await getUserOrgRole(orgId, req.user.id);
    if (!role) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    try {
      const details = await getOrgDetails([orgId]);
      const detail = details.get(orgId);

      // Get member count
      const members = await getOrgMembers(orgId);

      return res.json({
        orgId,
        businessName: detail?.businessName ?? "Unknown",
        stellarAddress: detail?.stellarAddress ?? "",
        role,
        memberCount: members.length,
      });
    } catch (err) {
      logger.error({ err }, "GET /orgs/:orgId failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /orgs/:orgId/members
 * List all members of an org. Requires membership.
 */
orgsRouter.get(
  "/:orgId/members",
  validateRequest({ params: orgIdParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId } = req.params;
    const role = await getUserOrgRole(orgId, req.user.id);
    if (!role) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    try {
      const members = await getOrgMembers(orgId);
      return res.json({ members, role });
    } catch (err) {
      logger.error({ err }, "GET /orgs/:orgId/members failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * POST /orgs/:orgId/members
 * Add a member to an org. Requires owner or admin role.
 */
orgsRouter.post(
  "/:orgId/members",
  validateRequest({ params: orgIdParamSchema, body: addOrgMemberSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId } = req.params;
    const { userId, role } = req.body;

    // Check requester is admin or owner
    const isAdminOrOwner = await isOrgAdmin(orgId, req.user.id);
    if (!isAdminOrOwner) {
      return res
        .status(403)
        .json({ error: "Only org owners and admins can add members" });
    }

    // Only owners can add other owners or admins
    if (role === "owner" || role === "admin") {
      const isOwner = await isOrgOwner(orgId, req.user.id);
      if (!isOwner) {
        return res
          .status(403)
          .json({ error: "Only org owners can add owners or admins" });
      }
    }

    try {
      const member = await addOrgMember({
        orgId,
        userId,
        role,
        invitedBy: req.user.id,
      });

      logger.info({ orgId, userId, role }, "Org member added");

      return res.status(201).json({ member });
    } catch (err) {
      logger.error({ err }, "POST /orgs/:orgId/members failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * PUT /orgs/:orgId/members/:userId
 * Update a member's role. Requires owner role.
 */
orgsRouter.put(
  "/:orgId/members/:userId",
  validateRequest({ params: orgMemberParamSchema, body: updateOrgMemberSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId, userId } = req.params;
    const { role } = req.body;

    // Only owners can change roles
    const isOwner = await isOrgOwner(orgId, req.user.id);
    if (!isOwner) {
      return res
        .status(403)
        .json({ error: "Only org owners can change member roles" });
    }

    // Can't change your own role
    if (userId === req.user.id) {
      return res
        .status(400)
        .json({ error: "Cannot change your own role" });
    }

    // Can't demote the last owner
    if (role !== "owner") {
      const members = await getOrgMembers(orgId);
      const owners = members.filter((m) => m.role === "owner");
      if (owners.length === 1 && owners[0].user_id === userId) {
        return res
          .status(400)
          .json({ error: "Cannot remove the last owner" });
      }
    }

    try {
      await updateOrgMemberRole(orgId, userId, role);
      logger.info({ orgId, userId, role }, "Org member role updated");
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "PUT /orgs/:orgId/members/:userId failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * DELETE /orgs/:orgId/members/:userId
 * Remove a member from an org. Owner can remove anyone; admin can remove viewers.
 */
orgsRouter.delete(
  "/:orgId/members/:userId",
  validateRequest({ params: orgMemberParamSchema }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orgId, userId } = req.params;

    // Can't remove yourself (use leave instead)
    if (userId === req.user.id) {
      return res
        .status(400)
        .json({ error: "Cannot remove yourself. Use leave instead." });
    }

    const requesterRole = await getUserOrgRole(orgId, req.user.id);
    if (!requesterRole) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    const targetRole = await getUserOrgRole(orgId, userId);
    if (!targetRole) {
      return res.status(404).json({ error: "User is not a member of this organization" });
    }

    // Owners can remove anyone
    // Admins can only remove viewers
    if (requesterRole === "owner") {
      // OK
    } else if (requesterRole === "admin" && targetRole === "viewer") {
      // OK
    } else {
      return res
        .status(403)
        .json({ error: "Insufficient permissions to remove this member" });
    }

    try {
      await removeOrgMember(orgId, userId);
      logger.info({ orgId, userId }, "Org member removed");
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "DELETE /orgs/:orgId/members/:userId failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);
