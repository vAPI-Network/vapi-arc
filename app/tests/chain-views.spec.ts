import { expect, test } from "@playwright/test";

const order = "0x1000000000000000000000000000000000000001";
const buyer = "0x2000000000000000000000000000000000000001";

test("Marketplace renders English-first navigation, workflow, and live states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Marketplace", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Disputes", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reputation", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work marketplace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await expect(page.getByText("Client funds a USDC escrow", { exact: true })).toBeVisible();
  await expect(page.getByText("Arc Testnet", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("125 USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("Submitted", { exact: true })).toBeVisible();
  await expect(page.getByText("Delivered — waiting for client review", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create an escrow" })).toBeVisible();
});

test("order detail renders state rail, countdown, and role-gated surface", async ({
  page,
}) => {
  await page.addInitScript((account) => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
          if (method === "eth_chainId") return "0x4cef52";
          return null;
        },
      },
    });
  }, buyer);
  await page.goto(`/orders/${order}`);
  await expect(page.getByRole("heading", { name: "125 USDC" })).toBeVisible();
  await expect(page.getByLabel("Order state")).toBeVisible();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Review closes", { exact: true })).toBeVisible();
  await expect(page.getByText("You are the client on this order", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available actions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client actions" })).toBeVisible();
  await expect(page.getByText("Approve the delivery and pay the vendor.", { exact: true })).toBeVisible();
});

test("Dispute reviews render phase progress and three-seat tally", async ({
  page,
}) => {
  await page.goto("/arbiters");
  await expect(page.getByRole("heading", { name: "Dispute reviews" })).toBeVisible();
  const progress = page.getByLabel("Dispute progress");
  await expect(progress.getByText("Evidence", { exact: true })).toBeVisible();
  await expect(progress.getByText("Sealed votes", { exact: true })).toBeVisible();
  await expect(progress.getByText("Reveal", { exact: true })).toBeVisible();
  await expect(progress.getByText("Executed", { exact: true })).toBeVisible();
  await expect(page.getByText("2/3", { exact: true })).toBeVisible();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();
  await expect(page.getByText("Roadmap · not live in V0", { exact: true })).toBeVisible();
});

test("Reputation renders plain score labels, attest crank, and ledger", async ({ page }) => {
  await page.goto(`/reputation?address=${buyer}`);
  await expect(page.getByRole("heading", { name: "Reputation", exact: true })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByText("Jobs settled", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resolved, awaiting attestation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Attest settlement/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attestation ledger" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Released 0x/ })).toBeVisible();
});
