import { getSession } from "@/lib/auth";
import { createEvent } from "@/lib/events";
import { redirectTo } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return redirectTo("/login");
  }

  const form = await request.formData();
  try {
    const event = await createEvent(session.operatorId, {
      name: String(form.get("name") ?? ""),
      jurisdiction: String(form.get("jurisdiction") ?? "IL"),
      retentionDays: Number(form.get("retentionDays") ?? 60),
      isYouthEvent: form.get("isYouthEvent") === "on",
      isDemo: form.get("isDemo") === "on",
      acknowledgedBy: session.email,
      consentNoticeUrl: String(form.get("consentNoticeUrl") ?? ""),
    });
    return redirectTo(`/events/${event.id}`);
  } catch (error) {
    // The jurisdiction gate raises from a database trigger with a message
    // written for a human ("events in Illinois, USA are not accepted: BIPA...").
    // Passing it through unchanged is the whole point of having put it there.
    const message = error instanceof Error ? error.message : "could not create the event";
    return redirectTo(`/events/new?error=${encodeURIComponent(message)}`);
  }
}
