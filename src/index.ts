import { launch } from 'puppeteer';
import { login } from './services/auth';
import { goToReservations, processReservations } from './services/reservation';
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

const RETRY_INTERVAL_MS = Number(process.env.RETRY_INTERVAL_MS || '30000');
const MONITOR_END_TIME = process.env.MONITOR_END_TIME || '14:00';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONITOR_ENABLED = process.env.MONITOR_OPENING === 'true' && !DRY_RUN;
const WAIT_FOR_OPENING = process.env.WAIT_FOR_OPENING === 'true';
const BOOKING_TIME = process.env.BOOKING_TIME || '13:30';
const TIME_ZONE = 'Europe/Madrid';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function validateConfig(): void {
  const missing = [!email && 'EMAIL', !password && 'PASSWORD'].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  }
  if (!Number.isInteger(RETRY_INTERVAL_MS) || RETRY_INTERVAL_MS < 2000 || RETRY_INTERVAL_MS > 60000) {
    throw new Error('RETRY_INTERVAL_MS must be between 2000 and 60000');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(MONITOR_END_TIME)) {
    throw new Error('MONITOR_END_TIME must use HH:mm format');
  }
  if (!Object.values(reservationsPreferences).some(Boolean)) {
    throw new Error('No reservation days configured');
  }
}

function getMadridSecondsOfDay(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0');
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

function bookingTimeSeconds(): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(BOOKING_TIME);
  if (!match) throw new Error(`Invalid BOOKING_TIME: ${BOOKING_TIME}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid BOOKING_TIME: ${BOOKING_TIME}`);
  return hour * 3600 + minute * 60;
}

async function waitForOpening(): Promise<void> {
  if (!WAIT_FOR_OPENING) return;
  const target = bookingTimeSeconds();
  const remaining = target - getMadridSecondsOfDay();
  // A scheduled run starting after the deadline must not wait until tomorrow.
  if (remaining < -30 * 60) {
    throw new Error(`Scheduled workflow started too late for ${BOOKING_TIME} Madrid.`);
  }
  console.log(`⏰ Logged in. Waiting until ${BOOKING_TIME} (${TIME_ZONE}).`);
  while (getMadridSecondsOfDay() < target) {
    await sleep(Math.min(1000, (target - getMadridSecondsOfDay()) * 1000));
  }
  console.log('🚀 Booking window reached. Starting reservations.');
}

function monitoringDeadline(): number {
  const [hour, minute] = MONITOR_END_TIME.split(':').map(Number);
  return Date.now() + Math.max(0, hour * 3600 + minute * 60 - getMadridSecondsOfDay()) * 1000;
}

async function main(): Promise<void> {
  validateConfig();
  let state = loadState();
  const upcomingDates = getUpcomingBookableDates();
  console.log(`📅 Target dates: ${upcomingDates.join(', ')}`);
  console.log(`🧪 Dry run: ${DRY_RUN}`);
  console.log(`🔁 Monitoring enabled: ${MONITOR_ENABLED}`);
  console.log(`⏰ Wait for opening: ${WAIT_FOR_OPENING}, booking time: ${BOOKING_TIME}`);

  if (!DRY_RUN && allDatesCovered(state, upcomingDates)) {
    console.log('ℹ️ Cached bookings found. Verifying against WodBuster.');
  }

  const browser = await launch({
    headless: isCI,
    slowMo: isCI ? 0 : 50,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const loginUrl = `${baseUrl}/account/login.aspx`;
    if (isCI) await solveCaptchaFlow(page, loginUrl);
    else await page.goto(loginUrl);
    await login(page, email, password);
    console.log('✅ Login completed. Session prepared.');
    await waitForOpening();

    const deadline = MONITOR_ENABLED ? monitoringDeadline() : Date.now();
    let attempt = 0;
    let allConfirmed = false;

    while (!allConfirmed) {
      attempt++;
      console.log(`🔄 Reservation check #${attempt}`);
      try {
        await goToReservations(page);
        const dayResults = await processReservations(page, reservationsPreferences);
        if (!DRY_RUN) {
          state = updateState(state, dayResults.map(({ result }) => ({ date: result.date, result })));
          saveState(state);
          const confirmedDates = new Set(
            dayResults
              .filter(({ result }) => result.success &&
                (result.state === 'Borrar' || result.state === 'Entrenar'))
              .map(({ result }) => result.date)
              .filter((date): date is string => Boolean(date))
          );
          allConfirmed = upcomingDates.length > 0 &&
            upcomingDates.every(date => confirmedDates.has(date));
          if (allConfirmed) {
            console.log('🎉 All requested reservations confirmed');
            break;
          }
        }
      } catch (error) {
        console.error(`⚠️ Reservation check #${attempt} failed:`,
          error instanceof Error ? error.message : error);
        if (!MONITOR_ENABLED) throw error;
      }

      if (!MONITOR_ENABLED) {
        console.log('ℹ️ Single-check mode. Finished.');
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.log(`⏰ Monitoring window ended at ${MONITOR_END_TIME} Madrid time.`);
        break;
      }
      const wait = Math.min(RETRY_INTERVAL_MS, remaining);
      console.log(`⏳ Pending reservations. Retrying in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }

    // Do not report success for scheduled real bookings that remain pending.
    if (MONITOR_ENABLED && !allConfirmed) {
      throw new Error('Reservations still pending at the end of the monitoring window.');
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
