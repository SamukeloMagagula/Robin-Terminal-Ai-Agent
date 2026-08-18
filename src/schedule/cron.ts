/**
 * A deliberate subset of cron: five fields, numbers, `*`, ranges, lists and
 * steps. No month or day names, no `@daily`, no seconds field.
 *
 * Written here rather than taken from a package because parsing five integers
 * is not worth a dependency in a project that pins every version on purpose —
 * and because a subset that refuses what it does not understand is safer than
 * a full implementation quietly accepting something that means almost what you
 * meant. Everything unsupported throws with the reason.
 *
 * Times are local. A person writing `0 9 * * 1-5` means nine in their own
 * morning, and a scheduler that fired at nine UTC would be wrong for most of
 * the world.
 */

import { UserFacingError } from '../startup/bootstrap.js';

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /**
   * Whether each day field was given as `*`.
   *
   * Needed because cron's two day fields are OR-ed when both are restricted —
   * `0 0 1 * 1` means the 1st *or* any Monday — and AND-ed otherwise. Losing
   * that distinction would silently change what a schedule means.
   */
  everyDayOfMonth: boolean;
  everyDayOfWeek: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function fail(expression: string, reason: string): never {
  throw new UserFacingError(
    `Cannot read "${expression}" as a schedule — ${reason}.\n` +
      'Five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5".\n' +
      'Numbers, *, ranges (1-5), lists (1,3,5) and steps (*/30) only — no names, no @daily.'
  );
}

/** One field: a star, a number, a range, a list, or any of those with a step. */
function parseField(raw: string, spec: FieldSpec, expression: string): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (!part) fail(expression, `an empty ${spec.name}`);

    const [rangeText, stepText, ...extra] = part.split('/');
    if (extra.length > 0) fail(expression, `too many steps in the ${spec.name}`);

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) fail(expression, `a step that is not a number in the ${spec.name}`);
      step = Number(stepText);
      if (step === 0) fail(expression, `a step of zero in the ${spec.name}`);
    }

    let start: number;
    let end: number;
    if (rangeText === '*') {
      start = spec.min;
      end = spec.max;
    } else if (/^\d+$/.test(rangeText)) {
      start = Number(rangeText);
      end = stepText === undefined ? start : spec.max;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!match) fail(expression, `"${part}" is not a valid ${spec.name}`);
      start = Number(match[1]);
      end = Number(match[2]);
      if (start > end) fail(expression, `a backwards range in the ${spec.name}`);
    }

    if (start < spec.min || end > spec.max) {
      fail(expression, `a ${spec.name} outside ${spec.min}-${spec.max}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values;
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    fail(expression, `it has ${parts.length} field${parts.length === 1 ? '' : 's'} rather than 5`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
    parseField(part, FIELDS[index], expression)
  );

  // Cron traditionally accepts both 0 and 7 for Sunday.
  if (dayOfWeek.has(7)) dayOfWeek.add(0);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    everyDayOfMonth: parts[2] === '*',
    everyDayOfWeek: parts[4] === '*',
  };
}

/** Whether the date's day satisfies the schedule, with cron's OR rule. */
function dayMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.month.has(date.getMonth() + 1)) return false;

  const byMonth = schedule.dayOfMonth.has(date.getDate());
  const byWeek = schedule.dayOfWeek.has(date.getDay());

  // Both restricted: either satisfies. Otherwise the restricted one decides.
  if (!schedule.everyDayOfMonth && !schedule.everyDayOfWeek) return byMonth || byWeek;
  if (!schedule.everyDayOfMonth) return byMonth;
  if (!schedule.everyDayOfWeek) return byWeek;
  return true;
}

/** Seconds are ignored: a schedule names a minute, and fires once within it. */
export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minute.has(date.getMinutes()) && schedule.hour.has(date.getHours()) && dayMatches(schedule, date)
  );
}

/**
 * Four years, so a 29 February schedule is still found. Whole days and hours
 * are skipped rather than every minute being tested, which keeps even that
 * search small.
 */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * 60 * 1000;

/**
 * The first minute strictly after `after` that the schedule names.
 *
 * Strictly after, so a job that has just fired cannot immediately fire again.
 * Null when the schedule can never happen — 31 February is expressible, and
 * saying so is better than searching forever.
 */
export function nextRun(schedule: CronSchedule, after: Date): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const deadline = after.getTime() + SEARCH_LIMIT_MS;

  while (cursor.getTime() <= deadline) {
    if (!dayMatches(schedule, cursor)) {
      // Nothing this day can match; jump to the next midnight.
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }

  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A plain-language reading, for `robin schedule list`.
 *
 * Deliberately approximate: it covers the shapes people actually write and
 * falls back to naming the times for anything else. A wrong-but-confident
 * description of a schedule is worse than a terse one.
 */
export function describeCron(schedule: CronSchedule): string {
  const hours = [...schedule.hour].sort((a, b) => a - b);
  const minutes = [...schedule.minute].sort((a, b) => a - b);

  const times =
    hours.length * minutes.length <= 6
      ? hours.flatMap((hour) => minutes.map((minute) => `${pad(hour)}:${pad(minute)}`)).join(', ')
      : `${minutes.length * hours.length} times a day`;

  const days = schedule.everyDayOfWeek
    ? ''
    : ` on ${[...schedule.dayOfWeek]
        .filter((day) => day < 7)
        .sort((a, b) => a - b)
        .map((day) => DAY_NAMES[day])
        .join(', ')}`;

  const monthDays = schedule.everyDayOfMonth
    ? ''
    : ` on day ${[...schedule.dayOfMonth].sort((a, b) => a - b).join(', ')} of the month`;

  return `${times}${days}${monthDays}`.trim();
}
