import { endSession } from "@/lib/auth";
import { redirectTo } from "@/lib/http";

export const runtime = "nodejs";

export async function POST() {
  await endSession();
  return redirectTo("/login");
}
