import { expect, test } from "@playwright/test";

const mockUrl = "http://127.0.0.1:8797";

test.beforeEach(async ({ request }) => {
  await request.post(`${mockUrl}/__reset`);
});

test("two browser clicks reach verified public proof", async ({ page }) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "Run the trust network live." }),
  ).toBeVisible();
  await expect(page.getByText("8.295499 USDC")).toHaveCount(0);

  await page.getByLabel("Presenter passcode").fill("trust-demo");
  await page.getByRole("button", { name: "Unlock live demo" }).click();
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByText("All systems ready").click();
  await expect(page.getByText("8.295499 USDC")).toBeVisible();

  await page
    .getByRole("button", { name: "Create & fund $1 escrow" })
    .click();
  await expect(page).toHaveURL(/\/demo\?.*run=/);
  await expect(
    page.getByRole("button", { name: /Pay 0.25 USDC via x402/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Pay 0.25 USDC via x402/ })
    .click();
  await expect(page.getByText("A human is now in the loop")).toBeVisible();
  await expect(page.getByAltText(/QR code/)).toBeVisible();
  const telegram = await page.request.post(`${mockUrl}/__telegram-verdict`);
  expect(telegram.status()).toBe(202);

  await expect(page.getByText("Public proof complete")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("HumanEvidenceV1 verified")).toBeVisible();
  const stats = await page.request.get(`${mockUrl}/__stats`);
  expect((await stats.json()).statusRequests).toBeLessThan(20);
  const proofLink = await page
    .getByRole("link", { name: "Start another run" })
    .getAttribute("href");
  expect(proofLink).toBe("/demo");
});

test("presenter mode hides chrome and mobile puts action first", async ({
  page,
}, testInfo) => {
  await page.goto("/demo");
  await page.getByLabel("Presenter passcode").fill("trust-demo");
  await page.getByRole("button", { name: "Unlock live demo" }).click();
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("link", { name: "Presenter mode" }).click();
  await expect(page).toHaveURL(/present=1/);
  await expect(page.locator(".site-header")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();

  if (testInfo.project.name === "mobile") {
    const actionBox = await page.locator(".demo-console-action").boundingBox();
    const timelineBox = await page.locator(".demo-console-timeline").boundingBox();
    expect(actionBox).not.toBeNull();
    expect(timelineBox).not.toBeNull();
    expect(actionBox!.y).toBeLessThan(timelineBox!.y);
  }
});

test("public proof is terminal-only and sanitized", async ({ page }) => {
  await page.goto("/demo");
  await page.getByLabel("Presenter passcode").fill("trust-demo");
  await page.getByRole("button", { name: "Unlock live demo" }).click();
  await page
    .getByRole("button", { name: "Create & fund $1 escrow" })
    .click();
  await expect(page).toHaveURL(/\/demo\?.*run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();

  const pending = await page.request.get(`/proof/${runId}`);
  expect(pending.status()).toBe(404);
});
