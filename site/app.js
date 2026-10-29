import { dateKey, parseDate, monthCells, shiftMonth, eventsOn, visibleTasks, cleanTitle } from './calendar.js';

const $ = (id) => document.getElementById(id);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  'check-square': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5M21 12H9"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>'
};
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[el.dataset.icon]}</svg>`; });
const categoryNames = { sage: 'Everyday', lavender: 'Work', peach: 'Personal' };
const safeCategory = (value) => Object.hasOwn(categoryNames, value) ? value : 'sage';
const storage = {
  get(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  set(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch { toast('Browser storage is unavailable. Changes may not survive a reload.'); } },
  remove(key, session = false) { try { (session ? sessionStorage : localStorage).removeItem(key); } catch { /* Storage may be disabled. */ } }
};
const config = window.TOGETHER_CONFIG || {};
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') && Boolean(config.supabasePublishableKey);
const client = configured && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey) : null;
let demo = false, user = null, workspaces = [], workspace = null, events = [], tasks = [], members = [];
let month = new Date(), selectedDate = null, taskFilter = 'open', authMode = 'signin', editing = null, generation = 0, poll = null, toastTimeout;
let recovery = new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
const initialUrl = new URL(location.href);
if (initialUrl.searchParams.has('invite')) {
  const token = initialUrl.searchParams.get('invite');
  if (/^[a-f0-9]{64}$/.test(token)) storage.set('together-invite', token, true);
  initialUrl.searchParams.delete('invite');
  history.replaceState(null, '', initialUrl.pathname + initialUrl.search + initialUrl.hash);
}

function toast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function errorMessage(error) { return error?.message || 'Something went wrong. Please try again.'; }
async function busy(button, operation, statusId) {
  if (button.disabled) return;
  button.disabled = true;
  if (statusId) $(statusId).textContent = '';
  try { await operation(); } catch (error) {
    if (statusId) $(statusId).textContent = errorMessage(error); else toast(errorMessage(error));
  } finally { button.disabled = false; }
}
function result(response) { if (response.error) throw response.error; return response.data; }
function displayName() { return user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'You'; }
function initials(name) { return String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'; }
function fullDate(value) { return parseDate(value).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }); }
function dateLabel(value) {
  if (!value) return '';
  const today = dateKey(new Date());
  if (value === today) return 'Today';
  return parseDate(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function baseUrl() { return new URL('./', location.href).href; }
function setAuthMode(mode) {
  authMode = mode;
  $('name-label').hidden = mode !== 'signup';
  $('auth-name').required = mode === 'signup';
  $('password-label').hidden = mode === 'reset';
  $('auth-password').required = mode !== 'reset';
  $('auth-password').autocomplete = ['signup', 'recovery'].includes(mode) ? 'new-password' : 'current-password';
  $('auth-email').closest('label').hidden = mode === 'recovery';
  $('auth-email').required = mode !== 'recovery';
  $('auth-heading').textContent = { signin: 'Welcome to your everyday.', signup: 'Make room for your people.', reset: 'Let’s get you back in.', recovery: 'A fresh start.' }[mode];
  $('auth-description').textContent = { signin: 'Sign in and pick up where life left off.', signup: 'Create an account, then a space to share.', reset: 'We’ll email you a password reset link.', recovery: 'Choose a new password of at least 10 characters.' }[mode];
  $('auth-submit').textContent = { signin: 'Sign in ↗', signup: 'Create account ↗', reset: 'Send reset link ↗', recovery: 'Save new password ↗' }[mode];
  $('auth-toggle').textContent = mode === 'signin' ? 'Create an account' : 'Back to sign in';
  $('forgot-password').hidden = mode !== 'signin';
  $('auth-status').textContent = '';
}
function authView() {
  generation++;
  clearInterval(poll);
  demo = false; user = null; workspace = null; workspaces = []; events = []; tasks = []; members = [];
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('app-view').hidden = true; $('auth-view').hidden = false;
  $('auth-password').value = '';
  setAuthMode('signin');
}
async function enterSession(session) {
  if (!session?.user) { authView(); return; }
  if (user?.id === session.user.id && !demo && !$('app-view').hidden) return;
  demo = false; user = session.user;
  $('auth-view').hidden = true; $('app-view').hidden = false; $('demo-banner').hidden = true;
  $('user-name').textContent = displayName(); $('user-avatar').textContent = initials(displayName());
  $('user-mode').textContent = 'Sign out'; $('account-button').ariaLabel = `Sign out ${displayName()}`;
  $('new-workspace').hidden = false;
  try { await loadWorkspaces(); } catch (error) { toast(errorMessage(error)); }
  clearInterval(poll);
  poll = setInterval(() => { if (!document.hidden && workspace && !demo) refresh().catch(() => { $('sync-status').textContent = 'Sync paused · retrying'; }); }, 15000);
  if (storage.get('together-invite', true)) $('join-dialog').showModal();
}
async function loadWorkspaces(preferredId) {
  const expectedUser = user?.id;
  const data = result(await client.from('workspaces').select('*').order('created_at'));
  if (user?.id !== expectedUser || demo) return;
  workspaces = data;
  $('workspace-select').innerHTML = workspaces.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('') || '<option value="">Choose a space</option>';
  workspace = workspaces.find(item => item.id === preferredId) || workspaces.find(item => item.id === workspace?.id) || workspaces[0] || null;
  if (workspace) { $('workspace-select').value = workspace.id; await refresh(); }
  else { events = []; tasks = []; members = []; render(); if (!storage.get('together-invite', true)) $('workspace-dialog').showModal(); }
}
async function refresh() {
  if (!workspace) return;
  const id = workspace.id, ticket = ++generation;
  const [eventData, taskData, memberData] = await Promise.all([
    client.from('events').select('*').eq('workspace_id', id).order('event_date'),
    client.from('tasks').select('*').eq('workspace_id', id).order('created_at'),
    client.from('workspace_members').select('user_id,display_name').eq('workspace_id', id)
  ]);
  if (ticket !== generation || workspace?.id !== id || demo) return;
  events = result(eventData); tasks = result(taskData); members = result(memberData);
  // Losing membership must clear already displayed data, even while the page stays open.
  if (!members.some(member => member.user_id === user?.id)) { workspace = null; await loadWorkspaces(); return; }
  $('sync-status').textContent = 'Up to date';
  render();
}
function sampleData() {
  const now = new Date(), year = now.getFullYear(), m = now.getMonth();
  const d = (day) => dateKey(new Date(year, m, day, 12));
  const created_at = new Date().toISOString();
  const newEvent = (title, day, start_time, category) => ({ id: crypto.randomUUID(), title, event_date: d(day), start_time, category, notes: '', workspace_id: 'demo', created_at });
  return {
    events: [newEvent('Coffee & catch-up', 3, '10:00', 'sage'), newEvent('Project check-in', 6, '09:30', 'lavender'), newEvent('Dinner with friends', 9, '19:00', 'peach'), newEvent('A little time outside', 12, '15:00', 'sage'), newEvent('Plan the week', 15, '10:00', 'lavender'), newEvent('Movie night', 17, '20:00', 'peach'), newEvent('Market morning', 21, '09:00', 'sage'), newEvent('Team catch-up', 23, '11:00', 'lavender'), newEvent('Dinner together', Math.min(now.getDate(), 28), '18:30', 'peach'), newEvent('Weekend wandering', 30, null, 'sage')],
    tasks: [
      { title: 'Pick up a few things for dinner', due_date: dateKey(now), category: 'sage', assigned_to: 'Alex', notes: 'Something fresh, something green.', completed: false },
      { title: 'Find a spot for our next weekend away', due_date: d(30), category: 'peach', assigned_to: 'Sam', notes: '', completed: false },
      { title: 'Share the notes from our catch-up', due_date: d(28), category: 'lavender', assigned_to: 'You', notes: '', completed: false },
      { title: 'Water the plants', due_date: null, category: 'sage', assigned_to: '', notes: '', completed: true }
    ].map(task => ({ ...task, id: crypto.randomUUID(), workspace_id: 'demo', created_at }))
  };
}
function enterDemo() {
  generation++; clearInterval(poll); demo = true;
  user = { id: 'demo', user_metadata: { display_name: 'You' } };
  workspace = { id: 'demo', name: 'Our everyday', owner_id: 'demo' }; workspaces = [workspace];
  members = [{ user_id: 'demo', display_name: 'You' }, { user_id: 'alex', display_name: 'Alex' }, { user_id: 'sam', display_name: 'Sam' }];
  let saved;
  try { saved = JSON.parse(storage.get('together-demo-v1')); } catch { /* Use fresh sample data. */ }
  const data = saved && Array.isArray(saved.events) && Array.isArray(saved.tasks) ? saved : sampleData();
  events = data.events; tasks = data.tasks;
  $('auth-view').hidden = true; $('app-view').hidden = false; $('demo-banner').hidden = false;
  $('user-name').textContent = 'You'; $('user-avatar').textContent = 'Y'; $('user-mode').textContent = 'Demo space';
  $('account-button').ariaLabel = 'Leave demo'; $('workspace-select').innerHTML = '<option>Our everyday</option>';
  $('sync-status').textContent = 'Demo'; $('new-workspace').hidden = true;
  render(); window.scrollTo(0, 0);
}
function saveDemo() { storage.set('together-demo-v1', JSON.stringify({ events, tasks })); render(); }
function render() {
  const today = new Date(), todayKey = dateKey(today);
  $('today-label').textContent = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  $('month-label').textContent = month.toLocaleDateString('en-GB', { month: 'long' });
  $('year-label').textContent = month.getFullYear();
  const monthKey = dateKey(month).slice(0, 7);
  $('month-event-count').textContent = events.filter(event => event.event_date.startsWith(monthKey)).length;
  const openCount = tasks.filter(task => !task.completed).length;
  ['open-task-count', 'sidebar-task-count', 'tasks-count'].forEach(id => { $(id).textContent = openCount; });
  $('task-progress').textContent = `${tasks.filter(task => task.completed).length} of ${tasks.length} done`;
  $('calendar-grid').innerHTML = monthCells(month).map(date => {
    const day = dateKey(date), dayEvents = eventsOn(events, day);
    return `<div class="day-cell${date.getMonth() !== month.getMonth() ? ' outside' : ''}${[0, 6].includes(date.getDay()) ? ' weekend' : ''}${selectedDate === day ? ' selected' : ''}"><button class="day-number${day === todayKey ? ' is-today' : ''}" data-day="${day}" aria-label="${esc(fullDate(day))}, ${dayEvents.length} events"${day === todayKey ? ' aria-current="date"' : ''}>${date.getDate()}</button>${dayEvents.slice(0, 2).map(event => `<button class="event-chip ${safeCategory(event.category)}" data-event="${esc(event.id)}" title="${esc(event.title)}${event.start_time ? ` · ${esc(event.start_time.slice(0, 5))}` : ''}"><span>${esc(event.title)}</span>${event.start_time ? `<small>${esc(event.start_time.slice(0, 5))}</small>` : ''}</button>`).join('')}${dayEvents.length > 2 ? `<button class="more-events" data-day="${day}">+${dayEvents.length - 2} more</button>` : ''}</div>`;
  }).join('');
  $('selected-day').hidden = !selectedDate;
  if (selectedDate) {
    $('selected-day-label').textContent = fullDate(selectedDate);
    const selected = eventsOn(events, selectedDate);
    $('day-events').innerHTML = selected.length ? selected.map(event => `<button class="day-event ${safeCategory(event.category)}" data-event="${esc(event.id)}"><small>${event.start_time ? esc(event.start_time.slice(0, 5)) : 'All day'}</small><strong>${esc(event.title)}</strong><span>↗</span></button>`).join('') : '<p class="empty-state">A little breathing room. Add a plan whenever you’re ready.</p>';
  }
  const filtered = visibleTasks(tasks, taskFilter, todayKey);
  $('task-list').innerHTML = filtered.length ? filtered.map(task => `<div class="task-row${task.completed ? ' completed' : ''}"><input class="task-check" type="checkbox" data-toggle-task="${esc(task.id)}" ${task.completed ? 'checked' : ''} aria-label="${esc(`${task.completed ? 'Reopen' : 'Complete'} ${task.title}`)}"><button class="task-content" data-task="${esc(task.id)}"><span class="task-title">${esc(task.title)}</span>${task.notes ? `<span class="task-notes">${esc(task.notes)}</span>` : ''}</button><span class="task-category ${safeCategory(task.category)}">${categoryNames[safeCategory(task.category)]}</span><span class="task-due${task.due_date && task.due_date < todayKey && !task.completed ? ' overdue' : ''}">${esc(dateLabel(task.due_date))}</span>${task.assigned_to ? `<span class="task-assignee" title="${esc(task.assigned_to)}">${esc(initials(task.assigned_to))}</span>` : ''}</div>`).join('') : `<div class="empty-state"><strong>${taskFilter === 'done' ? 'Small wins will live here.' : 'A little less on your mind.'}</strong>${taskFilter === 'done' ? 'Check off a task to see it here.' : 'No tasks in this view. Add one below.'}</div>`;
  document.querySelectorAll('[data-filter]').forEach(button => { const active = button.dataset.filter === taskFilter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
}
function openEditor(kind, id) {
  if (!workspace) { $('workspace-dialog').showModal(); return; }
  const item = id ? (kind === 'event' ? events : tasks).find(item => item.id === id) : null;
  if (id && !item) { toast('This item is no longer available.'); return; }
  editing = { kind, id: item?.id || null, workspaceId: workspace.id };
  $('editor-form').reset(); $('editor-status').textContent = '';
  $('editor-heading').textContent = `${item ? 'Edit' : 'New'} ${kind}`;
  $('editor-eyebrow').textContent = kind === 'event' ? 'MAKE A LITTLE PLAN' : 'A LITTLE LESS TO REMEMBER';
  $('save-item').textContent = `Save ${kind}`;
  $('delete-item').hidden = !item;
  $('time-label').hidden = kind !== 'event'; $('assignee-label').hidden = kind !== 'task';
  $('date-label').firstChild.textContent = kind === 'event' ? 'Date' : 'Due date (optional)';
  $('item-date').required = kind === 'event';
  $('item-title').value = item?.title || '';
  $('item-date').value = item ? item.event_date || item.due_date || '' : kind === 'event' ? selectedDate || dateKey(new Date()) : '';
  $('item-time').value = item?.start_time?.slice(0, 5) || '';
  $('item-category').value = safeCategory(item?.category);
  $('item-assignee').value = item?.assigned_to || ''; $('item-notes').value = item?.notes || '';
  $('editor-dialog').showModal(); $('item-title').focus();
}
async function persistItem(kind, id, values) {
  if (!workspace) throw new Error('Create or select a shared space first.');
  const collection = kind === 'event' ? events : tasks;
  if (demo) {
    if (id) {
      const index = collection.findIndex(item => item.id === id);
      if (index < 0) throw new Error('This item has already been removed.');
      collection[index] = { ...collection[index], ...values };
    } else collection.push({ ...values, id: crypto.randomUUID(), workspace_id: workspace.id, created_at: new Date().toISOString(), ...(kind === 'task' ? { completed: false } : {}) });
    saveDemo(); return;
  }
  const table = kind === 'event' ? 'events' : 'tasks';
  const response = id ? await client.from(table).update(values).eq('id', id).eq('workspace_id', workspace.id).select('id').single() : await client.from(table).insert({ ...values, workspace_id: workspace.id, created_by: user.id }).select('id').single();
  result(response); await refresh();
}
function confirmAction(title = 'Delete this item?', description = 'This removes it for everyone in this space.', action = 'Delete') {
  $('confirm-heading').textContent = title; $('confirm-dialog').querySelector('p').textContent = description;
  $('confirm-delete').textContent = action;
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    function finish(value) { dialog.close(); dialog.removeEventListener('cancel', cancel); $('confirm-delete').onclick = null; $('cancel-delete').onclick = null; resolve(value); }
    function cancel(event) { event.preventDefault(); finish(false); }
    $('confirm-delete').onclick = () => finish(true); $('cancel-delete').onclick = () => finish(false);
    dialog.addEventListener('cancel', cancel); dialog.showModal();
  });
}
async function showShare() {
  if (!workspace) { $('workspace-dialog').showModal(); return; }
  $('share-status').textContent = ''; $('invite-output').hidden = true;
  const owner = workspace.owner_id === user.id;
  $('share-owner-controls').hidden = !owner;
  if (!owner) $('share-status').textContent = 'The space owner can create invitation links.';
  if (demo) $('share-status').textContent = 'This is a local demo. Sign in to invite people to a real shared space.';
  $('generate-invite').disabled = demo; $('revoke-invites').disabled = demo;
  $('member-list').innerHTML = members.map(member => `<div class="member"><span class="avatar">${esc(initials(member.display_name))}</span><span>${esc(member.display_name)}</span>${member.user_id === workspace.owner_id ? '<small>Owner</small>' : owner && !demo ? `<button data-remove-member="${esc(member.user_id)}">Remove</button>` : '<small>Member</small>'}</div>`).join('');
  $('share-dialog').showModal();
}

$('auth-toggle').onclick = () => { recovery = false; setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); };
$('forgot-password').onclick = () => setAuthMode('reset');
$('auth-form').onsubmit = (event) => {
  event.preventDefault();
  busy($('auth-submit'), async () => {
    if (!client) throw new Error('Shared login is not connected yet. You can explore the demo below.');
    const email = $('auth-email').value.trim(), password = $('auth-password').value;
    if (authMode === 'signup') {
      const name = $('auth-name').value.trim();
      if (!name) throw new Error('Please enter your name.');
      const data = result(await client.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: baseUrl() } }));
      if (data.session) await enterSession(data.session); else $('auth-status').textContent = 'Check your email to confirm your account, then sign in here.';
    } else if (authMode === 'reset') {
      result(await client.auth.resetPasswordForEmail(email, { redirectTo: baseUrl() }));
      $('auth-status').textContent = 'If this email is registered, you’ll receive a password reset link.';
    } else if (authMode === 'recovery') {
      result(await client.auth.updateUser({ password })); recovery = false;
      const data = result(await client.auth.getSession()); await enterSession(data.session); toast('Password updated.');
    } else {
      const data = result(await client.auth.signInWithPassword({ email, password }));
      await enterSession(data.session);
    }
    $('auth-password').value = '';
  }, 'auth-status');
};
$('demo-button').onclick = enterDemo;
$('leave-demo').onclick = authView;
$('account-button').onclick = () => busy($('account-button'), async () => {
  if (!demo && client) result(await client.auth.signOut());
  authView();
});
$('previous-month').onclick = () => { month = shiftMonth(month, -1); render(); };
$('next-month').onclick = () => { month = shiftMonth(month, 1); render(); };
$('today-button').onclick = () => { month = new Date(); selectedDate = dateKey(month); render(); };
document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => { taskFilter = button.dataset.filter; render(); }; });
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('add-event').onclick = () => openEditor('event'); $('day-add-event').onclick = () => openEditor('event');
$('add-task').onclick = () => openEditor('task');
document.addEventListener('click', event => {
  const dayButton = event.target.closest('[data-day]');
  if (dayButton) { selectedDate = dayButton.dataset.day; render(); }
  const eventButton = event.target.closest('[data-event]'); if (eventButton) openEditor('event', eventButton.dataset.event);
  const taskButton = event.target.closest('[data-task]'); if (taskButton) openEditor('task', taskButton.dataset.task);
  const removeButton = event.target.closest('[data-remove-member]');
  if (removeButton) busy(removeButton, async () => {
    if (!await confirmAction('Remove this member?', 'They will lose access to this space. You can invite them again later.', 'Remove')) return;
    result(await client.rpc('remove_workspace_member', { target_workspace: workspace.id, target_user: removeButton.dataset.removeMember }));
    await refresh(); $('share-dialog').close(); await showShare(); toast('Member removed.');
  }, 'share-status');
});
$('task-list').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-toggle-task]'); if (!checkbox) return;
  const task = tasks.find(item => item.id === checkbox.dataset.toggleTask); if (!task) return;
  busy(checkbox, async () => { try { await persistItem('task', task.id, { completed: checkbox.checked }); } catch (error) { checkbox.checked = task.completed; throw error; } });
});
$('editor-form').onsubmit = event => {
  event.preventDefault();
  busy($('save-item'), async () => {
    if (editing.workspaceId !== workspace?.id) throw new Error('The active space changed. Close this editor and try again.');
    const values = { title: cleanTitle($('item-title').value), notes: $('item-notes').value.trim(), category: $('item-category').value };
    if (editing.kind === 'event') { values.event_date = $('item-date').value; values.start_time = $('item-time').value || null; }
    else { values.due_date = $('item-date').value || null; values.assigned_to = $('item-assignee').value.trim(); }
    await persistItem(editing.kind, editing.id, values); $('editor-dialog').close(); toast('Saved. A little more in sync.');
  }, 'editor-status');
};
$('delete-item').onclick = () => busy($('delete-item'), async () => {
  if (editing.workspaceId !== workspace?.id) throw new Error('The active space changed. Close this editor and try again.');
  if (!await confirmAction()) return;
  if (demo) { if (editing.kind === 'event') events = events.filter(item => item.id !== editing.id); else tasks = tasks.filter(item => item.id !== editing.id); saveDemo(); }
  else { result(await client.from(editing.kind === 'event' ? 'events' : 'tasks').delete().eq('id', editing.id).eq('workspace_id', workspace.id).select('id').single()); await refresh(); }
  $('editor-dialog').close(); toast('Item deleted.');
}, 'editor-status');
$('quick-task-form').onsubmit = event => {
  event.preventDefault();
  busy($('quick-task-form').querySelector('button'), async () => {
    await persistItem('task', null, { title: cleanTitle($('quick-task-title').value), notes: '', category: 'sage', due_date: null, assigned_to: '' });
    $('quick-task-title').value = ''; $('quick-task-title').focus();
  });
};
$('workspace-select').onchange = () => busy($('workspace-select'), async () => {
  if (demo) return;
  generation++; workspace = workspaces.find(item => item.id === $('workspace-select').value) || null;
  selectedDate = null; events = []; tasks = []; members = []; render(); await refresh();
});
$('new-workspace').onclick = () => { $('workspace-status').textContent = ''; $('workspace-dialog').showModal(); };
$('workspace-form').onsubmit = event => {
  event.preventDefault();
  busy($('workspace-form').querySelector('[type=submit]'), async () => {
    if (!client || demo) throw new Error('Sign in to create a shared space.');
    const name = $('workspace-name').value.trim(); if (!name) throw new Error('Please name your space.');
    const id = result(await client.rpc('create_workspace', { workspace_name: name }));
    await loadWorkspaces(id); $('workspace-dialog').close(); $('workspace-form').reset(); toast('Your space is ready.');
  }, 'workspace-status');
};
$('invite-button').onclick = showShare; $('sidebar-invite').onclick = showShare;
$('generate-invite').onclick = () => busy($('generate-invite'), async () => {
  const token = result(await client.rpc('create_workspace_invite', { target_workspace: workspace.id }));
  const url = new URL(baseUrl()); url.searchParams.set('invite', token);
  $('invite-link').value = url.href; $('invite-output').hidden = false;
}, 'share-status');
$('copy-invite').onclick = () => busy($('copy-invite'), async () => {
  try { await navigator.clipboard.writeText($('invite-link').value); toast('Invite link copied.'); }
  catch { $('invite-link').focus(); $('invite-link').select(); $('share-status').textContent = 'Select and copy the link above.'; }
});
$('revoke-invites').onclick = () => busy($('revoke-invites'), async () => {
  result(await client.rpc('revoke_workspace_invites', { target_workspace: workspace.id }));
  $('invite-output').hidden = true; $('share-status').textContent = 'All existing invite links have been revoked. Current members keep access.';
}, 'share-status');
$('join-space').onclick = () => busy($('join-space'), async () => {
  const id = result(await client.rpc('join_workspace', { invite_token: storage.get('together-invite', true) || '' }));
  storage.remove('together-invite', true); await loadWorkspaces(id); $('join-dialog').close(); toast('Welcome to your shared space.');
}, 'join-status');

async function boot() {
  $('setup-notice').hidden = Boolean(client);
  if (!client) return;
  const data = result(await client.auth.getSession());
  if (recovery) { setAuthMode('recovery'); } else if (data.session) await enterSession(data.session);
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovery = true; $('app-view').hidden = true; $('auth-view').hidden = false; setAuthMode('recovery'); return; }
    // Schedule outside the auth callback to avoid locking the client's auth storage.
    if (event === 'SIGNED_OUT') setTimeout(authView, 0);
    else if (event === 'SIGNED_IN' && !recovery && !demo) setTimeout(() => { enterSession(session).catch(error => toast(errorMessage(error))); }, 0);
  });
}
boot().catch(error => { $('auth-status').textContent = errorMessage(error); });
