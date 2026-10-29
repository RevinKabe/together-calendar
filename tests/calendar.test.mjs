import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, parseDate, monthCells, shiftMonth, eventsOn, visibleTasks, cleanTitle } from '../site/calendar.js';
test('calendar is Monday-first and includes 42 consecutive local dates', () => {
  for (const month of [new Date(2026, 9, 1), new Date(2027, 0, 1), new Date(2028, 1, 1)]) {
    const cells = monthCells(month);
    assert.equal(cells.length, 42); assert.equal(cells[0].getDay(), 1);
    assert.equal(new Set(cells.map(dateKey)).size, 42);
    assert.ok(cells.some(date => dateKey(date) === dateKey(month)));
    assert.equal(cells[41].getDay(), 0);
  }
});
test('month navigation survives January 31, leap years and year boundaries', () => {
  assert.equal(dateKey(shiftMonth(new Date(2026, 0, 31), 1)), '2026-02-01');
  assert.equal(dateKey(shiftMonth(new Date(2026, 11, 31), 1)), '2027-01-01');
  assert.equal(dateKey(shiftMonth(new Date(2026, 0, 1), -1)), '2025-12-01');
  assert.equal(dateKey(parseDate('2028-02-29')), '2028-02-29');
});
test('date-only values remain local across European daylight-saving dates', () => {
  for (const value of ['2026-03-29', '2026-10-25', '2026-12-31']) assert.equal(dateKey(parseDate(value)), value);
});
test('selected day sorts all-day plans before timed plans without mutating input', () => {
  const items = [{ title: 'Later', event_date: '2026-10-29', start_time: '15:00' }, { title: 'All day', event_date: '2026-10-29', start_time: null }, { title: 'Other', event_date: '2026-10-30', start_time: '09:00' }];
  assert.deepEqual(eventsOn(items, '2026-10-29').map(item => item.title), ['All day', 'Later']);
  assert.equal(items[0].title, 'Later');
});
test('task views separate completed, overdue, upcoming and undated tasks', () => {
  const items = [
    { title: 'No date', completed: false, due_date: null, created_at: '2026-10-01' },
    { title: 'Today', completed: false, due_date: '2026-10-29', created_at: '2026-10-01' },
    { title: 'Overdue', completed: false, due_date: '2026-10-20', created_at: '2026-10-01' },
    { title: 'Done', completed: true, due_date: '2026-10-30', created_at: '2026-10-01' }
  ];
  assert.deepEqual(visibleTasks(items, 'open', '2026-10-29').map(item => item.title), ['Overdue', 'Today', 'No date']);
  assert.deepEqual(visibleTasks(items, 'upcoming', '2026-10-29').map(item => item.title), ['Today']);
  assert.deepEqual(visibleTasks(items, 'done', '2026-10-29').map(item => item.title), ['Done']);
});
test('blank and oversized titles are rejected', () => {
  assert.throws(() => cleanTitle('  ')); assert.throws(() => cleanTitle('a'.repeat(161)));
  assert.equal(cleanTitle('  Our plan  '), 'Our plan');
});
