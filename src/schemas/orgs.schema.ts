import { z } from "zod";

/**
 * Schema for adding a member to an org.
 */
export const addOrgMemberSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
  role: z.enum(["admin", "viewer"]).default("viewer"),
});

/**
 * Schema for updating a member's role.
 */
export const updateOrgMemberSchema = z.object({
  role: z.enum(["owner", "admin", "viewer"]),
});

/**
 * Schema for org ID path parameter.
 */
export const orgIdParamSchema = z.object({
  orgId: z.string().trim().min(1),
});

/**
 * Schema for org member path parameters.
 */
export const orgMemberParamSchema = z.object({
  orgId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
});

export type AddOrgMemberInput = z.infer<typeof addOrgMemberSchema>;
export type UpdateOrgMemberInput = z.infer<typeof updateOrgMemberSchema>;
export type OrgIdParam = z.infer<typeof orgIdParamSchema>;
export type OrgMemberParam = z.infer<typeof orgMemberParamSchema>;
