import { authenticate, startSession } from "@/lib/auth";
import { redirectTo } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const session = await authenticate(email, password);
  if (!session) {
    // One message for a wrong password and an unknown address: distinguishing
    // them tells an attacker which emails are registered.
    return redirectTo("/login?error=Those+details+did+not+match");
  }

  await startSession(session.operatorId, session.email);
  return redirectTo("/dashboard");
}
