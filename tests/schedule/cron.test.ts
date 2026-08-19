import { describe, it, expect } from 'vitest';
import { parseCron, matchesCron, nextRun, describeCron } from '../../src/schedule/cron';

/** Local time, because that is what a cron expression means to the person writing it. */
function at(text: string): Date {
  return new Date(text);
}

describe('parseCron', () => {
  it('accepts the five fields', () => {
    expect(() => parseCron('0 9 * * 1-5')).not.toThrow();
  });

  it.each([
    ['0 9 * *', 'four fields'],
    ['0 9 * * * *', 'six fields'],
    ['', 'nothing'],
    ['0 9 * * MON', 'a day name'],
    ['0 JAN * * *', 'a month name'],
    ['@daily', 'a macro'],
    ['@reboot', 'a macro'],
    ['60 * * * *', 'a minute out of range'],
    ['* 24 * * *', 'an hour out of range'],
    ['* * 32 * *', 'a day out of range'],
    ['* * 0 * *', 'day zero'],
    ['* * * 13 *', 'a month out of range'],
    ['* * * * 8', 'a weekday out of range'],
    ['*/0 * * * *', 'a zero step'],
    ['5-1 * * * *', 'a backwards range'],
    ['a * * * *', 'a letter'],
  ])('rejects %j — %s', (expression) => {
    expect(() => parseCron(expression)).toThrow();
  });

  it('accepts 7 as Sunday, which cron traditionally allows', () => {
    expect(matchesCron(parseCron('0 0 * * 7'), at('2026-08-23T00:00:00'))).toBe(true);
  });
});

describe('matchesCron', () => {
  it('matches every minute for all-stars', () => {
    expect(matchesCron(parseCron('* * * * *'), at('2026-08-18T13:47:00'))).toBe(true);
  });

  it('matches a weekday morning and not a weekend one', () => {
    const weekdays = parseCron('0 9 * * 1-5');
    expect(matchesCron(weekdays, at('2026-08-18T09:00:00'))).toBe(true); // Tuesday
    expect(matchesCron(weekdays, at('2026-08-22T09:00:00'))).toBe(false); // Saturday
  });

  it('ignores seconds, so a job fires once for the whole minute', () => {
    expect(matchesCron(parseCron('0 9 * * *'), at('2026-08-18T09:00:59'))).toBe(true);
  });

  it('honours a step', () => {
    const halfHourly = parseCron('*/30 * * * *');
    expect(matchesCron(halfHourly, at('2026-08-18T13:00:00'))).toBe(true);
    expect(matchesCron(halfHourly, at('2026-08-18T13:30:00'))).toBe(true);
    expect(matchesCron(halfHourly, at('2026-08-18T13:31:00'))).toBe(false);
  });

  it('honours a list', () => {
    const thrice = parseCron('0 8,12,18 * * *');
    expect(matchesCron(thrice, at('2026-08-18T12:00:00'))).toBe(true);
    expect(matchesCron(thrice, at('2026-08-18T13:00:00'))).toBe(false);
  });

  it('honours a stepped range', () => {
    const schedule = parseCron('0 9-17/4 * * *');
    expect(matchesCron(schedule, at('2026-08-18T09:00:00'))).toBe(true);
    expect(matchesCron(schedule, at('2026-08-18T13:00:00'))).toBe(true);
    expect(matchesCron(schedule, at('2026-08-18T17:00:00'))).toBe(true);
    expect(matchesCron(schedule, at('2026-08-18T10:00:00'))).toBe(false);
  });

  // The classic cron subtlety, and the one most likely to surprise someone.
  it('runs when EITHER day field matches, where both are restricted', () => {
    const schedule = parseCron('0 0 1 * 1');
    // The 1st of the month, which in this month is a Saturday.
    expect(matchesCron(schedule, at('2026-08-01T00:00:00'))).toBe(true);
    // A Monday that is not the 1st.
    expect(matchesCron(schedule, at('2026-08-03T00:00:00'))).toBe(true);
    // Neither.
    expect(matchesCron(schedule, at('2026-08-04T00:00:00'))).toBe(false);
  });

  it('requires both day fields to be satisfied only when one is unrestricted', () => {
    const schedule = parseCron('0 0 1 * *');
    expect(matchesCron(schedule, at('2026-08-01T00:00:00'))).toBe(true);
    expect(matchesCron(schedule, at('2026-08-03T00:00:00'))).toBe(false);
  });
});

describe('nextRun', () => {
  it('finds the next minute for an every-minute schedule', () => {
    const next = nextRun(parseCron('* * * * *'), at('2026-08-18T13:47:30'));
    expect(next).toEqual(at('2026-08-18T13:48:00'));
  });

  it('finds tomorrow morning when today has passed', () => {
    const next = nextRun(parseCron('0 9 * * *'), at('2026-08-18T10:00:00'));
    expect(next).toEqual(at('2026-08-19T09:00:00'));
  });

  it('skips the weekend for a weekday schedule', () => {
    const next = nextRun(parseCron('0 9 * * 1-5'), at('2026-08-21T10:00:00')); // Friday
    expect(next).toEqual(at('2026-08-24T09:00:00')); // Monday
  });

  it('crosses a month boundary', () => {
    const next = nextRun(parseCron('0 0 1 * *'), at('2026-08-18T00:00:00'));
    expect(next).toEqual(at('2026-09-01T00:00:00'));
  });

  it('never returns the instant it was given, so a job cannot fire twice', () => {
    const exact = at('2026-08-18T09:00:00');
    expect(nextRun(parseCron('0 9 * * *'), exact)!.getTime()).toBeGreaterThan(exact.getTime());
  });

  it('reports nothing for a schedule that can never happen', () => {
    // The 31st of February.
    expect(nextRun(parseCron('0 0 31 2 *'), at('2026-08-18T00:00:00'))).toBeNull();
  });
});

describe('describeCron', () => {
  it('reads back a common schedule in words', () => {
    expect(describeCron(parseCron('0 9 * * 1-5'))).toContain('09:00');
  });
});
