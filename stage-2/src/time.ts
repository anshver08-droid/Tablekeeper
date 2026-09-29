import { Temporal } from '@js-temporal/polyfill';

export class LocalTimeError extends Error {
  constructor(public readonly code: 'invalid_local_time' | 'nonexistent_local_time' | 'ambiguous_local_time', message: string) {
    super(message);
  }
}

export function resolveLocalTime(local: string, zone: string): Temporal.Instant {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) {
    throw new LocalTimeError('invalid_local_time', 'Expected a local date-time without an offset.');
  }
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(local, { overflow: 'reject' });
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw new LocalTimeError('invalid_local_time', 'Invalid local date-time or restaurant timezone.');
  }
  const earlier = plain.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = plain.toZonedDateTime(zone, { disambiguation: 'later' });
  if (!earlier.toPlainDateTime().equals(plain) || !later.toPlainDateTime().equals(plain)) {
    throw new LocalTimeError('nonexistent_local_time', 'This local time does not exist because of a timezone transition.');
  }
  if (!earlier.toInstant().equals(later.toInstant())) {
    throw new LocalTimeError('ambiguous_local_time', 'This local time occurs twice because of a timezone transition.');
  }
  return earlier.toInstant();
}

export function formatInZone(instant: Temporal.Instant | string | Date, zone: string): string {
  const value = instant instanceof Date ? instant.toISOString() : typeof instant === 'string' ? instant : instant.toString();
  return Temporal.Instant.from(value).toZonedDateTimeISO(zone).toString({ calendarName: 'never', timeZoneName: 'never' });
}

export function resolveDateAndTime(date: string, time: string, zone: string): Temporal.Instant {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new LocalTimeError('invalid_local_time', 'Expected date YYYY-MM-DD and time HH:mm.');
  }
  return resolveLocalTime(`${date}T${time}`, zone);
}
