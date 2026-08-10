import { expect, test } from "@playwright/test";

const order = "0x1000000000000000000000000000000000000001";
const buyer = "0x2000000000000000000000000000000000000001";

test("The Forum renders factory escrows and live states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Work marketplace" })).toBeVisible();
  await expect(page.getByText("Arc Testnet", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("125 USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("Submitted", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create an escrow" })).toBeVisible();
});

test("order detail renders state rail, countdown, and role-gated surface", async ({
  page,
}) => {
  await page.goto(`/orders/${order}`);
  await expect(page.getByRole("heading", { name: "125 USDC" })).toBeVisible();
  await expect(page.getByLabel("Order state")).toBeVisible();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Review closes", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available actions" })).toBeVisible();
});

test("The Praetors renders event-derived queue and three-seat tally", async ({
  page,
}) => {
  await page.goto("/arbiters");
  await expect(page.getByRole("heading", { name: "Dispute queue" })).toBeVisible();
  await expect(page.getByText("2/3", { exact: true })).toBeVisible();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();
  await expect(page.getByText("Roadmap · not live in V0", { exact: true })).toBeVisible();
});

test("The Census renders score tiles, attest crank, and ledger", async ({ page }) => {
  await page.goto(`/reputation?address=${buyer}`);
  await expect(page.getByRole("heading", { name: "Settlement reputation" })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resolved, awaiting attestation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Attest settlement/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attestation ledger" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Released 0x/ })).toBeVisible();
});
