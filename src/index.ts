
import { launch } from 'puppeteer';
import { login } from './services/auth';
import {
  goToReservations,
  processReservations,
} from './services/reservation';
import { solveCaptchaFlow } from './services/captcha';
import {
  allDatesCovered,
  getUpcomingBookableDates,
  loadState,
  saveState,
  updateState,
} from './services/state';
import {
  isCI,
  baseUrl,
  email,
  password,
  reservationsPreferences,
} from './config';

const RETRY_INTERVAL_MS = 30_000;
const MAX_WAIT_MS = 30 * 60_000;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function validateConfig() {
  const missing: string[] = [];

  if (!email) missing.push('EMAIL');
  if (!password) missing.push('PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}`
    );
  }

  const hasAnyDay = Object.values(
    reservationsPreferences
  ).some(Boolean);

  if (!hasAnyDay) {
    throw new Error('No reservation days configured');
  }
}

async function main() {
  validateConfig();

  let state = loadState();
  const upcomingDates = getUpcomingBookableDates();

  if (allDatesCovered(state, upcomingDates)) {
    console.log('✅ All upcoming sessions already handled');
    return;
  }

  const browser = await launch({
    headless: isCI,
    slowMo: isCI ? 0 : 50,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 720,
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );

    const loginUrl = `${baseUrl}/account/login.aspx`;

    if (isCI) {
      await solveCaptchaFlow(page, loginUrl);
    } else {
      await page.goto(loginUrl);
    }

    await login(page, email, password);

    const startedAt = Date.now();
    let attempt = 0;

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      attempt++;

      console.log(
        `🔄 Reservation check #${attempt}`
      );

      await goToReservations(page);

      const dayResults = await processReservations(
        page,
        reservationsPreferences
      );

      // Only persist genuinely confirmed reservations.
      const confirmed = dayResults.filter(
        ({ result }) => result.success
      );

      if (confirmed.length > 0) {
        state = updateState(
          state,
          confirmed.map(({ result }) => ({
            date: result.date,
            result,
          }))
        );

        saveState(state);
      }

      if (allDatesCovered(state, upcomingDates)) {
        console.log(
          '🎉 All requested reservations confirmed'
        );
        break;
      }

      const remaining =
        MAX_WAIT_MS - (Date.now() - startedAt);

      if (remaining <= 0) break;

      console.log(
        '⏳ Reservations still pending. Retrying in 30 seconds...'
      );

      await sleep(
        Math.min(RETRY_INTERVAL_MS, remaining)
      );
    }

    console.log('🏁 Reservation monitoring finished');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('Script finished');
  }
}

main();
