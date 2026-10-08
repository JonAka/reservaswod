
import { appendFileSync } from 'fs';
import { Page, ElementHandle } from 'puppeteer';
import {
  ButtonText,
  ReservationPreferences,
  ReservationResult,
  WeekDay,
} from '../types';
import { availableDays } from '../config';

// IMPORTANTE: true = no pulsa Reservar
const DRY_RUN = false;

const RESERVATIONS_URL =
  'https://tubox.wodbuster.com/athlete/reservas.aspx';

export function parsePreferenceValue(value: string | null): {
  time: string | null;
  className: string | null;
} {
  if (!value) return { time: null, className: null };

  const [time, className] = value.split('|');

  return {
    time: time?.trim() || null,
    className: className?.trim() || null,
  };
}

function getTimestampFromUrl(page: Page): number {
  const url = new URL(page.url());
  const raw = url.searchParams.get('t');

  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`Invalid reservation URL: ${page.url()}`);
  }

  const timestamp = Number(raw);

  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }

  return timestamp;
}

export async function goToReservations(
  page: Page
): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const timestamp = Math.floor(today.getTime() / 1000);
  const url = `${RESERVATIONS_URL}?t=${timestamp}`;

  console.log(`🏋️ Going to reservations: ${url}`);

  await page.goto(url, { waitUntil: 'networkidle2' });

  console.log(`🌐 Current URL: ${page.url()}`);

  if (page.url().includes('aspxerrorpath')) {
    throw new Error(`WodBuster navigation failed: ${page.url()}`);
  }

  await page.waitForSelector('#calendar', {
    timeout: 15000,
  });
}

export async function getReservationState(
  reservationButton: ElementHandle<Element>
): Promise<ButtonText | null> {
  const text = await reservationButton.evaluate(
    el => el.textContent?.trim() ?? ''
  );

  // Tu Box utiliza "Reservar" donde AutoWOD
  // esperaba "Entrenar".
  if (text.toLowerCase() === 'reservar') {
    return 'Entrenar' as ButtonText;
  }

  return text ? (text as ButtonText) : null;
}

