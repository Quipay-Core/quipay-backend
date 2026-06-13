/**
 * Email templates for the invite system.
 *
 * Each template is a pure function returning { subject, html }.
 * Follows the same pattern as alertEmails.ts.
 */

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

/**
 * Shared email layout wrapper.
 */
const baseLayout = (title: string, body: string): string => `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">
    <div style="text-align: center; margin-bottom: 32px;">
      <div style="display: inline-block; background-color: #facc15; color: #000000; font-weight: 800; font-size: 20px; padding: 8px 20px; border-radius: 8px; letter-spacing: -0.5px;">
        Quipay
      </div>
    </div>

    <h2 style="font-size: 22px; font-weight: 700; color: #111111; margin: 0 0 16px 0; text-align: center;">
      ${escapeHtml(title)}
    </h2>

    <div style="font-size: 14px; line-height: 1.6; color: #333333;">
      ${body}
    </div>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />

    <div style="font-size: 12px; color: #9ca3af; text-align: center; line-height: 1.5;">
      This is an automated email from Quipay. Do not reply to this email.<br />
      If you did not expect this invitation, you can safely ignore it.
    </div>
  </div>
`;

/**
 * Format a stroop amount to human-readable USDC.
 * 1 USDC = 10,000,000 stroops (1e7).
 */
const formatAmount = (amount: string | undefined, asset: string): string => {
  if (!amount) return "";
  try {
    const stroops = BigInt(amount);
    const whole = stroops / 10_000_000n;
    const frac = stroops % 10_000_000n;
    const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr} ${asset}` : `${whole} ${asset}`;
  } catch {
    return `${amount} ${asset}`;
  }
};

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Render an invite email for a worker.
 */
export const renderInviteEmail = (params: {
  employerName: string;
  purpose?: string;
  amount?: string;
  tokenAsset: string;
  inviteLink: string;
  inviteCode: string;
}): { subject: string; html: string } => {
  const {
    employerName,
    purpose,
    amount,
    tokenAsset,
    inviteLink,
    inviteCode,
  } = params;

  const amountDisplay = formatAmount(amount, tokenAsset);
  const purposeLine = purpose
    ? `<p style="margin: 0 0 8px 0;"><strong>Purpose:</strong> ${escapeHtml(purpose)}</p>`
    : "";
  const amountLine = amountDisplay
    ? `<p style="margin: 0 0 8px 0;"><strong>Amount:</strong> ${escapeHtml(amountDisplay)}</p>`
    : "";

  const body = `
    <p style="margin: 0 0 16px 0;">
      <strong>${escapeHtml(employerName)}</strong> has invited you to receive a payment stream on Quipay.
    </p>

    ${purposeLine}
    ${amountLine}

    <p style="margin: 0 0 24px 0;">
      Quipay streams payments in real-time — you earn every second, and can withdraw to your Stellar wallet at any time.
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${escapeHtml(inviteLink)}"
         style="display: inline-block; background-color: #facc15; color: #000000; font-weight: 700; font-size: 15px; padding: 14px 32px; border-radius: 12px; text-decoration: none;">
        Accept Invitation
      </a>
    </div>

    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 24px 0; text-align: center;">
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">
        Or enter this code manually
      </p>
      <p style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 0.15em; color: #111111; font-family: monospace;">
        ${escapeHtml(inviteCode)}
      </p>
    </div>

    <p style="margin: 16px 0 0 0; font-size: 13px; color: #6b7280;">
      If the button doesn't work, copy and paste this link into your browser:<br />
      <a href="${escapeHtml(inviteLink)}" style="color: #2563eb; word-break: break-all;">
        ${escapeHtml(inviteLink)}
      </a>
    </p>
  `;

  return {
    subject: `${employerName} invited you to receive payments on Quipay`,
    html: baseLayout("You've Been Invited", body),
  };
};

/**
 * Render an invite reminder email (for resends).
 */
export const renderInviteReminderEmail = (params: {
  employerName: string;
  purpose?: string;
  inviteLink: string;
  inviteCode: string;
}): { subject: string; html: string } => {
  const { employerName, purpose, inviteLink, inviteCode } = params;

  const purposeLine = purpose
    ? `<p style="margin: 0 0 16px 0;">This is for: <strong>${escapeHtml(purpose)}</strong></p>`
    : "";

  const body = `
    <p style="margin: 0 0 16px 0;">
      <strong>${escapeHtml(employerName)}</strong> sent you a reminder about their payment stream invitation.
    </p>

    ${purposeLine}

    <p style="margin: 0 0 24px 0;">
      Connect your Stellar wallet to start receiving real-time payments.
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${escapeHtml(inviteLink)}"
         style="display: inline-block; background-color: #facc15; color: #000000; font-weight: 700; font-size: 15px; padding: 14px 32px; border-radius: 12px; text-decoration: none;">
        Accept Invitation
      </a>
    </div>

    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 24px 0; text-align: center;">
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">
        Invite code
      </p>
      <p style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 0.15em; color: #111111; font-family: monospace;">
        ${escapeHtml(inviteCode)}
      </p>
    </div>
  `;

  return {
    subject: `Reminder: ${employerName} is waiting for you on Quipay`,
    html: baseLayout("Invitation Reminder", body),
  };
};
