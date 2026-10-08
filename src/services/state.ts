
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';

import {
  BookingState,
  ReservationResult,
  TerminalBookingStatus,
  WeekDay,
} from '../types';

import {
  availableDays,
  reservationsPreferences,
} from '../config';

const STATE_FILE = 'booking-state.json';

const WEEK_DAYS: WeekDay[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function loadState(): BookingState {
  if (!existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(
      readFileSync(STATE_FILE, 'utf-8')
    ) as BookingState;
  } catch {
    console.warn(
      '⚠️ Could not read booking state. Starting fresh.'
    );
    return {};
  }
}

export function saveState(state: BookingState): void {
  writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

function pruneOldDates(
  state: BookingState
): BookingState {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return Object.fromEntries(
    Object.entries(state).filter(([date]) => {
      const parsed = new Date(`${date}T00:00:00Z`);

      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed >= today
      );
    })
  ) as BookingState;
}

export function getUpcomingBookableDates(): string[] {
  const dates: string[] = [];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < availableDays; i++) {
    const date = new Date(today);

    date.setUTCDate(date.getUTCDate() + i);

    const weekDay = WEEK_DAYS[
      date.getUTCDay()
    ];

    if (!reservationsPreferences[weekDay]) {
      continue;
    }

    dates.push(
      date.toISOString().split('T')[0]
    );
  }

  return dates;
}

// Solo una reserva confirmada se considera
// completada. La lista de espera no equivale
// a tener plaza.
export function allDatesCovered(
  state: BookingState,
  dates: string[]
): boolean {
  return (
    dates.length > 0 &&
    dates.every(date => state[date] === 'booked')
  );
}

export function terminalStatusFromResult(
  result: ReservationResult
): TerminalBookingStatus | null {
  // "Borrar" significa que la reserva ya existe.
  if (result.state === 'Borrar') {
    return 'booked';
  }

  // El botón "Reservar" se representa internamente
  // como "Entrenar". Solo cuenta si el sistema
  // confirmó la reserva después del clic.
  if (
    result.state === 'Entrenar' &&
    result.success
  ) {
    return 'booked';
  }

  // No marcamos las listas de espera ni otros
  // estados como reservas completadas.
  return null;
}

export function updateState(
  current: BookingState,
  dayResults: Array<{
    date?: string;
    result: ReservationResult;
  }>
): BookingState {
  const next = pruneOldDates(current);

  for (const { date, result } of dayResults) {
    if (!date) continue;

    const status = terminalStatusFromResult(
      result
    );

    if (status === 'booked') {
      next[date] = 'booked';
    }
  }

  return next;
}
