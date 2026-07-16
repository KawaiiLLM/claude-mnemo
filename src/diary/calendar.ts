const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: string): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new Error(`Missing ${type} calendar part`);
  return Number.parseInt(value, 10);
}

function assertCalendarDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
}

export function calendarDateAt(epochSeconds: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(epochSeconds * 1_000);
  const year = String(partNumber(parts, "year")).padStart(4, "0");
  const month = String(partNumber(parts, "month")).padStart(2, "0");
  const day = String(partNumber(parts, "day")).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The content-day a moment belongs to, using a local day boundary of
 * `boundaryHour` instead of midnight. Shifting the epoch back by the boundary
 * makes any moment before that hour resolve to the previous calendar date, so
 * late-night work rolls into the day it belongs to. Exact for non-DST zones
 * (the default Asia/Shanghai); a DST transition can shift by an hour.
 */
export function contentDateAt(
  epochSeconds: number,
  timeZone: string,
  boundaryHour: number,
): string {
  return calendarDateAt(epochSeconds - boundaryHour * 3_600, timeZone);
}

export function addCalendarDays(date: string, days: number): string {
  assertCalendarDate(date);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarDayStartEpoch(date: string, timeZone: string): number {
  assertCalendarDate(date);
  const utcMidnight = Date.parse(`${date}T00:00:00Z`) / 1_000;
  let low = utcMidnight - 2 * 86_400;
  let high = utcMidnight + 2 * 86_400;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (calendarDateAt(middle, timeZone) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (calendarDateAt(low, timeZone) !== date) {
    throw new Error(`Calendar date does not exist in ${timeZone}: ${date}`);
  }
  return low;
}

export function calendarDayBounds(
  date: string,
  timeZone: string,
  boundaryHour = 0,
): { startEpoch: number; endEpoch: number } {
  // The content-day spans [date boundaryHour:00, date+1 boundaryHour:00). With
  // the default boundaryHour of 0 this is the plain midnight-to-midnight day.
  const shift = boundaryHour * 3_600;
  return {
    startEpoch: calendarDayStartEpoch(date, timeZone) + shift,
    endEpoch: calendarDayStartEpoch(addCalendarDays(date, 1), timeZone) + shift,
  };
}

export function dreamTriggerWindow(input: {
  nowEpoch: number;
  timeZone: string;
  triggerHour: number;
}): {
  today: string;
  yesterday: string;
  hasPassedTrigger: boolean;
} {
  const today = calendarDateAt(input.nowEpoch, input.timeZone);
  const parts = timeFormatter(input.timeZone).formatToParts(
    input.nowEpoch * 1_000,
  );
  const hour = partNumber(parts, "hour");
  return {
    today,
    yesterday: addCalendarDays(today, -1),
    hasPassedTrigger: hour >= input.triggerHour,
  };
}
