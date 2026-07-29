import { expect, test } from "@playwright/test";

const mockUrl = "http://127.0.0.1:8797";
const provider = "0x2222222222222222222222222222222222222222";

test.beforeEach(async ({ request }) => {
  await request.post(`${mockUrl}/__reset`);
});

test("Feed and Review render from the durable snapshot without an Arc scan", async ({
  page,
}) => {
  const feedStart = Date.now();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Evaluation with receipts" }),
  ).toBeVisible();
  await expect(page.getByText("#160000", { exact: true })).toBeVisible();
  expect(Date.now() - feedStart).toBeLessThan(2_500);

  const reviewStart = Date.now();
  await page.getByRole("link", { name: "Review" }).click();
  await expect(
    page.getByRole("heading", { name: "Review operations" }),
  ).toBeVisible();
  expect(Date.now() - reviewStart).toBeLessThan(2_500);

  const stats = await page.request.get(`${mockUrl}/__stats`);
  expect((await stats.json()).snapshotRequests).toBe(2);
});

test("reputation stays unknown until the first verified snapshot", async ({
  page,
  request,
}) => {
  await request.post(`${mockUrl}/__snapshot-mode?mode=syncing`);

  const apiResponse = await page.request.get(`/api/reputation/${provider}`);
  expect(apiResponse.status()).toBe(503);

  const pageResponse = await page.goto(`/provider/${provider}`);
  expect(pageResponse?.status()).toBe(503);
});

test("stale reputation is explicitly disclosed", async ({ page, request }) => {
  await request.post(`${mockUrl}/__snapshot-mode?mode=stale`);

  const apiResponse = await page.request.get(`/api/reputation/${provider}`);
  expect(apiResponse.status()).toBe(200);
  expect(apiResponse.headers()["x-vapi-snapshot-status"]).toBe("stale");
  expect(apiResponse.headers().warning).toContain("last verified snapshot");
  expect((await apiResponse.json()).snapshot.status).toBe("stale");

  await page.goto(`/provider/${provider}`);
  await expect(
    page.getByText("Showing the last verified reputation snapshot"),
  ).toBeVisible();
});
