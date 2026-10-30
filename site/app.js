import { generateRecoveryKey, importRecoveryKey } from './crypto.js';
import { createDeviceKeyStore } from './device-keys.js';
import { verifiedAuthenticators, authenticatorLabel, createAuthenticatorEnrollment } from './authenticators.js';
import { unlockName, decodeRecord, loadEncryptedRecords, createEncryptedWorkspace, writeEncryptedRecord, rotateEncryptedWorkspace } from './encrypted-store.js';
import { dateKey, parseDate, monthCells, shiftMonth, eventsOn, visibleTasks, cleanTitle } from './calendar.js';

const $ = (id) => document.getElementById(id);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  'check-square': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z"/>',
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
const signupEnabled = config.allowSignups === true;
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') && Boolean(config.supabasePublishableKey);
const client = configured && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true } }) : null;
let demo = false, user = null, workspaces = [], workspace = null, events = [], tasks = [], members = [];
let month = new Date(), selectedDate = null, taskFilter = 'open', authMode = 'signin', editing = null, generation = 0, poll = null, toastTimeout;
let automaticSyncRunning = false;
const keys = new Map();
const remembered = new Map();
const deviceScope = JSON.stringify([config.supabaseUrl || 'unconfigured', new URL('./', location.href).pathname]);
const deviceKeys = createDeviceKeyStore(deviceScope);
const deviceChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('together-device-keys:' + deviceScope) : null;
let pendingDeviceUnlock = null;
let pendingAuthenticatorSetup = null, mfaChoices = [];
let sessionReady = false, sessionGeneration = 0, vaultRevision = 0, mfaFactor = null, pendingRemoval = null, lastActivity = Date.now();
let recovery = new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
const initialUrl = new URL(location.href);
const fragmentInvite = new URLSearchParams(initialUrl.hash.slice(1)).get('invite');
if (fragmentInvite && /^[a-f0-9]{64}$/.test(fragmentInvite)) {
  storage.set('together-invite',fragmentInvite,true); initialUrl.hash=''; history.replaceState(null,'',initialUrl.pathname+initialUrl.search);
}
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
  if (mode === 'signup' && !signupEnabled) mode = 'signin';
  authMode = mode;
  $('name-label').hidden = mode !== 'signup';
  $('auth-name').required = mode === 'signup';
  $('password-label').hidden = mode === 'reset';
  $('auth-password').required = mode !== 'reset';
  $('auth-password').minLength = mode === 'signin' ? 1 : 14;
  $('auth-password').autocomplete = ['signup', 'recovery'].includes(mode) ? 'new-password' : 'current-password';
  $('auth-email').closest('label').hidden = mode === 'recovery';
  $('auth-email').required = mode !== 'recovery';
  $('auth-heading').textContent = { signin: 'Welcome to your everyday.', signup: 'Make room for your people.', reset: 'Let’s get you back in.', recovery: 'A fresh start.' }[mode];
  $('auth-description').textContent = { signin: 'Sign in and pick up where life left off.', signup: 'Create an account, then a space to share.', reset: 'We’ll email you a password reset link.', recovery: 'Choose a new password of at least 14 characters.' }[mode];
  $('auth-submit').textContent = { signin: 'Sign in ↗', signup: 'Create account ↗', reset: 'Send reset link ↗', recovery: 'Save new password ↗' }[mode];
  $('auth-toggle').textContent = mode === 'signin' ? 'Create an account' : 'Back to sign in';
  $('auth-toggle').hidden = mode === 'signin' && !signupEnabled;
  $('forgot-password').hidden = mode !== 'signin';
  $('auth-status').textContent = '';
}
function wipePlaintext() {
  $('space-menu').open = false;
  const addingAuthenticator = Boolean(pendingAuthenticatorSetup);
  clearAuthenticatorSetup();
  if (addingAuthenticator) $('mfa-dialog').close();
  pendingDeviceUnlock = null;
  generation++; vaultRevision++; keys.clear(); events = []; tasks = []; selectedDate = null; editing = null;
  workspaces.forEach(space => { delete space.name; }); if (workspace) delete workspace.name;
  ['calendar-grid','task-list','day-events','member-list'].forEach(id => { $(id).replaceChildren(); });
  ['editor-form','workspace-form','unlock-form','rotate-form','quick-task-form'].forEach(id => $(id).reset());
  ['create-recovery-key','rotate-recovery-key','unlock-key','invite-link'].forEach(id => { $(id).value = ''; });
  document.querySelectorAll('dialog[open]:not(#mfa-dialog)').forEach(dialog => dialog.close());
}
function lockVault(notify = true) {
  if (demo) return;
  const verifyingUnlock = Boolean(pendingDeviceUnlock);
  wipePlaintext(); updateSpaceSelector(); render();
  if (verifyingUnlock) $('mfa-dialog').close();
  if (notify) toast(remembered.size ? 'Space locked. Your remembered key stays on this device; verify your authenticator to unlock.' : 'Your space is locked. Its key and decrypted plans were cleared from this tab.');
}
function authView() {
  sessionGeneration++; sessionReady = false; clearInterval(poll);
  wipePlaintext(); remembered.clear(); demo = false; user = null; workspace = null; workspaces = []; members = [];
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('workspace-select').replaceChildren(); $('user-name').textContent = 'You';
  $('mfa-secret').value = ''; $('mfa-code').value = ''; $('mfa-qr').removeAttribute('src'); mfaFactor = null;
  $('app-view').hidden = true; $('auth-view').hidden = false; $('auth-password').value = '';
  setAuthMode('signin');
}
async function prepareMfa() {
  const expectedUser = user?.id, attempt = sessionGeneration, unlock = pendingDeviceUnlock, setup = pendingAuthenticatorSetup;
  const factors = result(await client.auth.mfa.listFactors());
  if (user?.id !== expectedUser || attempt !== sessionGeneration || (unlock && pendingDeviceUnlock !== unlock) || setup !== pendingAuthenticatorSetup) return;
  mfaChoices = verifiedAuthenticators(factors);
  mfaFactor = mfaChoices[0]?.id || null;
  $('mfa-phone').replaceChildren(...mfaChoices.map((factor,index) => new Option(authenticatorLabel(factor,index),factor.id)));
  $('mfa-phone-label').hidden = !mfaFactor;
  $('mfa-enroll').hidden = Boolean(mfaFactor); $('mfa-setup').hidden = true;
  $('mfa-secret').value = ''; $('mfa-qr').removeAttribute('src'); $('mfa-code').value = '';
  $('mfa-verify').disabled = !mfaFactor; $('mfa-status').textContent = '';
  $('mfa-description').textContent = mfaFactor ? 'Enter the six-digit code from your authenticator. The database requires this verification before it allows any calendar access.' : 'Set up an authenticator app before creating or opening a calendar. Keep a private backup of its setup code.';
  $('mfa-heading').textContent = setup ? 'Verify your existing phone' : 'Verify it’s you';
  $('mfa-cancel').hidden = !setup;
  if (setup) {
    $('mfa-enroll').hidden = true;
    $('mfa-description').textContent = 'Choose a phone already registered to this account and enter a fresh code before adding another authenticator.';
    if (!mfaFactor) throw new Error('No existing authenticator is available. Sign in again.');
  }
  if (!$('mfa-dialog').open) $('mfa-dialog').showModal();
}
async function enterSession(session) {
  if (!session?.user) { authView(); return; }
  if (user?.id === session.user.id && sessionReady && !demo && !$('app-view').hidden) return;
  const attempt = ++sessionGeneration;
  demo = false; user = session.user; lastActivity = Date.now();
  const assurance = result(await client.auth.mfa.getAuthenticatorAssuranceLevel());
  if (attempt !== sessionGeneration) return;
  if (assurance.currentLevel !== 'aal2') {
    sessionReady = false; $('app-view').hidden = true; $('auth-view').hidden = false;
    await prepareMfa(); return;
  }
  sessionReady = true;
  $('mfa-dialog').close(); $('mfa-secret').value = ''; $('mfa-code').value = ''; $('mfa-qr').removeAttribute('src');
  $('auth-view').hidden = true; $('app-view').hidden = false; $('demo-banner').hidden = true;
  $('user-name').textContent = displayName(); $('user-avatar').textContent = initials(displayName());
  $('user-mode').textContent = 'Verified · sign out'; $('account-button').ariaLabel = 'Sign out';
  $('new-workspace').hidden = false;
  $('add-authenticator').hidden = false;
  await loadWorkspaces(undefined, true);
  if (attempt !== sessionGeneration) return;
  clearInterval(poll);
  poll = setInterval(syncAutomatically, 10000);
  if (storage.get('together-invite', true)) $('join-dialog').showModal();
}
function updateSpaceSelector() {
  $('workspace-select').innerHTML = workspaces.map(item => '<option value="'+esc(item.id)+'">'+esc(item.name || 'Locked space · '+item.id.slice(0,6))+'</option>').join('') || '<option value="">Choose a space</option>';
  if (workspace) $('workspace-select').value = workspace.id;
}
function showCreateSpace() {
  $('workspace-form').reset(); $('workspace-status').textContent = '';
  $('create-recovery-key').value = generateRecoveryKey(); $('workspace-dialog').showModal();
}
function showUnlock() {
  if (!workspace || demo) return;
  if (remembered.get(workspace.id) === workspace.key_epoch) {
    pendingDeviceUnlock = { id: workspace.id, userId: user.id, revision: vaultRevision };
    prepareMfa().catch(error => { pendingDeviceUnlock = null; toast(errorMessage(error)); });
    return;
  }
  $('unlock-form').reset(); $('unlock-status').textContent = ''; $('unlock-dialog').showModal();
}
async function rememberKey(space, key, expectedUser = user?.id) {
  await deviceKeys.save(expectedUser, space.id, space.key_epoch, key);
  if (user?.id === expectedUser) remembered.set(space.id, space.key_epoch);
  deviceChannel?.postMessage({ action: 'saved', userId: expectedUser, id: space.id, epoch: space.key_epoch });
}
async function forgetKey(space, expectedUser = user?.id) {
  await deviceKeys.forget(expectedUser, space.id, space.key_epoch);
  if (user?.id === expectedUser && remembered.get(space.id) === space.key_epoch) remembered.delete(space.id);
  deviceChannel?.postMessage({ action: 'forgot', userId: expectedUser, id: space.id, epoch: space.key_epoch });
}
async function restoreDeviceKey(space, expectedUser, revision) {
  const key = await deviceKeys.read(expectedUser, space.id, space.key_epoch);
  if (!key || revision !== vaultRevision || user?.id !== expectedUser || !sessionReady || demo) return false;
  let name;
  try { name = await unlockName(space, key); }
  catch {
    // A damaged server envelope is not evidence that this local backup should be destroyed.
    toast('The remembered key could not unlock this space. Enter its recovery key.');
    return false;
  }
  if (revision !== vaultRevision || user?.id !== expectedUser || !sessionReady || demo) return false;
  keys.set(space.id, { key, epoch: space.key_epoch }); remembered.set(space.id, space.key_epoch); space.name = name;
  return true;
}
async function loadWorkspaces(preferredId, restoreRemembered = false) {
  const expectedUser = user?.id, revision = vaultRevision;
  const data = result(await client.from('workspaces').select('*').order('created_at'));
  if (user?.id !== expectedUser || demo || revision !== vaultRevision) return;
  workspaces = data;
  if (restoreRemembered && sessionReady) {
    try {
      await deviceKeys.prune(expectedUser, data);
      for (const space of data) {
        if (revision !== vaultRevision || user?.id !== expectedUser) return;
        await restoreDeviceKey(space, expectedUser, revision);
      }
    } catch (error) { toast(errorMessage(error)); }
  }
  if (user?.id !== expectedUser || demo || revision !== vaultRevision) return;
  for (const space of workspaces) {
    const cached = keys.get(space.id);
    if (cached && cached.epoch === space.key_epoch) {
      const name = await unlockName(space,cached.key);
      if (revision !== vaultRevision || user?.id !== expectedUser) return;
      space.name = name;
    }
    else keys.delete(space.id);
  }
  workspace = workspaces.find(item => item.id === preferredId) || workspaces.find(item => item.id === workspace?.id) || workspaces[0] || null;
  updateSpaceSelector();
  if (workspace) { await refresh(); if (!keys.has(workspace?.id) && !storage.get('together-invite',true)) showUnlock(); }
  else { events = []; tasks = []; members = []; render(); if (!storage.get('together-invite',true)) showCreateSpace(); }
}
async function syncAutomatically() {
  if (automaticSyncRunning || document.hidden || !sessionReady || !workspace || demo) return;
  const expectedUser = user?.id, expectedWorkspace = workspace.id, attempt = sessionGeneration;
  automaticSyncRunning = true;
  try { await refresh(); }
  catch {
    if (attempt === sessionGeneration && user?.id === expectedUser && workspace?.id === expectedWorkspace && !demo) $('sync-status').textContent = 'Sync paused · retrying';
  } finally { automaticSyncRunning = false; }
}
async function refresh() {
  if (!workspace) return;
  const id = workspace.id, ticket = ++generation;
  const [spaceData, memberData] = await Promise.all([
    client.from('workspaces').select('*').eq('id',id).maybeSingle(),
    client.from('workspace_members').select('user_id,display_name').eq('workspace_id',id)
  ]);
  if (ticket !== generation || workspace?.id !== id || demo) return;
  const current = result(spaceData); members = result(memberData);
  if (!current || !members.some(member => member.user_id === user?.id)) {
    const removed = workspace, expectedUser = user.id;
    forgetKey(removed, expectedUser).catch(() => {});
    lockVault(false); workspace = null; await loadWorkspaces(); return;
  }
  const cached = keys.get(id);
  workspace = {...current, name:workspace.name}; workspaces = workspaces.map(item => item.id === id ? workspace : item);
  if (!cached || cached.epoch !== current.key_epoch) {
    const oldEpoch = cached?.epoch || remembered.get(id);
    if (oldEpoch && oldEpoch !== current.key_epoch) {
      forgetKey({ id, key_epoch: oldEpoch }).catch(() => {});
      remembered.delete(id);
    }
    if (cached) lockVault(false);
    keys.delete(id); delete workspace.name; events=[]; tasks=[]; selectedDate=null;
    $('day-events').replaceChildren(); updateSpaceSelector(); render(); return;
  }
  try {
    const rows = await loadEncryptedRecords(client,current);
    const decoded = await Promise.all(rows.map(row => decodeRecord(current,row,cached.key)));
    if (ticket !== generation || workspace?.id !== id || keys.get(id) !== cached) return;
    events = decoded.filter(item => item.kind === 'event'); tasks = decoded.filter(item => item.kind === 'task');
    $('sync-status').textContent = 'Encrypted · up to date'; render();
  } catch (error) { if (ticket === generation) lockVault(false); throw error; }
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
  keys.clear();
  const data = sampleData();
  events = data.events; tasks = data.tasks;
  $('auth-view').hidden = true; $('app-view').hidden = false; $('demo-banner').hidden = false;
  $('user-name').textContent = 'You'; $('user-avatar').textContent = 'Y'; $('user-mode').textContent = 'Demo space';
  $('account-button').ariaLabel = 'Leave demo'; $('workspace-select').innerHTML = '<option>Our everyday</option>';
  $('sync-status').textContent = 'Demo'; $('new-workspace').hidden = true;
  render(); window.scrollTo(0, 0);
}
function saveDemo() { render(); }
function render() {
  const locked = !demo && workspace && !keys.has(workspace.id);
  $('vault-banner').hidden = !locked;
  $('lock-space').hidden = demo || !workspace || locked;
  $('device-key').hidden = demo || !workspace;
  $('add-authenticator').hidden = demo || !sessionReady;
  $('vault-description').textContent = remembered.get(workspace?.id) === workspace?.key_epoch && workspace
    ? 'A key is remembered in this browser. Verify your authenticator to unlock your plans.'
    : 'Unlock with the recovery key from your password manager. You can choose to remember it in this browser.';
  $('calendar-section').hidden = Boolean(locked); $('tasks-section').hidden = Boolean(locked);
  document.querySelector('.overview').hidden = Boolean(locked);
  if (locked) $('sync-status').textContent = 'Locked';
  const today = new Date(), todayKey = dateKey(today);
  $('today-label').textContent = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('month-label').textContent = month.toLocaleDateString('en-GB', { month: 'long' });
  $('year-label').textContent = month.getFullYear();
  const monthKey = dateKey(month).slice(0, 7);
  $('month-event-count').textContent = events.filter(event => event.event_date.startsWith(monthKey)).length;
  const openCount = tasks.filter(task => !task.completed).length;
  ['open-task-count', 'sidebar-task-count', 'tasks-count'].forEach(id => { $(id).textContent = openCount; });
  $('task-progress').textContent = `${tasks.filter(task => task.completed).length} of ${tasks.length} done`;
  const calendarDays = monthCells(month);
  while (calendarDays.length > 28 && calendarDays[calendarDays.length - 7].getMonth() !== month.getMonth()) calendarDays.splice(-7);
  $('calendar-grid').innerHTML = calendarDays.map(date => {
    const day = dateKey(date), dayEvents = eventsOn(events, day);
    return `<div class="day-cell${date.getMonth() !== month.getMonth() ? ' outside' : ''}${[0, 6].includes(date.getDay()) ? ' weekend' : ''}${selectedDate === day ? ' selected' : ''}"><button class="day-number${day === todayKey ? ' is-today' : ''}" data-day="${day}" aria-label="${esc(fullDate(day))}, ${dayEvents.length} events"${day === todayKey ? ' aria-current="date"' : ''}>${date.getDate()}</button><span class="day-markers" aria-hidden="true">${dayEvents.slice(0,3).map(event => `<i class="${safeCategory(event.category)}"></i>`).join('')}${dayEvents.length>3 ? '<small>+</small>' : ''}</span>${dayEvents.slice(0, 2).map(event => `<button class="event-chip ${safeCategory(event.category)}" data-event="${esc(event.id)}" title="${esc(event.title)}${event.start_time ? ` · ${esc(event.start_time.slice(0, 5))}` : ''}"><span>${esc(event.title)}</span>${event.start_time ? `<small>${esc(event.start_time.slice(0, 5))}</small>` : ''}</button>`).join('')}${dayEvents.length > 2 ? `<button class="more-events" data-day="${day}">+${dayEvents.length - 2} more</button>` : ''}</div>`;
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
  if (!workspace) { showCreateSpace(); return; }
  if (!demo && !keys.has(workspace.id)) { showUnlock(); return; }
  const item = id ? (kind === 'event' ? events : tasks).find(item => item.id === id) : null;
  if (id && !item) { toast('This item is no longer available.'); return; }
  editing = { kind, id: item?.id || null, workspaceId: workspace.id, previous: item ? {...item} : null };
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
async function persistItem(kind, id, values, editorVersion) {
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
  const cached = keys.get(workspace.id);
  if (!cached || cached.epoch !== workspace.key_epoch) throw new Error('Unlock this space with its current key first.');
  const previous = id ? editorVersion || collection.find(item => item.id === id) : null;
  if (id && !previous) throw new Error('This item no longer exists. Refresh and retry.');
  await writeEncryptedRecord(client,workspace,cached.key,user.id,kind,previous,values);
  await refresh();
}
function confirmAction(title = 'Delete this item?', description = 'This removes it for everyone in this space.', action = 'Delete') {
  $('confirm-heading').textContent = title; $('confirm-dialog').querySelector('p').textContent = description;
  $('confirm-delete').textContent = action;
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    let settled = false;
    function finish(value) { if (settled) return; settled = true; dialog.close(); dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', closed); $('confirm-delete').onclick = null; $('cancel-delete').onclick = null; resolve(value); }
    function cancel(event) { event.preventDefault(); finish(false); }
    function closed() { finish(false); }
    $('confirm-delete').onclick = () => finish(true); $('cancel-delete').onclick = () => finish(false);
    dialog.addEventListener('cancel', cancel); dialog.addEventListener('close', closed); dialog.showModal();
  });
}
async function showShare() {
  if (!workspace) { showCreateSpace(); return; }
  $('share-status').textContent = ''; $('invite-output').hidden = true;
  const owner = workspace.owner_id === user.id;
  $('share-owner-controls').hidden = !owner;
  if (!owner) $('share-status').textContent = 'The space owner can create invitation links.';
  if (demo) $('share-status').textContent = 'This is a local demo. Sign in to invite people to a real shared space.';
  $('generate-invite').disabled = demo; $('revoke-invites').disabled = demo; $('rotate-key').disabled = demo || !keys.has(workspace.id);
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
    $('auth-password').value = '';
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
  if (!event.target.closest('#space-menu') || event.target.closest('.settings-panel button')) $('space-menu').open = false;
  const dayButton = event.target.closest('[data-day]');
  if (dayButton) {
    selectedDate = dayButton.dataset.day; render();
    if (matchMedia('(max-width: 640px)').matches) $('selected-day').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
  const eventButton = event.target.closest('[data-event]'); if (eventButton) openEditor('event', eventButton.dataset.event);
  const taskButton = event.target.closest('[data-task]'); if (taskButton) openEditor('task', taskButton.dataset.task);
  const removeButton = event.target.closest('[data-remove-member]');
  if (removeButton) openRotation(removeButton.dataset.removeMember);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('space-menu').open) {
    $('space-menu').open = false;
    $('space-menu').querySelector('summary').focus();
  }
});
let navigationFrame = null;
function updateNavigation() {
  navigationFrame = null;
  const tasksActive = !$('app-view').hidden && !$('tasks-section').hidden && $('tasks-section').getBoundingClientRect().top < innerHeight * .5;
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.hash === (tasksActive ? '#tasks-section' : '#calendar-section');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current');
  });
}
window.addEventListener('scroll', () => { if (navigationFrame === null) navigationFrame = requestAnimationFrame(updateNavigation); }, {passive:true});
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
    await persistItem(editing.kind, editing.id, values, editing.previous); $('editor-dialog').close(); toast('Saved. A little more in sync.');
  }, 'editor-status');
};
$('delete-item').onclick = () => busy($('delete-item'), async () => {
  if (editing.workspaceId !== workspace?.id) throw new Error('The active space changed. Close this editor and try again.');
  if (!await confirmAction()) return;
  if (demo) { if (editing.kind === 'event') events = events.filter(item => item.id !== editing.id); else tasks = tasks.filter(item => item.id !== editing.id); saveDemo(); }
  else {
    const previous = editing.previous;
    if (!previous || !keys.has(workspace.id)) throw new Error('Unlock and refresh this space before deleting.');
    const response = await client.from('encrypted_records').delete().eq('id',editing.id).eq('workspace_id',workspace.id).eq('updated_at',previous.updated_at).select('id').maybeSingle();
    result(response); if (!response.data) throw new Error('This item changed on another device. Refresh and retry.'); await refresh();
  }
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
  selectedDate = null; events = []; tasks = []; members = []; render(); await refresh(); if (!keys.has(workspace?.id)) showUnlock();
});
$('new-workspace').onclick = showCreateSpace;
$('workspace-form').onsubmit = event => {
  event.preventDefault();
  busy($('workspace-form').querySelector('[type=submit]'), async () => {
    if (!client || demo) throw new Error('Sign in to create a shared space.');
    const name = $('workspace-name').value.trim(); if (!name) throw new Error('Please name your space.');
    if (!$('create-key-saved').checked) throw new Error('Save the recovery key before continuing.');
    const revision = vaultRevision;
    const expectedUser = user.id, remember = $('create-remember').checked;
    const key = await importRecoveryKey($('create-recovery-key').value);
    const space = await createEncryptedWorkspace(client,name,key);
    if (revision === vaultRevision) keys.set(space.id,{key,epoch:space.key_epoch});
    let storageError;
    if (remember && revision === vaultRevision && user?.id === expectedUser) {
      try { await rememberKey(space, key, expectedUser); } catch (error) { storageError = error; }
    }
    $('create-recovery-key').value = ''; await loadWorkspaces(space.id);
    $('workspace-dialog').close(); $('workspace-form').reset(); toast(storageError ? 'Space created, but its key was not remembered. ' + errorMessage(storageError) : 'Your encrypted space is ready.');
  }, 'workspace-status');
};
$('invite-button').onclick = showShare;
$('generate-invite').onclick = () => busy($('generate-invite'), async () => {
  const token = result(await client.rpc('create_workspace_invite', { target_workspace: workspace.id }));
  const url = new URL(baseUrl()); url.hash = 'invite=' + token;
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
  storage.remove('together-invite', true); $('join-dialog').close(); await loadWorkspaces(id); toast('Membership added. Unlock with the key shared privately by the owner.');
}, 'join-status');

