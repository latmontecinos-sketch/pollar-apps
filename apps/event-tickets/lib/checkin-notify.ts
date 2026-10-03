import { db, dbReady } from "./db.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n/locales.ts";
import { sendCheckinEmail } from "./mail.ts";

/** What became of the "you're in" email: nowhere to send it, it went, or it didn't. */
export type Notified = "none" | "sent" | "failed";

type Sender = (opts: {
  to: string;
  locale: Locale;
  eventName: string;
  checkedInAt: string;
}) => Promise<{ sent: boolean; error?: string }>;

/**
 * "You're in" email, in the language the buyer bought in. Best-effort and it
 * NEVER throws: by the time this runs the ticket is already spent and the
 * person is through the door, so a failure here (the database read, the mail
 * provider) must not turn the admission into a 500 — the scanner would show
 * an error, the staff would scan again and read USED for someone who got in.
 * The outcome is returned so the screen can say it (rule 14); the provider's
 * reason goes to the log.
 */
export async function notifyCheckin(
  saleId: string,
  eventName: string,
  send: Sender = sendCheckinEmail
): Promise<Notified> {
  try {
    await dbReady();
    const row = await db.execute({
      sql: "SELECT buyer_email, buyer_locale FROM sales WHERE id = ?",
      args: [saleId],
    });
    const email = row.rows[0]?.buyer_email;
    if (!email) return "none";
    const locale = row.rows[0]?.buyer_locale;
    const result = await send({
      to: String(email),
      locale: isLocale(locale as string) ? (locale as Locale) : DEFAULT_LOCALE,
      eventName,
      checkedInAt: new Date().toISOString(),
    });
    if (!result.sent) console.error(`[mail] check-in email failed: ${result.error}`);
    return result.sent ? "sent" : "failed";
  } catch (err) {
    console.error(`[mail] check-in email failed: ${err instanceof Error ? err.message : err}`);
    return "failed";
  }
}
