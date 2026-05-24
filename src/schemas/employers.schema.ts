import { z } from "zod";

export const employerOnboardingSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  registrationNumber: z.string().trim().min(3).max(100),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  contactName: z.string().trim().min(2).max(120).optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  stellarAddress: z
    .string()
    .trim()
    .regex(/^G[A-Z2-7]{55}$/, "Must be a valid Stellar public key (G...)"),
});

export const employerTreasuryDepositSchema = z.object({
  amount: z.coerce.bigint().positive(),
  token: z.string().trim().min(2).max(20).default("USDC"),
});

export type EmployerOnboardingInput = z.infer<typeof employerOnboardingSchema>;
export type EmployerTreasuryDepositInput = z.infer<
  typeof employerTreasuryDepositSchema
>;
