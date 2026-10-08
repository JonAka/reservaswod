import { existsSync, readFileSync, writeFileSync } from 'fs';
import { BookingState, ReservationResult, TerminalBookingStatus, WeekDay } from '../types';
import { availableDays, reservationsPreferences } from '../config';
const STATE_FILE = 'booking-state.json';
export function loadState(): BookingState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
export function saveState(state: BookingState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function pruneOldDates(state: BookingState): BookingState {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Object.fromEntries(Object.entries(state).filter(([date]) => new Date(date) >= today));
}
export function getUpcomingBookableDates(): string[] {
  const weekDayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dates: string[] = [];
  for (let i = 0; i < availableDays; i++) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + i);
    const weekDay = weekDayNames[d.getUTCDay()] as WeekDay;
    if (reservationsPreferences[weekDay]) dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}
export function allDatesCovered(state: BookingState, dates: string[]): boolean {
  return dates.length > 0 && dates.every(d => state[d] === 'booked');
}
export function terminalStatusFromResult(result: ReservationResult): TerminalBookingStatus | null {
  if (result.state === 'Borrar') return 'booked';
  if (result.state === 'Entrenar' && result.success) return 'booked';
  // Other states are not a confirmed reservation.
  return null;
}
export function updateState(current: BookingState, dayResults: Array<{ date?: string; result: ReservationResult }>): BookingState {
  const next = pruneOldDates(current);
  for (const { date, result } of dayResults) {
    if (!date) continue;
    const status = terminalStatusFromResult(result);
    if (status) next[date] = status;
  }
  return next;
}
