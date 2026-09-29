import { expect, test as setup, type Page } from '@playwright/test';
import { AUTH_STATE } from '../playwright.config';
import { totp } from './totp';

const SMS_WAIT = 180_000;

async function enterSecondFactor(page: Page) {
  const firstDigit = page.getByTestId('code-input').getByRole('textbox').first();
  await expect(firstDigit).toBeEditable();
  const secret = process.env.LEO_TOTP_SECRET;
  if (!secret) {
    console.log('Waiting for the SMS code to be typed into the browser...');
    return;
  }
  await firstDigit.click();
  await page.keyboard.type(totp(secret));
}

setup('log in to Bolt and pass 2FA', async ({ page }) => {
  setup.setTimeout(SMS_WAIT + 60_000);
  const { LEO_USERNAME, LEO_PASSWORD } = process.env;
  expect(LEO_USERNAME && LEO_PASSWORD, 'Set LEO_USERNAME and LEO_PASSWORD in .env').toBeTruthy();

  await page.goto('https://bolt.therealbrokerage.com/login?redirectTo=%2Fairm');
  await page.getByTestId('usernameOrEmail').fill(LEO_USERNAME!);
  await page.getByTestId('password').fill(LEO_PASSWORD!);
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page).toHaveURL(/\/login\/2fa/);
  await enterSecondFactor(page);

  await page.waitForURL('https://airm.therealbrokerage.com/**', { timeout: SMS_WAIT });
  await page.context().storageState({ path: AUTH_STATE });
});
