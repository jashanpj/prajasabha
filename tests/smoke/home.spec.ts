import { expect, test } from "@playwright/test";

// Scoped deliberately narrow: this is an empty-but-real skeleton (#13), not
// the real product surface yet. The fuller smoke coverage the dev-process
// playbook describes (verify flow, issue page, ledger render) lands once
// those features exist — asserting more here would be testing nothing.
test("home page loads", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("PrajaSabha");
});
