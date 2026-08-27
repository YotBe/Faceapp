import { registerOperator, startSession } from "@/lib/auth";
import { redirectTo } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  try {
    const session = await registerOperator(email, password);
    await startSession(session.operatorId, session.email);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not sign up";
    return redirectTo(`/signup?error=${encodeURIComponent(message)}`);
  }

  return redirectTo("/dashboard");
}
