import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots, validBlockRange } from './calendar-booking.js';

const availability = {
  days: [1], startTime: '09:00', endTime: '10:00', durationMinutes: 30,
  bufferMinutes: 0, leadHours: 1, horizonDays: 7,
  timeZone: 'America/Chicago', timeZoneLabel: 'Central Time (CT)'
};

test('a single block accepts the reported multi-day range and a full week', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  const start = Date.parse('2026-10-29T13:00:00Z');
  const end = Date.parse('2026-10-31T05:00:00Z');
  assert.equal(validBlockRange(start, end, now), true);
  assert.equal(validBlockRange(start, start + 7 * 24 * 60 * 60 * 1000, now), true);
  assert.equal(validBlockRange(start, start + 91 * 24 * 60 * 60 * 1000, now), false);
  const minuteStart = Date.parse('2026-10-27T20:42:00Z');
  const minuteEnd = Date.parse('2026-10-30T20:42:00Z');
  assert.equal(validBlockRange(minuteStart, minuteEnd, now), true);
  assert.equal(validBlockRange(minuteStart + 30_000, minuteEnd, now), false);
});

test('slots follow the admin time zone after daylight saving time ends', () => {
  const slots = generateSlots(availability, [], Date.parse('2026-11-02T00:00:00Z'));
  assert.equal(slots[0], '2026-11-02T15:00:00.000Z');
  assert.equal(slots.at(-1), '2026-11-02T15:30:00.000Z');
});

test('busy events and interview buffers remove conflicting starts', () => {
  const slots = generateSlots({ ...availability, endTime: '11:00', bufferMinutes: 15 }, [
    { start: '2026-11-02T15:00:00Z', end: '2026-11-02T15:30:00Z' }
  ], Date.parse('2026-11-02T00:00:00Z'));
  assert.equal(slots[0], '2026-11-02T15:45:00.000Z');
});

test('one continuous week block hides slots across several days', () => {
  const openDays = { ...availability, days: [1, 2, 3, 4, 5], horizonDays: 14 };
  const now = Date.parse('2026-11-02T00:00:00Z');
  const week = [{ start: '2026-11-02T00:00:00Z', end: '2026-11-09T00:00:00Z' }];
  const slots = generateSlots(openDays, week, now);
  assert.ok(slots.length > 0);
  assert.ok(slots.every(slot => Date.parse(slot) >= Date.parse(week[0].end)));
});

test('slots do not cross a daylight saving time jump', () => {
  const slots = generateSlots({ ...availability, days: [0], startTime: '01:00', endTime: '04:00' },
    [], Date.parse('2026-03-08T00:00:00Z'));
  assert.ok(slots.includes('2026-03-08T07:00:00.000Z'));
  assert.ok(!slots.includes('2026-03-08T07:30:00.000Z'));
  assert.ok(slots.includes('2026-03-08T08:00:00.000Z'));
});
