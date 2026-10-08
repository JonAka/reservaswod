
import { Page } from 'puppeteer';

export async function login(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  console.log(`🔐 Login page: ${page.url()}`);

  const emailSelectors = [
    '#body_body_CtlLogin_IoEmail',
    'input[type="email"]',
    'input[name*="Email"]',
    'input[id*="Email"]',
  ];

  const passwordSelectors = [
    '#body_body_CtlLogin_IoPassword',
    'input[type="password"]',
  ];

  async function findVisibleSelector(
    selectors: string[]
  ): Promise<string> {
    for (const selector of selectors) {
      const element = await page.$(selector);

      if (!element) continue;

      const visible = await element.evaluate(el => {
        const input = el as HTMLElement;
        const style = window.getComputedStyle(input);

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          input.getClientRects().length > 0
        );
      });

      if (visible) return selector;
    }

    throw new Error(
      `No visible login field found. Current URL: ${page.url()}`
    );
  }

  await page.waitForSelector('body', {
    timeout: 15000,
  });

  const emailSelector = await findVisibleSelector(
    emailSelectors
  );

  const passwordSelector = await findVisibleSelector(
    passwordSelectors
  );

  console.log(`📧 Email field: ${emailSelector}`);
  console.log(`🔑 Password field: ${passwordSelector}`);

  await page.type(emailSelector, email);
  await page.type(passwordSelector, password);

  const submitSelectors = [
    '#body_body_CtlLogin_CtlAceptar',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  const submitSelector = await findVisibleSelector(
    submitSelectors
  );

  console.log(`🔘 Login button: ${submitSelector}`);

  await Promise.all([
    page.waitForNavigation({
      timeout: 60000,
    }).catch(() => null),
    page.click(submitSelector),
  ]);

  console.log(`🌐 After login: ${page.url()}`);

  const secondButtonSelector =
    '#body_body_CtlUp label.button:nth-of-type(2)';

  const secondButton = await page.$(
    secondButtonSelector
  );

  if (secondButton) {
    await secondButton.click();
    await page.waitForNetworkIdle({
      timeout: 5000,
    }).catch(() => {});
  }
}
