import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots } from './calendar-booking.js';

const availability = {
  days: [1], startTime: '09:00', endTime: '10:00', durationMinutes: 30,
  bufferMinutes: 0, leadHours: 1, horizonDays: 7,
  timeZone: 'America/Chicago', timeZoneLabel: 'Central Time (CT)'
};

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

test('slots do not cross a daylight saving time jump', () => {
  const slots = generateSlots({ ...availability, days: [0], startTime: '01:00', endTime: '04:00' },
    [], Date.parse('2026-03-08T00:00:00Z'));
  assert.ok(slots.includes('2026-03-08T07:00:00.000Z'));
  assert.ok(!slots.includes('2026-03-08T07:30:00.000Z'));
  assert.ok(slots.includes('2026-03-08T08:00:00.000Z'));
});
