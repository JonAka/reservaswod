
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

const DRY_RUN =
  process.env.DRY_RUN !== 'false';

const MONITOR_ENABLED =
  process.env.MONITOR_OPENING === 'true' &&
  !DRY_RUN;

const sleep = (ms: number) =>
  new Promise<void>(resolve =>
    setTimeout(resolve, ms)
  );

function validateConfig(): void {
  const missing = [
    !email && 'EMAIL',
    !password && 'PASSWORD',
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}`
    );
  }

  if (
    !Object.values(
      reservationsPreferences
    ).some(Boolean)
  ) {
    throw new Error(
      'No reservation days configured'
    );
  }
}

function getMadridSecondsOfDay(): number {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }
  ).formatToParts(new Date());

  const get = (type: string) =>
    Number(
      parts.find(part => part.type === type)
        ?.value ?? '0'
    );

  return (
    get('hour') * 3600 +
    get('minute') * 60 +
    get('second')
  );
}

function monitoringDeadline(): number {
  const seconds = getMadridSecondsOfDay();

  const deadlineSeconds =
    14 * 3600;

  return (
    Date.now() +
    Math.max(
      0,
      deadlineSeconds - seconds
    ) * 1000
  );
}

async function main(): Promise<void> {
  validateConfig();

  let state = loadState();

  const upcomingDates =
    getUpcomingBookableDates();

  console.log(
    `📅 Target dates: ${upcomingDates.join(', ')}`
  );

  console.log(
    `🧪 Dry run: ${DRY_RUN}`
  );

  console.log(
    `🔁 Monitoring enabled: ${MONITOR_ENABLED}`
  );

  // El archivo de estado es una ayuda, no
  // una prueba definitiva de que la clase
  // correcta siga reservada. Por eso no
  // salimos aquí sin consultar WodBuster.
  if (
    !DRY_RUN &&
    allDatesCovered(state, upcomingDates)
  ) {
    console.log(
      'ℹ️ Cached bookings found. ' +
      'Verifying against WodBuster.'
    );
  }

  const browser = await launch({
    headless: isCI,
    slowMo: isCI ? 0 : 50,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const deadline = MONITOR_ENABLED
    ? monitoringDeadline()
    : Date.now();

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

    const loginUrl =
      `${baseUrl}/account/login.aspx`;

    if (isCI) {
      await solveCaptchaFlow(
        page,
        loginUrl
      );
    } else {
      await page.goto(loginUrl);
    }

    await login(
      page,
      email,
      password
    );

    let attempt = 0;

    while (true) {
      attempt++;

      console.log(
        `🔄 Reservation check #${attempt}`
      );

      try {
        await goToReservations(page);

        const dayResults =
          await processReservations(
            page,
            reservationsPreferences
          );

        if (!DRY_RUN) {
          // Actualizamos el estado únicamente
          // con reservas confirmadas.
          state = updateState(
            state,
            dayResults.map(
              ({ result }) => ({
                date: result.date,
                result,
              })
            )
          );

          saveState(state);

          // Comprobamos los resultados de esta
          // consulta, no solamente el archivo
          // de estado de ejecuciones anteriores.
          const confirmedDates = new Set(
            dayResults
              .filter(
                ({ result }) =>
                  result.success &&
                  (
                    result.state === 'Borrar' ||
                    result.state === 'Entrenar'
                  )
              )
              .map(
                ({ result }) => result.date
              )
              .filter(
                (date): date is string =>
                  Boolean(date)
              )
          );

          const allConfirmed =
            upcomingDates.length > 0 &&
            upcomingDates.every(
              date =>
                confirmedDates.has(date)
            );

          if (allConfirmed) {
            console.log(
              '🎉 All requested reservations confirmed'
            );

            break;
          }
        }
      } catch (error) {
        console.error(
          `⚠️ Reservation check #${attempt} failed:`,
          error instanceof Error
            ? error.message
            : error
        );

        // En modo manual o de prueba,
        // propagamos el fallo para que
        // GitHub Actions lo marque.
        if (!MONITOR_ENABLED) {
          throw error;
        }

        // En modo monitorización, seguimos
        // hasta la hora límite.
      }

      if (!MONITOR_ENABLED) {
        console.log(
          'ℹ️ Single-check mode. Finished.'
        );

        break;
      }

      const remaining =
        deadline - Date.now();

      if (remaining <= 0) {
        console.log(
          '⏰ Monitoring window ended at 14:00 Madrid time.'
        );

        break;
      }

      const wait = Math.min(
        RETRY_INTERVAL_MS,
        remaining
      );

      console.log(
        `⏳ Pending reservations. ` +
        `Retrying in ${Math.ceil(
          wait / 1000
        )}s`
      );

      await sleep(wait);
    }
  } catch (error) {
    console.error(
      'Error in the script:',
      error instanceof Error
        ? error.message
        : error
    );

    process.exitCode = 1;
  } finally {
    await browser.close();

    console.log(
      'Script finished'
    );
  }
}

main();
