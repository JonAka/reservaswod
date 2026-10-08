import { ReservationPreferences } from './types';
export const baseUrl = 'https://wodbuster.com';
export const email = process.env.EMAIL ?? '';
export const password = process.env.PASSWORD ?? '';
export const twoCaptchaApiKey = process.env.TWO_CAPTCHA_API_KEY ?? '';
export const isCI = process.env.CI === 'true';
export const reservationsPreferences: ReservationPreferences = {
  monday: process.env.MONDAY || null,
  tuesday: process.env.TUESDAY || null,
  wednesday: process.env.WEDNESDAY || null,
  thursday: process.env.THURSDAY || null,
  friday: process.env.FRIDAY || null,
  saturday: process.env.SATURDAY || null,
  sunday: process.env.SUNDAY || null,
};
export const availableDays = Number(process.env.AVAILABLE_DAYS || 7);
