/**
 * One line to the ops alert channel (ALERT_WEBHOOK_URL). Same two forms as
 * cron/ops-heartbeat.ts send(): a Telegram sendMessage URL takes the text as
 * a query parameter, anything else gets JSON { text, content } (Slack,
 * Discord). Never throws; a failed send logs a constant line only, because
 * the text may carry a customer's domain (2026-10-01, pilot apply).
 */
export async function sendAlert(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    let resp: Response;
    if (url.hostname === "api.telegram.org") {
      url.searchParams.set("text", text);
      resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    } else {
      resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    // A refused call used to pass for a delivered one (2026-10-02). The
    // status only: never the URL (it holds the bot token) or the text.
    if (!resp.ok) console.error(`[rawuser/alert] webhook refused: HTTP ${resp.status}`);
  } catch {
    console.error("[rawuser/alert] webhook send failed (non-critical)");
  }
}