export function getReservationKey(time: string): string {
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid reservation time: ${time}`);
  }

  return `h${time.replace(':', '')}00`;
}

export async function goToNextDay(
  page: Page
): Promise<void> {
  const timestamp = getTimestampFromUrl(page);
  const date = new Date(timestamp * 1000);

  date.setUTCDate(date.getUTCDate() + 1);

  const nextTimestamp = Math.floor(date.getTime() / 1000);
  const url = `${RESERVATIONS_URL}?t=${nextTimestamp}`;

  console.log(`➡️ Moving to next day: ${url}`);

  await page.goto(url, { waitUntil: 'networkidle2' });

  if (page.url().includes('aspxerrorpath')) {
    throw new Error(`WodBuster navigation failed: ${page.url()}`);
  }

  await page.waitForSelector('#calendar', {
    timeout: 15000,
  });
}

export async function getWeekDayFromUrl(
  page: Page
): Promise<string> {
  const timestamp = getTimestampFromUrl(page);

  return new Date(timestamp * 1000)
    .toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    })
    .toLowerCase();
}

export async function getDateFromUrl(
  page: Page
): Promise<string> {
  const timestamp = getTimestampFromUrl(page);

  return new Date(timestamp * 1000).toLocaleDateString(
    'en-US',
    {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }
  );
}

export function getISODateFromUrl(page: Page): string {
  const timestamp = getTimestampFromUrl(page);

  return new Date(timestamp * 1000)
    .toISOString()
    .split('T')[0];
}

function normalizeClassName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function findReservationButton(
  page: Page,
  reservationKey: string,
  className: string | null
): Promise<ElementHandle<Element> | null> {
  const match = /^h(\d{2})(\d{2})\d{2}$/.exec(
    reservationKey
  );

  if (!match) {
    throw new Error(`Invalid reservation key: ${reservationKey}`);
  }

  if (!className) {
    console.log('⚠️ Class name is required');
    return null;
  }

  const targetTime = `${match[1]}:${match[2]}`;

  await page.waitForSelector('#calendar .zonareservas', {
    timeout: 15000,
  });

  const classes = await page.$$('#calendar .zonareservas div.clase');

  console.log(`🔎 Classes found: ${classes.length}`);
  console.log(`🎯 Searching ${targetTime} → ${className}`);

  const matches: ElementHandle<Element>[] = [];

  for (const classElement of classes) {
    const info = await classElement.evaluate(el => ({
      id: el.id,
      name:
        el.querySelector(
          '.entrenamientoHead .entrenamiento'
        )?.textContent?.trim() ?? '',
      time:
        el.querySelector(
          '.entrenamientoHead .hora'
        )?.textContent?.trim() ?? '',
    }));

    console.log(
      `📋 ${info.time} → ${info.name} (${info.id})`
    );

    if (
      info.time === targetTime &&
      normalizeClassName(info.name) ===
        normalizeClassName(className)
    ) {
      matches.push(classElement);
    }
  }

  if (matches.length !== 1) {
    console.log(
      `⚠️ Expected exactly one matching class, found ${matches.length}`
    );
    return null;
  }

  const selectedClass = matches[0];

  const button = await selectedClass.$(
    '.actionsjs button.button.entrenar'
  );

  if (!button) {
    console.log(
      '⚠️ Matching class found, but no Reservar button'
    );
    return null;
  }

  const buttonText = await button.evaluate(
    el => el.textContent?.trim() ?? ''
  );

  console.log(`🔘 Button: ${buttonText}`);

  if (buttonText.toLowerCase() !== 'reservar') {
    console.log('⚠️ Button is not in Reservar state');
    return null;
  }

  console.log('✅ Correct reservation button identified');

  return button;
}


export async function makeReservation(
  page: Page,
  preference: string | null
): Promise<ReservationResult> {
  const { time, className } = parsePreferenceValue(preference);

  const weekDay = await getWeekDayFromUrl(page);
  const date = getISODateFromUrl(page);

  // 1. Comprobar si hay una clase configurada
  if (!time) {
    return {
      success: false,
      message: `📅 No time scheduled for ${weekDay}s`,
      weekDay,
      date,
    };
  }

  if (!className) {
    return {
      success: false,
      message: `⚠️ No class name configured for ${weekDay}`,
      weekDay,
      date,
      time,
    };
  }

  console.log(
    `🎯 Searching ${weekDay} ${date} → ${time} → ${className}`
  );

  // 2. Buscar la clase exacta
  const reservationKey = getReservationKey(time);

  const reservationButton = await findReservationButton(
    page,
    reservationKey,
    className
  );

  if (!reservationButton) {
    return {
      success: false,
      message:
        `🔍 No available reservation button found for ` +
        `${date} at ${time} (${className})`,
      weekDay,
      date,
      time,
    };
  }

  // 3. Comprobar el estado del botón
  const state = await getReservationState(reservationButton);

  if (!state) {
    return {
      success: false,
      message: '⚠️ Unable to determine booking state',
      weekDay,
      date,
      time,
    };
  }

  const result: ReservationResult = {
    success: false,
    message: '',
    weekDay,
    date,
    time,
    state,
  };

  // 4. Modo de prueba: no pulsar ningún botón
  if (DRY_RUN) {
    result.message =
      `🧪 DRY RUN: ${date} ${time} ${className} ` +
      '→ button found, NO CLICK performed';

    console.log(result.message);
    return result;
  }

  // 5. Reserva real
  switch (state) {
    case 'Entrenar': {
      // Identificar el contenedor de la clase correcta
      const classId = await reservationButton.evaluate(
        el => el.closest('.clase')?.id ?? ''
      );

      if (!classId) {
        throw new Error(
          '❌ Could not identify the selected class'
        );
      }

      console.log(`🎯 Booking class: ${classId}`);

      // Pulsar el botón Reservar
      await reservationButton.click();

      console.log('🖱️ Reservar button clicked');

      // Esperar a que WodBuster confirme la reserva
      try {
        await page.waitForFunction(
          (id: string) => {
            const container = document.getElementById(id);

            if (!container) return false;

            const buttons = Array.from(
              container.querySelectorAll(
                '.actionsjs button'
              )
            );

            return buttons.some(
              button =>
                button.textContent
                  ?.trim()
                  .toLowerCase() === 'borrar'
            );
          },
          {
            timeout: 10000,
            polling: 250,
          },
          classId
        );

        result.success = true;
        result.message =
          `✅ Booking confirmed: ` +
          `${date} ${time} ${className}`;

      } catch {
        result.success = false;
        result.message =
          `⚠️ Booking clicked but not confirmed: ` +
          `${date} ${time} ${className}`;
      }

      break;
    }

    case 'Avisar':
      result.message =
        '⚠️ Waiting list detected; no automatic click';
      break;

    case 'Borrar':
      result.message = 'ℹ️ Already booked';
      break;

    case 'Cambiar':
      result.message =
        '⚠️ Already booked at another time';
      break;

    case 'Finalizada':
      result.message = '❌ Class already finished';
      break;

    default:
      result.message =
        `⚠️ Unrecognized booking state: ${state}`;
  }

  console.log(result.message);

  return result;
}


function writeJobSummary(
  dayResults: Array<{
    weekDay: string;
    result: ReservationResult;
  }>,
  counts: {
    booked: number;
    waitlisted: number;
    alreadyBooked: number;
    skipped: number;
    other: number;
  }
): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile) return;

  const rows = dayResults.map(({ weekDay, result }) => {
    const day =
      weekDay.charAt(0).toUpperCase() +
      weekDay.slice(1);

    let status = result.message;

    if (!result.time) {
      status = 'Skipped';
    } else if (DRY_RUN && result.state === 'Entrenar') {
      status = 'Dry run - button identified';
    } else if (result.success) {
      status = 'Booked';
    }

    return `| ${day} | ${result.time ?? '—'} | ${status.replace(/\|/g, '/')} |`;
  });

  const lines = [
    '## AutoWOD Results',
    '',
    `Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`,
    '',
    '| Day | Time | Status |',
    '|---|---|---|',
    ...rows,
    '',
    `Booked: ${counts.booked}`,
    `Waitlisted: ${counts.waitlisted}`,
    `Already booked: ${counts.alreadyBooked}`,
    `Skipped: ${counts.skipped}`,
    `Other: ${counts.other}`,
    '',
  ];

  appendFileSync(summaryFile, lines.join('\n'));
}

export async function processReservations(
  page: Page,
  preferences: ReservationPreferences
): Promise<
  Array<{ weekDay: string; result: ReservationResult }>
> {
  const dayResults: Array<{
    weekDay: string;
    result: ReservationResult;
  }> = [];

  let booked = 0;
  let waitlisted = 0;
  let alreadyBooked = 0;
  let skipped = 0;
  let other = 0;

  for (let i = 0; i < availableDays; i++) {
    const weekDay = await getWeekDayFromUrl(page);

    const preference =
      preferences[weekDay as WeekDay];

    const result = await makeReservation(
      page,
      preference
    );

    dayResults.push({ weekDay, result });
    console.log(result.message);

    if (!preference) {
      skipped++;
    } else if (result.success && result.state === 'Entrenar') {
      booked++;
    } else if (result.success && result.state === 'Avisar') {
      waitlisted++;
    } else if (result.state === 'Borrar') {
      alreadyBooked++;
    } else {
      other++;
    }

    if (i === availableDays - 1) break;

    const dateBefore = getISODateFromUrl(page);

    await goToNextDay(page);

    if (getISODateFromUrl(page) === dateBefore) {
      console.log('📆 Calendar did not advance');
      break;
    }
  }

  console.log(
    `📊 Summary -> booked: ${booked}, ` +
    `waitlist: ${waitlisted}, ` +
    `already booked: ${alreadyBooked}, ` +
    `skipped: ${skipped}, other: ${other}`
  );

  writeJobSummary(dayResults, {
    booked,
    waitlisted,
    alreadyBooked,
    skipped,
    other,
  });

  return dayResults;
}