async function copyKey(inputId) {
  try { await navigator.clipboard.writeText($(inputId).value); toast('Key copied. Save it in your password manager, then clear your clipboard.'); }
  catch { $(inputId).type = 'text'; $(inputId).focus(); $(inputId).select(); toast('Copy and save the key, then hide it by closing this dialog.'); }
}
function openRotation(removeUser = null) {
  if (!workspace || !keys.has(workspace.id)) { showUnlock(); return; }
  pendingRemoval = removeUser;
  $('share-dialog').close(); $('rotate-form').reset(); $('rotate-status').textContent = '';
  $('rotate-heading').textContent = removeUser ? 'Remove member & change key' : 'Change encryption key';
  $('rotate-recovery-key').value = generateRecoveryKey(); $('rotate-dialog').showModal();
  $('rotate-remember').checked = remembered.get(workspace.id) === workspace.key_epoch;
}
$('lock-space').onclick = () => lockVault();
$('unlock-space').onclick = showUnlock;
$('unlock-form').onsubmit = event => {
  event.preventDefault();
  busy($('unlock-form').querySelector('[type=submit]'),async () => {
    const id=workspace?.id, revision=vaultRevision; if(!id) throw new Error('Choose a space first.');
    const expectedUser=user.id, remember=$('unlock-remember').checked;
    const key=await importRecoveryKey($('unlock-key').value); $('unlock-key').value='';
    const current=result(await client.from('workspaces').select('*').eq('id',id).single());
    const name=await unlockName(current,key);
    if(workspace?.id !== id || !user || revision !== vaultRevision) return;
    keys.set(id,{key,epoch:current.key_epoch}); workspace={...current,name};
    workspaces=workspaces.map(item=>item.id===id?workspace:item); updateSpaceSelector();
    let storageError;
    if(remember) { try { await rememberKey(current,key,expectedUser); } catch(error) { storageError=error; } }
    if (revision !== vaultRevision || user?.id !== expectedUser) return;
    lastActivity=Date.now(); await refresh(); $('unlock-dialog').close();
    toast(storageError ? 'Unlocked for this visit, but the key was not remembered. ' + errorMessage(storageError) : remember ? 'Space unlocked. Its key is remembered on this device.' : 'Space unlocked.');
  },'unlock-status');
};
$('copy-create-key').onclick=()=>copyKey('create-recovery-key');
$('copy-rotate-key').onclick=()=>copyKey('rotate-recovery-key');
$('rotate-key').onclick=()=>openRotation();
$('rotate-form').onsubmit=event=>{
  event.preventDefault();
  busy($('rotate-form').querySelector('[type=submit]'),async()=>{
    if(!$('rotate-key-saved').checked) throw new Error('Save the new key before continuing.');
    const cached=keys.get(workspace?.id); if(!cached) throw new Error('Unlock this space first.');
    const revision=vaultRevision;
    const expectedUser=user.id, oldSpace=workspace, remember=$('rotate-remember').checked;
    const key=await importRecoveryKey($('rotate-recovery-key').value);
    const updated=await rotateEncryptedWorkspace(client,workspace,cached.key,key,pendingRemoval);
    if (revision === vaultRevision) keys.set(updated.id,{key,epoch:updated.key_epoch});
    let storageError;
    try {
      await forgetKey(oldSpace,expectedUser);
      if(remember && revision === vaultRevision && user?.id === expectedUser) await rememberKey(updated,key,expectedUser);
    } catch(error) { storageError=error; }
    workspace=updated;
    $('rotate-recovery-key').value=''; $('rotate-dialog').close(); await loadWorkspaces(updated.id);
    toast(storageError ? 'Key changed. Browser storage could not be updated; keep the new recovery key safe. ' + errorMessage(storageError) : 'Key changed. Share the new key privately with remaining members.');
  },'rotate-status');
};
['workspace-dialog','rotate-dialog','unlock-dialog'].forEach(id=>{
  $(id).addEventListener('close',()=>{
    const input = id==='workspace-dialog'?'create-recovery-key':id==='rotate-dialog'?'rotate-recovery-key':'unlock-key';
    $(input).value=''; $(input).type='password';
  });
});
$('mfa-dialog').addEventListener('cancel',event=>event.preventDefault());
$('mfa-dialog').addEventListener('close',()=>{
  $('mfa-secret').value=''; $('mfa-code').value=''; $('mfa-qr').removeAttribute('src');
});
$('mfa-phone').onchange=()=>{
  mfaFactor=mfaChoices.find(factor=>factor.id===$('mfa-phone').value)?.id || null;
  $('mfa-code').value=''; $('mfa-status').textContent=''; $('mfa-verify').disabled=!mfaFactor;
};
$('mfa-enroll').onclick=()=>busy($('mfa-enroll'),async()=>{
  const expectedUser=user?.id, attempt=sessionGeneration;
  const data=result(await client.auth.mfa.enroll({factorType:'totp',issuer:'Together Calendar',friendlyName:'Together '+Date.now()}));
  if (user?.id!==expectedUser || attempt!==sessionGeneration || !$('mfa-dialog').open) return;
  mfaFactor=data.id;
  $('mfa-qr').src=authenticatorQr(data.totp.qr_code);
  $('mfa-secret').value=data.totp.secret; $('mfa-setup').hidden=false; $('mfa-enroll').hidden=true; $('mfa-verify').disabled=false;
},'mfa-status');
$('mfa-form').onsubmit=event=>{
  event.preventDefault();
  busy($('mfa-verify'),async()=>{
    if(!mfaFactor) throw new Error('Set up an authenticator first.');
    const pending = pendingDeviceUnlock, setup=pendingAuthenticatorSetup;
    const expectedUser=user?.id, attempt=sessionGeneration, factorId=mfaFactor;
    const code=$('mfa-code').value; $('mfa-code').value='';
    $('mfa-phone').disabled=true;
    try {
      if (setup) await setup.flow.authorize(factorId,code);
      else result(await client.auth.mfa.challengeAndVerify({factorId,code}));
    } finally { $('mfa-phone').disabled=false; }
    if (user?.id!==expectedUser || attempt!==sessionGeneration || !$('mfa-dialog').open) return;
    if (setup) {
      if (pendingAuthenticatorSetup!==setup) return;
      $('mfa-dialog').close();
      $('authenticator-form').reset(); $('authenticator-status').textContent='';
      $('authenticator-name').disabled=false; $('authenticator-generate').hidden=false;
      $('authenticator-code').disabled=true;
      $('authenticator-setup').hidden=true; $('authenticator-confirm').hidden=true;
      $('authenticator-dialog').showModal(); return;
    }
    if (pending) {
      if (pending.revision !== vaultRevision || pending.userId !== user?.id || workspace?.id !== pending.id) return;
      const current=result(await client.from('workspaces').select('*').eq('id',pending.id).maybeSingle());
      if (pending.revision !== vaultRevision || pending.userId !== user?.id || workspace?.id !== pending.id) return;
      pendingDeviceUnlock=null; $('mfa-dialog').close();
      if (!current) { lockVault(false); workspace=null; await loadWorkspaces(); return; }
      workspace=current; workspaces=workspaces.map(space=>space.id===current.id?current:space);
      let restored=false;
      try { restored=await restoreDeviceKey(current,pending.userId,pending.revision); }
      catch(error) { toast(errorMessage(error)); }
      if (pending.revision !== vaultRevision || pending.userId !== user?.id) return;
      if (!restored) { remembered.delete(current.id); render(); showUnlock(); return; }
      lastActivity=Date.now(); updateSpaceSelector(); await refresh(); toast('Space unlocked with the key remembered on this device.');
      return;
    }
    const data=result(await client.auth.getSession()); await enterSession(data.session);
  },'mfa-status');
};
$('mfa-signout').onclick=()=>busy($('mfa-signout'),async()=>{result(await client.auth.signOut());authView();});
function authenticatorQr(svg) {
  if(typeof svg!=='string' || (!svg.startsWith('<svg') && !svg.startsWith('data:image/svg+xml'))) throw new Error('Authenticator setup returned an invalid QR code.');
  return svg.startsWith('<svg')?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg):svg;
}
function clearAuthenticatorSetup() {
  const setup=pendingAuthenticatorSetup; pendingAuthenticatorSetup=null;
  $('authenticator-secret').value=''; $('authenticator-code').value=''; $('authenticator-qr').removeAttribute('src');
  if (setup) setup.flow.cancel().catch(()=>toast('The unfinished authenticator could not be removed. Existing verified phones still work; try setup again with a different phone name.'));
}
$('add-authenticator').onclick=()=>busy($('add-authenticator'),async()=>{
  if (!sessionReady || !user || demo) return;
  clearAuthenticatorSetup();
  const setup={flow:createAuthenticatorEnrollment(client.auth.mfa)};
  pendingAuthenticatorSetup=setup;
  try { await prepareMfa(); } catch(error) { if(pendingAuthenticatorSetup===setup)clearAuthenticatorSetup(); throw error; }
});
$('mfa-cancel').onclick=()=>{clearAuthenticatorSetup();$('mfa-dialog').close();};
$('authenticator-dialog').addEventListener('close',clearAuthenticatorSetup);
$('authenticator-dialog').addEventListener('cancel',event=>{
  if ($('authenticator-generate').disabled || $('authenticator-confirm').disabled) event.preventDefault();
});
$('authenticator-generate').onclick=()=>busy($('authenticator-generate'),async()=>{
  if (!$('authenticator-name').reportValidity()) return;
  const setup=pendingAuthenticatorSetup; if(!setup)return;
  $('authenticator-cancel').disabled=true;
  try {
    const data=await setup.flow.enroll($('authenticator-name').value);
    if (!data || setup!==pendingAuthenticatorSetup || !$('authenticator-dialog').open) return;
    $('authenticator-qr').src=authenticatorQr(data.totp.qr_code);
    $('authenticator-secret').value=data.totp.secret;
    $('authenticator-name').disabled=true; $('authenticator-generate').hidden=true;
    $('authenticator-setup').hidden=false; $('authenticator-confirm').hidden=false;
    $('authenticator-code').disabled=false;
    $('authenticator-code').focus();
  } finally { $('authenticator-cancel').disabled=false; }
},'authenticator-status');
$('authenticator-form').onsubmit=event=>{
  event.preventDefault();
  if ($('authenticator-setup').hidden) { $('authenticator-generate').click(); return; }
  busy($('authenticator-confirm'),async()=>{
    const setup=pendingAuthenticatorSetup; if(!setup)return;
    const code=$('authenticator-code').value; $('authenticator-code').value='';
    $('authenticator-cancel').disabled=true;
    try {
      if (!await setup.flow.verify(code) || setup!==pendingAuthenticatorSetup) return;
      $('authenticator-dialog').close();
      toast('Authenticator added. Either phone can now verify this account. Other devices may need to sign in again.');
    } finally { $('authenticator-cancel').disabled=false; }
  },'authenticator-status');
};
function showDeviceKey() {
  if (!workspace || demo) return;
  const saved=remembered.get(workspace.id)===workspace.key_epoch;
  $('device-key-description').textContent=saved ? 'This space’s key is remembered in this browser. It can unlock your plans after authenticator verification, including after signing in again.' : 'Remember this space’s key so you can unlock after authenticator verification without pasting the recovery key again.';
  $('remember-device-key').hidden=saved; $('remember-device-key').disabled=!keys.has(workspace.id);
  $('forget-device-key').hidden=!saved;
  $('device-key-status').textContent=!saved && !keys.has(workspace.id) ? 'Unlock this space with its recovery key first.' : '';
  $('device-key-dialog').showModal();
}
$('device-key').onclick=showDeviceKey;
$('remember-device-key').onclick=()=>busy($('remember-device-key'),async()=>{
  const space=workspace, cached=keys.get(space?.id), expectedUser=user?.id, revision=vaultRevision;
  if (!cached || cached.epoch!==space.key_epoch) throw new Error('Unlock this space first.');
  await rememberKey(space,cached.key,expectedUser);
  if (revision!==vaultRevision || user?.id!==expectedUser) return;
  $('device-key-dialog').close(); toast('This space’s key is now remembered on this device.');
},'device-key-status');
$('forget-device-key').onclick=()=>busy($('forget-device-key'),async()=>{
  await forgetKey(workspace); lockVault(false); toast('Saved key removed from this browser. Enter your recovery key to unlock again.');
},'device-key-status');
$('forget-device-keys').onclick=()=>busy($('forget-device-keys'),async()=>{
  if (!await confirmAction('Forget saved keys on this device?', 'Keep your recovery keys backed up. This removes this app’s saved keys from this browser. You will need those keys to unlock again.', 'Forget keys')) return;
  await deviceKeys.forgetAll(); remembered.clear(); lockVault(false);
  deviceChannel?.postMessage({action:'cleared'});
  toast('This app’s saved keys have been removed from this browser.');
});
if (deviceChannel) deviceChannel.onmessage=event=>{
  const message=event.data;
  if (!message || !['saved','forgot','cleared'].includes(message.action)) return;
  if (message.action==='cleared' || (message.action==='forgot' && message.userId===user?.id)) {
    // Queue removal behind any save already pending in this tab as well.
    const removal=message.action==='cleared' ? deviceKeys.forgetAll() : deviceKeys.forget(message.userId,message.id,message.epoch);
    removal.catch(error=>toast(errorMessage(error)));
    if (message.action==='cleared') remembered.clear();
    else if (remembered.get(message.id)===message.epoch) remembered.delete(message.id);
    if (!demo && user) { lockVault(false); toast('A saved key was removed in another tab. Your plans are locked.'); }
  } else if (message.action==='saved' && message.userId===user?.id) {
    remembered.set(message.id,message.epoch);
    if (!demo && user) render();
  }
};
['pointerdown','keydown'].forEach(event=>document.addEventListener(event,()=>{lastActivity=Date.now();},{passive:true}));
function checkIdle(){if(!demo && keys.size && Date.now()-lastActivity>5*60*1000) lockVault();}
setInterval(checkIdle,15000);
document.addEventListener('visibilitychange',()=>{checkIdle();if(!document.hidden)syncAutomatically();});
window.addEventListener('focus',()=>{checkIdle();syncAutomatically();});
window.addEventListener('online',syncAutomatically);
window.addEventListener('pagehide',()=>{if(!demo)lockVault(false);});
async function boot() {
  setAuthMode('signin');
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
if (window.self !== window.top) {
  document.body.replaceChildren();
  throw new Error('Open Together directly in its own browser tab.');
}
boot().catch(error => { $('auth-status').textContent = errorMessage(error); });
