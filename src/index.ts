import { launch } from 'puppeteer';
import { login } from './services/auth';
import { goToReservations, processReservations } from './services/reservation';
import { solveCaptchaFlow } from './services/captcha';
import { allDatesCovered, getUpcomingBookableDates, loadState, saveState, updateState } from './services/state';
import { isCI, baseUrl, email, password, reservationsPreferences } from './config';

const RETRY_INTERVAL_MS = 30_000;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONITOR_ENABLED = process.env.MONITOR_OPENING === 'true' && !DRY_RUN;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function validateConfig(): void {
  const missing = [!email && 'EMAIL', !password && 'PASSWORD'].filter(Boolean);
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  if (!Object.values(reservationsPreferences).some(Boolean)) throw new Error('No reservation days configured');
}

function monitoringDeadline(): number {
  // Deadline is 14:00 local Madrid on the current day, including DST.
  // We start only after the workflow's 13:30 gate. Avoid a date-based timezone parser.
  const now = Date.now();
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: 'Europe/Madrid', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(new Date());
  const val = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  const seconds = val('hour') * 3600 + val('minute') * 60 + val('second');
  return now + Math.max(0, 14 * 3600 - seconds) * 1000;
}

async function main(): Promise<void> {
  validateConfig();
  let state = loadState();
  const upcomingDates = getUpcomingBookableDates();
  if (!DRY_RUN && allDatesCovered(state, upcomingDates)) {
    console.log(`✅ All upcoming sessions already booked: ${upcomingDates.join(', ')}`);
    return;
  }
  const browser = await launch({
    headless: isCI, slowMo: isCI ? 0 : 50,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1280, height: 720});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const loginUrl = `${baseUrl}/account/login.aspx`;
    if (isCI) await solveCaptchaFlow(page, loginUrl);
    else await page.goto(loginUrl);
    await login(page, email, password);
    const deadline = MONITOR_ENABLED ? monitoringDeadline() : Date.now();
    let attempt = 0;
    while (true) {
      attempt++;
      console.log(`🔄 Reservation check #${attempt}`);
      await goToReservations(page);
      const dayResults = await processReservations(page, reservationsPreferences);
      if (!DRY_RUN) {
        state = updateState(state, dayResults.map(({ result }) => ({date: result.date, result})));
        saveState(state);
        if (allDatesCovered(state, upcomingDates)) {
          console.log('🎉 All requested reservations confirmed');
          break;
        }
      }
      if (!MONITOR_ENABLED || Date.now() >= deadline) break;
      const wait = Math.min(RETRY_INTERVAL_MS, deadline - Date.now());
      console.log(`⏳ Pending reservations. Retrying in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
  } catch (error) {
    console.error('Error in the script:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('Script finished');
  }
}
main();
