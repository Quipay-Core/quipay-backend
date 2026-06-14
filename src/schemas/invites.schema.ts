import { z } from "zod";

/**
 * Schema for creating a new invite.
 * Requires at least one of email or workerAddress.
 */
export const createInviteSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    workerAddress: z
      .string()
      .trim()
      .regex(/^G[A-Z2-7]{55}$/, "Must be a valid Stellar public key (G...)")
      .optional(),
    purpose: z.string().trim().min(1).max(200).optional(),
    amount: z
      .string()
      .trim()
      .regex(/^\d+$/, "Amount must be a numeric string (stroops)")
      .optional(),
    tokenAsset: z.string().trim().min(2).max(20).default("USDC"),
    expiresInDays: z.number().int().min(1).max(90).default(7),
    /** Invite type: worker (default) or member */
    inviteType: z.enum(["worker", "member"]).default("worker"),
    /** Role for member invites: admin | viewer (owner is set directly, not via invite) */
    role: z.enum(["admin", "viewer"]).optional(),
  })
  .refine((data) => data.email || data.workerAddress, {
    message: "Either email or workerAddress must be provided",
  });

/**
 * Schema for accepting an invite.
 * workerAddress: for worker invites (Stellar G-address)
 * userId: for member invites (auth user ID)
 */
export const acceptInviteSchema = z.object({
  workerAddress: z
    .string()
    .trim()
    .regex(/^G[A-Z2-7]{55}$/, "Must be a valid Stellar public key (G...)")
    .optional(),
  userId: z.string().trim().min(1).optional(),
  fullName: z.string().trim().min(1).max(120).optional(),
  jobTitle: z.string().trim().max(120).optional(),
});

/**
 * Schema for invite token path parameter.
 */
export const inviteTokenParamSchema = z.object({
  token: z.string().trim().min(1).max(64),
});

/**
 * Schema for invite ID path parameter.
 */
export const inviteIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Schema for listing invites (query params).
 */
export const listInvitesQuerySchema = z.object({
  status: z
    .enum(["pending", "accepted", "declined", "expired"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type InviteTokenParam = z.infer<typeof inviteTokenParamSchema>;
export type InviteIdParam = z.infer<typeof inviteIdParamSchema>;
export type ListInvitesQuery = z.infer<typeof listInvitesQuerySchema>;
