const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Plain `fetch` to Resend's REST API — no SDK dependency needed for one
 * transactional email. Best-effort: a failed send never blocks or reverses
 * the purchase, since the buyer's ticket already lives in their own account
 * (this is a convenience copy, not the source of truth).
 */
export async function sendTicketEmail(opts: {
  to: string;
  eventName: string;
  ticketCode: string;
  doorCode: string;
}): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: "RESEND_API_KEY no está configurada" };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Pollar Pass <onboarding@resend.dev>",
        to: [opts.to],
        subject: `Tu pase para ${opts.eventName}`,
        text: `Tu pase para "${opts.eventName}" está confirmado.\n\nCódigo del pase (QR): ${opts.ticketCode}\nCódigo de puerta: ${opts.doorCode}\n\nMostrá el código del pase en la entrada del evento.`,
      }),
    });
    if (!res.ok) {
      return { sent: false, error: `Resend respondió ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "fetch falló" };
  }
}
