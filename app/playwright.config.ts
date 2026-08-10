import { defineConfig, devices } from "@playwright/test";

const appUrl = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: appUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command:
      "pnpm build && PORT=4173 NODE_ENV=test VAPI_CHAIN_MOCK=1 pnpm start",
    url: `${appUrl}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
