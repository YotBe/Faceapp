/**
 * End-to-end smoke test.
 *
 *   ./scripts/dev-all.sh && ./scripts/seed-demo.sh
 *   node scripts/make-fake-camera.py    # writes /tmp/fake-camera.y4m
 *   DEMO_SLUG=<slug> node e2e/smoke.mjs
 *
 * Drives the real product in a real browser, including the camera capture — the
 * flow is camera-only by design, so there is no upload path to test through
 * instead. Chromium is handed a synthetic camera; see e2e/README.md.
 *
 * Asserts as it goes and exits non-zero on failure, so it is usable as a check
 * rather than only as a screenshot generator.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SLUG = process.env.DEMO_SLUG;
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/shots";
const CAMERA = process.env.FAKE_CAMERA ?? "/tmp/fake-camera.y4m";
const EMAIL = process.env.DEMO_EMAIL ?? "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "correct-horse-battery";
const EXPECTED_MATCHES = Number(process.env.EXPECTED_MATCHES ?? 6);

if (!SLUG) {
  console.error("DEMO_SLUG is not set — run ./scripts/seed-demo.sh first");
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });

const failures = [];
function check(condition, description) {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    console.log(`  FAIL  ${description}`);
    failures.push(description);
  }
}

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${CAMERA}`,
    "--no-sandbox",
  ],
});

async function shot(page, name, options = {}) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, ...options });
}

try {
  // ---- operator ----------------------------------------------------------
  console.log("\noperator");
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => check(false, `page error: ${error.message}`));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await shot(page, "01-home");

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  check(true, "operator signs in and the session survives the redirect");
  await shot(page, "02-dashboard");

  await page.goto(`${BASE}/events/new`, { waitUntil: "networkidle" });
  const blocked = await page.getByText("Illinois", { exact: false }).count();
  check(blocked > 0, "blocked jurisdictions are shown with the reason");
  await shot(page, "03-new-event", { fullPage: true });

  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  // Exclude /events/new — the "New event" button is also an /events/ link and
  // sorts first in the DOM.
  const eventHref = await page
    .locator('a[href^="/events/"]:not([href="/events/new"])')
    .first()
    .getAttribute("href");
  await page.goto(`${BASE}${eventHref}`, { waitUntil: "networkidle" });
  check(
    (await page.getByText("Attendee link").count()) > 0,
    "the event page offers a share link and QR code",
  );
  await shot(page, "04-event-detail", { fullPage: true });

  // ---- attendee ----------------------------------------------------------
  console.log("\nattendee");
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ["camera"],
  });
  const mobile = await phone.newPage();
  mobile.on("pageerror", (error) => check(false, `page error: ${error.message}`));

  await mobile.goto(`${BASE}/e/${SLUG}`, { waitUntil: "networkidle" });
  check(
    (await mobile.getByText("deleted within a minute").count()) > 0,
    "the attendee is told the selfie is deleted before they take it",
  );
  await shot(mobile, "05-attendee-intro", { fullPage: true });

  await mobile.click("text=Turn on the camera");
  await mobile.waitForSelector("video", { timeout: 20000 });
  await mobile.waitForFunction(
    () => (document.querySelector("video")?.videoWidth ?? 0) > 0,
    { timeout: 20000 },
  );
  check(true, "the camera preview is live");
  await shot(mobile, "06-attendee-camera");

  await mobile.click("text=Take the selfie");
  await mobile.waitForTimeout(1000);
  await shot(mobile, "07-attendee-capturing");

  await mobile.waitForSelector("text=/photos? of you|did not find|No confident/", {
    timeout: 90000,
  });
  await mobile.waitForTimeout(800);
  await shot(mobile, "08-attendee-results", { fullPage: true });

  const heading = (await mobile.locator("h2").first().innerText()).trim();
  console.log(`        heading: ${heading}`);
  const shown = await mobile.locator("img").count();
  check(
    shown === EXPECTED_MATCHES,
    `${EXPECTED_MATCHES} photographs returned (got ${shown})`,
  );
  check(
    (await mobile.getByText("Your selfie was deleted").count()) > 0,
    "the results page reports the selfie was destroyed",
  );
  check(
    (await mobile.getByText("Development mode").count()) > 0,
    "untrusted thresholds are flagged on the results",
  );
  check(
    (await mobile.getByText(`Download ${EXPECTED_MATCHES}`).count()) > 0,
    "only the confident set is offered for download",
  );

  // The keep-link. Everything about it is server-side and depends on real
  // storage and a real album, so this is the only place it can be tested: the
  // token has to resolve to the same photographs the search just returned.
  const keepLink = await mobile.locator("input[readonly]").first().inputValue();
  check(keepLink.includes(`/e/${SLUG}/photos?k=`), "a keep-link is offered for the results");
  await shot(mobile, "10-attendee-keeplink");

  await mobile.goto(keepLink, { waitUntil: "networkidle" });
  const kept = await mobile.locator("img").count();
  check(
    kept === EXPECTED_MATCHES,
    `the keep-link reopens the same ${EXPECTED_MATCHES} photographs (got ${kept})`,
  );
  await shot(mobile, "11-attendee-kept", { fullPage: true });

  // One character changed, in the middle of the payload rather than at either
  // end where base64 padding could absorb it. The signature is what stops
  // somebody editing a link they were legitimately given into one for a
  // stranger's photographs.
  const at = keepLink.indexOf("?k=") + 10;
  const tampered =
    keepLink.slice(0, at) + (keepLink[at] === "A" ? "B" : "A") + keepLink.slice(at + 1);
  await mobile.goto(tampered, { waitUntil: "networkidle" });
  check(
    (await mobile.getByText("This link no longer works").count()) > 0,
    "an edited keep-link is refused",
  );

  await mobile.goto(`${BASE}/e/${SLUG}/opt-out`, { waitUntil: "networkidle" });
  check(
    (await mobile.getByRole("heading", { name: "Remove yourself" }).count()) > 0,
    "the opt-out is reachable without an account",
  );
  await shot(mobile, "09-attendee-optout", { fullPage: true });
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
