export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}
export function monthCells(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), 1 - mondayOffset + i, 12));
}
export function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12);
}
export function eventsOn(events, day) {
  return events.filter(event => event.event_date === day).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '') || a.title.localeCompare(b.title));
}
export function visibleTasks(tasks, filter, today) {
  return tasks.filter(task => filter === 'done' ? task.completed : filter === 'upcoming' ? !task.completed && task.due_date && task.due_date >= today : !task.completed)
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.created_at.localeCompare(b.created_at));
}
export function cleanTitle(value) {
  const result = value.trim();
  if (!result || result.length > 160) throw new Error('Please enter a title of 1–160 characters.');
  return result;
}
