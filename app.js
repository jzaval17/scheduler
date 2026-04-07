// ── State ──────────────────────────────────────────────────────────
const ZONE_MAX = { checklanes: 10, sco: 2, service: 1, driveup: 5 };
const TOTAL_ON_BREAK_MAX = 3; // overall max people on break before critical warning
const ZONE_LABELS = { checklanes: 'Checklanes', sco: 'SCO', service: 'Service Desk', driveup: 'Drive Up' };
const BREAK_DUR = { break: 15, lunch: 45, lunch60: 60 };
const LUNCH_WARN_MIN = 10; // minutes before the 5-hour mark to warn about lunch
const NOTE_PREVIEW_LEN = 120;
// How soon (ms) before a scheduled break/lunch to mark 'due soon' on cards
const UPCOMING_SOON_MS = 15 * 60 * 1000; // 15 minutes

// The Anthropic API key is no longer stored in the client. Requests
// are proxied to a server-side function at `/api/anthropic` which reads
// the key from server environment variables (e.g. Vercel Environment Variables).

let people = [];
let alerts = [];
let alertIdCounter = 0;
let toastTimer = null;
let activeTab = 'board';
let lastAction = null;
let undoTimer = null;
let inlineEditId = null;
let showOffline = localStorage.getItem('bm_show_offline') !== 'false';

function loadState() {
  try {
    const saved = localStorage.getItem('bm_people');
    if (saved) people = JSON.parse(saved);
    // Migrate older flat-break entries (no `breaks`) into new person -> breaks model
    if (people.length > 0 && !people[0].breaks) {
      const map = new Map();
      people.forEach(old => {
        const name = (old.name || '').trim();
        const zone = old.zone || 'checklanes';
        if (!name) return;
        const key = name + '||' + zone;
        if (!map.has(key)) map.set(key, { id: uid(), name, zone, role: old.role || '', breaks: [] });
        const person = map.get(key);
        const b = {
          id: uid(),
          type: old.type || 'break',
          scheduledMs: old.scheduledMs || null,
          scheduledTime: old.scheduledTime || (old.scheduledMs ? fmtTime(old.scheduledMs) : ''),
          status: (old.startMs ? 'active' : (old.status === 'overdue' ? 'overdue' : 'scheduled')),
          startMs: old.startMs ? Number(old.startMs) : null,
          dur: BREAK_DUR[old.type] || 15
        };
        person.breaks.push(b);
      });
      people = Array.from(map.values());
    }
    // Normalize numeric startMs and sync statuses
    people.forEach(p => {
      if (p.startMs) p.startMs = Number(p.startMs);
      if (p.breaks) p.breaks.forEach(b => { if (b.startMs) b.startMs = Number(b.startMs); });
      syncPersonStatus(p);
    });
  } catch(e) { people = []; }
}

function sanitizePeople() {
  if (!Array.isArray(people)) people = [];
  people = people.map(p => {
    if (!p) return null;
    if (!p.id) p.id = uid();
    p.name = (p.name || '').trim();
    p.zone = p.zone || 'checklanes';
    p.role = p.role || '';
    p.breaks = Array.isArray(p.breaks) ? p.breaks.map(b => {
      if (!b) return null;
      if (!b.id) b.id = uid();
      b.type = b.type || 'break';
      if (!b.scheduledMs && b.scheduledTime) {
        const parsed = parseMilTime(b.scheduledTime);
        if (parsed) b.scheduledMs = parsed.getTime();
      }
      b.scheduledMs = b.scheduledMs ? Number(b.scheduledMs) : null;
      b.scheduledTime = b.scheduledTime || (b.scheduledMs ? fmtTime(b.scheduledMs) : '');
      b.status = b.status || 'scheduled';
      b.startMs = b.startMs ? Number(b.startMs) : null;
      b.dur = b.dur || (b.type === 'lunch' ? BREAK_DUR['lunch'] : BREAK_DUR['break']);
      return b;
    }).filter(Boolean) : [];
    p.shiftStartMs = p.shiftStartMs ? Number(p.shiftStartMs) : null;
    p.shiftEndMs = p.shiftEndMs ? Number(p.shiftEndMs) : null;
    p.startMs = p.startMs ? Number(p.startMs) : null;
    p.absent = !!p.absent; p.clockedOut = !!p.clockedOut; p.late = !!p.late;
    syncPersonStatus(p);
    return p;
  }).filter(Boolean);
}

function saveState() {
  try { sanitizePeople(); localStorage.setItem('bm_people', JSON.stringify(people)); } catch(e) {}
}

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function isActive(p) {
  if (!p) return false;
  if (p.absent) return false;
  return p.status === 'break' || p.status === 'lunch' || p.status === 'overdue';
}
function getElapsedMin(p) {
  if (!p.startMs) return 0;
  return Math.floor((Date.now() - p.startMs) / 60000);
}
function getDur(p) { return BREAK_DUR[p.type] || 15; }
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function uid() { return Date.now() + Math.random().toString(36).slice(2, 7); }

// Helpers for new data model: people have `breaks` array. Each break: { id, type, scheduledMs, scheduledTime, status: 'scheduled'|'active'|'overdue'|'done', startMs, dur }
function syncPersonStatus(person) {
  if (!person || !person.breaks) return;
  // Respect manual clock-out state
  if (person.clockedOut) {
    person.status = 'clocked_out';
    person.type = null;
    person.startMs = null;
    return;
  }
  const now = Date.now();
  const active = person.breaks.find(b => b.status === 'active' || b.status === 'overdue');
  if (active) {
    person.status = active.status === 'overdue' ? 'overdue' : (active.type === 'break' ? 'break' : 'lunch');
    person.type = active.type;
    person.startMs = active.startMs || null;
  } else if (person.shiftStartMs && now < person.shiftStartMs) {
    // Shift hasn't started yet — not here / unavailable
    person.status = 'not_here';
    person.type = null;
    person.startMs = null;
  } else {
    person.status = 'available';
    person.type = null;
    person.startMs = null;
  }
}

function getNextScheduledBreak(person) {
  if (!person || !person.breaks) return null;
  const now = Date.now();
  // Ensure scheduledMs is populated when possible by parsing scheduledTime
  person.breaks.forEach(b => {
    if ((!b.scheduledMs || b.scheduledMs === null) && b.scheduledTime) {
      const parsed = parseMilTime(b.scheduledTime);
      if (parsed) {
        let parsedMs = parsed.getTime();
        // If the person has an explicit shift start, align scheduled time to that shift's date
        if (person.shiftStartMs) {
          try {
            const shiftDate = new Date(person.shiftStartMs);
            // set hours/minutes from parsed
            shiftDate.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0);
            parsedMs = shiftDate.getTime();
            // if parsed time ended up before shiftStart, assume next day
            if (parsedMs < person.shiftStartMs) parsedMs += 24 * 3600000;
          } catch (e) {}
        } else {
          // If no shift start, prefer future times: if parsed time appears sufficiently in the past,
          // assume it's for the next day (user-entered schedule for tomorrow).
          if (parsed.getTime() < (Date.now() - (6 * 3600000))) {
            parsedMs = parsed.getTime() + 24 * 3600000;
          } else parsedMs = parsed.getTime();
        }
        // set scheduledMs for future comparisons (mutates the object permanently)
        b.scheduledMs = parsedMs;
      }
    }
  });
  const scheduled = person.breaks.filter(b => b.status === 'scheduled' && b.scheduledMs && b.scheduledMs > now);
  if (scheduled.length === 0) return null;
  scheduled.sort((a, b) => a.scheduledMs - b.scheduledMs);
  return scheduled[0];
}

// Mark the next active/overdue or due scheduled break as done for a person
function markBreakDone(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const now = Date.now();
  if (p.breaks && p.breaks.length > 0) {
    // Prefer active or overdue
    let target = p.breaks.find(b => b.status === 'active' || b.status === 'overdue');
    if (!target) {
      // Find the next scheduled that is due
      const due = p.breaks.filter(b => b.status === 'scheduled' && b.scheduledMs && b.scheduledMs <= now);
      if (due.length > 0) {
        due.sort((a, b) => b.scheduledMs - a.scheduledMs); // most recent due
        target = due[0];
      }
    }
    if (target) {
      // record previous state for undo
      const prev = { status: target.status, startMs: target.startMs };
      target.status = 'done';
      if (!target.startMs && target.scheduledMs) target.startMs = target.scheduledMs;
      syncPersonStatus(p);
      saveState();
      // cancel any scheduled notification for this break
      cancelScheduledNotification('trigger:' + target.id);
      pushUndo({ action: 'markBreakDone', personId: p.id, breakId: target.id, prev, message: `${p.name} — ${target.type} marked taken` });
      showToast(`${p.name} — ${target.type} marked taken`);
      render();
    }
  }
}

// Compute paid hours for a shift excluding lunches (in hours, 1 decimal)
function computePaidHours(person) {
  if (!person || !person.shiftStartMs || !person.shiftEndMs) return null;
  const totalMs = Math.max(0, person.shiftEndMs - person.shiftStartMs);
  let lunchMs = 0;
  if (person.breaks && person.breaks.length > 0) {
    person.breaks.forEach(b => { if (b.type === 'lunch') lunchMs += (b.dur || BREAK_DUR['lunch']) * 60000; });
  } else {
    // fallback: if person.type is lunch and dur around
    if (person.type === 'lunch') lunchMs = (person.dur || BREAK_DUR['lunch']) * 60000;
  }
  const paidMs = Math.max(0, totalMs - lunchMs);
  const hours = Math.round((paidMs / 3600000) * 10) / 10;
  return hours;
}


// ── Parse military / short time strings ─────────────────────────────
function parseMilTime(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str || str === '-' || str === '') return null;

  // Has AM/PM already
  const ampmMatch = str.match(/^(\d+):?(\d{2})?\s*(AM|PM)$/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1]);
    const m = parseInt(ampmMatch[2] || '0');
    const ap = ampmMatch[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    const d = new Date(); d.setHours(h, m, 0, 0);
    return d;
  }

  const num = str.replace(/[^0-9]/g, '');
  if (!num) return null;

  let h, m;
  if (num.length <= 2) {
    h = parseInt(num); m = 0;
  } else if (num.length === 3) {
    h = parseInt(num[0]); m = parseInt(num.slice(1));
  } else {
    h = parseInt(num.slice(0, 2)); m = parseInt(num.slice(2));
  }
  // Times < 7 are likely PM (2=2PM, 3=3PM, 530=5:30PM, 630=6:30PM, 715=7:15PM, 815=8:15PM)
  if (h < 7) h += 12;
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d;
}

function fmtParsedTime(raw) {
  const d = parseMilTime(raw);
  if (!d) return null;
  return { display: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), ms: d.getTime() };
}

// ── Auto-assign zone from task string ───────────────────────────────
function inferZone(taskStr) {
  if (!taskStr) return null;
  const t = taskStr.toUpperCase();
  if (/SCO|SELF.?CHECK/.test(t)) return 'sco';
  if (/DRIVE.?UP|OPU|FULFILLMENT|G.?ATTEND|GUEST.?ATTEND/.test(t)) return 'driveup';
  if (/SERVICE.?DESK|GUEST.?SERVICE|\bGS\b|CASH.?OFFICE/.test(t)) return 'service';
  if (/\bCL\b|CHECKLANE|FRONT.?END|\bPS\b/.test(t)) return 'checklanes';
  return null;
}

// ── Clock ────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const t = document.getElementById('topbar-time');
  const d = document.getElementById('topbar-date');
  if (t) t.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d) d.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Tick ─────────────────────────────────────────────────────────────
function tick() {
  let changed = false;
  const now = Date.now();
  people.forEach(p => {
    if (!p.breaks) return;
    if (p.clockedOut || p.absent) {
      // Skip active break checks for manually clocked-out people or absent team members
      p.clockOutOverdue = false; p.shouldClockOut = false; syncPersonStatus(p); return;
    }
    p.breaks.forEach(b => {
      if (b.status === 'active' && b.startMs) {
        const elapsed = Math.floor((now - b.startMs) / 60000);
        const dur = b.dur || (b.type === 'break' ? 15 : 30);
        if (elapsed >= dur) {
          b.status = 'overdue'; changed = true;
          pushAlert({ type: 'urgent', msg: `${p.name} is overdue from ${b.type} — ${ZONE_LABELS[p.zone]}`, personId: p.id });
        }
      }
    });
    // If shift hasn't started yet, skip shift-end and lunch checks
    if (p.status === 'not_here') { p.clockOutOverdue = false; p.shouldClockOut = false; syncPersonStatus(p); return; }
    // Check shift end (clock-out) status
    if (p.shiftEndMs) {
      if (now > p.shiftEndMs) {
        // Person's shift has ended
        if (p.status !== 'available') {
          p.clockOutOverdue = true; // still on break/lunch after shift end
          p.shouldClockOut = false;
          pushAlert({ id: 'clockout-overdue-' + p.id, type: 'urgent', msg: `${p.name} is overdue to clock out — shift ended ${fmtTime(p.shiftEndMs)}`, personId: p.id });
        } else {
          // Shift ended and person is available (not on break) — should clock out
          p.shouldClockOut = true;
          p.clockOutOverdue = false;
          pushAlert({ id: 'clockout-due-' + p.id, type: 'info', msg: `${p.name} should clock out — shift ended ${fmtTime(p.shiftEndMs)}`, personId: p.id });
        }
      } else {
        p.clockOutOverdue = false; p.shouldClockOut = false;
      }
    } else {
      p.clockOutOverdue = false; p.shouldClockOut = false;
    }
    // Lunch warning: if shiftStart exists and no lunch taken, warn when close to 5-hour mark
    if (p.shiftStartMs) {
      const fiveHourMs = p.shiftStartMs + 5 * 3600000;
      const warnWindowStart = fiveHourMs - (LUNCH_WARN_MIN * 60000);
      const nowLocal = Date.now();
      const hasLunch = (p.breaks || []).some(b => b.type === 'lunch' && (b.status === 'done' || b.status === 'active' || b.status === 'overdue'));
      if (!hasLunch && nowLocal >= warnWindowStart && nowLocal < fiveHourMs) {
        const id = 'lunch-warn-' + p.id;
        pushAlert({ id, type: 'info', msg: `${p.name} is approaching 5 hours — consider sending to lunch`, personId: p.id });
        try {
          if (window.Notification && Notification.permission === 'granted') {
            window.__sentNotifications = window.__sentNotifications || new Set();
            if (!window.__sentNotifications.has(id)) {
              new Notification('Send to lunch', { body: `${p.name} is close to 5 hours — consider sending to lunch`, tag: id });
              window.__sentNotifications.add(id);
            }
          }
        } catch (e) {}
      }
    }
    syncPersonStatus(p);
  });
  if (changed) saveState();
  render();
}

// ── Rendering ─────────────────────────────────────────────────────────
function render() {
  renderShiftTimeline(); renderBoard(); renderStats(); renderCoverage(); renderAlerts(); renderAlertBanner(); updateClock();
}

function renderBoard() {
  const zones = ['checklanes', 'sco', 'service', 'driveup'];
  document.getElementById('board-empty')?.classList.toggle('hidden', people.length > 0);

  zones.forEach(zone => {
    const list = document.getElementById('list-' + zone);
    const pill = document.getElementById('pill-' + zone);
    if (!list) return;

    const zp = people.filter(p => p.zone === zone);
    const onBreak = zp.filter(p => isActive(p)).length;
    const max = ZONE_MAX[zone];

    if (pill) {
      const overdueCount = zp.filter(p => p.status === 'overdue').length;
      if (overdueCount > 0) { pill.textContent = `${overdueCount} overdue!`; pill.className = 'zone-pill pill-overdue'; }
      else if (onBreak > max) { pill.textContent = `${onBreak}/${max} — over limit`; pill.className = 'zone-pill pill-danger'; }
      else if (onBreak === max) { pill.textContent = `${onBreak}/${max} — at limit`; pill.className = 'zone-pill pill-warn'; }
      else { pill.textContent = `${onBreak}/${max} on break`; pill.className = 'zone-pill pill-ok'; }
    }

    list.innerHTML = '';
    if (zp.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty-small'; em.textContent = 'No team members in this zone.';
      list.appendChild(em); return;
    }

    const order = { overdue: 0, break: 1, lunch: 2, available: 3, not_here: 4 };
    [...zp].sort((a, b) => {
      // Absent and clocked out should appear at the bottom
      if (a.absent && !b.absent) return 1;
      if (!a.absent && b.absent) return -1;
      if (a.clockedOut && !b.clockedOut) return 1;
      if (!a.clockedOut && b.clockedOut) return -1;
      const oa = order[a.status] ?? 3;
      const ob = order[b.status] ?? 3;
      if (oa === ob) return (a.name || '').localeCompare(b.name || '');
      return oa - ob;
    }).forEach(p => {
      // If hiding offline, skip absent/clocked-out persons in the board list
      if (!showOffline && (p.absent || p.clockedOut)) return;
      // Determine active break or next scheduled
      const activeBreak = p.breaks ? p.breaks.find(b => b.status === 'active' || b.status === 'overdue') : null;
      const next = getNextScheduledBreak(p);
      let avClass = 'av-available', sbClass = 'sb-available', sbLabel = 'Available';
      let timerText = '';
      let soonFlag = false;

      if (activeBreak) {
        const elapsed = activeBreak.startMs ? Math.floor((Date.now() - activeBreak.startMs) / 60000) : 0;
        const dur = activeBreak.dur || (activeBreak.type === 'break' ? 15 : 30);
        const remaining = dur - elapsed;
        if (activeBreak.status === 'overdue') {
          avClass = 'av-overdue'; sbClass = 'sb-overdue'; sbLabel = 'Overdue!'; timerText = `+${Math.abs(remaining)} min overdue`;
        } else if (activeBreak.type === 'break') {
          avClass = 'av-break'; sbClass = 'sb-break'; sbLabel = `${BREAK_DUR['break']}-min break`; timerText = remaining > 0 ? `${remaining} min left` : 'time up';
        } else {
          avClass = 'av-lunch'; sbClass = 'sb-lunch'; sbLabel = `${dur}-min lunch`; timerText = remaining > 0 ? `${remaining} min left` : 'time up';
        }
      }
      else if (p.status === 'clocked_out') {
        // show clocked out in the small status badge
        sbClass = 'sb-upcoming';
        sbLabel = 'Clocked out';
      }
      else if (p.status === 'not_here') {
        sbClass = 'sb-upcoming';
        sbLabel = 'Not here';
      }
      if (p.absent) { sbLabel = 'Absent'; sbClass = 'sb-upcoming'; }

      // If person is available, show next scheduled time or mark 'due soon' when within UPCOMING_SOON_MS
      if (!activeBreak && p.status === 'available' && next && next.scheduledMs) {
        const delta = next.scheduledMs - Date.now();
        if (delta > 0 && delta <= UPCOMING_SOON_MS) {
          const mins = Math.max(1, Math.round(delta / 60000));
          sbClass = 'sb-soon';
          sbLabel = `${next.type === 'lunch' ? 'Lunch' : 'Break'} due in ${mins}m`;
          timerText = `${mins}m until ${next.type === 'lunch' ? 'lunch' : 'break'}`;
          soonFlag = true;
        } else {
          timerText = `Next: ${next.scheduledTime || ''}`;
        }
      } else if (!activeBreak && next) {
        timerText = `Next: ${next.scheduledTime || ''}`;
      }

      // removed taken checkmark -- using compact break dots instead
      const takenHtml = '';
      const lateHtml = p.late ? '<span class="person-flag late">Late</span>' : '';
      const absentHtml = p.absent ? '<span class="person-flag absent">Absent</span>' : '';
      let clockOutHtml = '';
      if (p.clockOutOverdue) clockOutHtml = '<span class="person-flag absent">Overtime</span>';
      else if (p.shouldClockOut) clockOutHtml = '<span class="person-flag late">Clock out</span>';
      // Availability sign: always show, with color variant based on current status
      let availClass = 'avail-available';
      if (p.status === 'break') availClass = 'avail-break';
      else if (p.status === 'lunch') availClass = 'avail-lunch';
      else if (p.status === 'overdue') availClass = 'avail-overdue';
      else if (p.status === 'not_here') availClass = 'avail-not-here';
      // Display proper availability label: absent or on break/lunch/overdue/not here are unavailable
      let availLabel = 'Available';
      if (p.absent) { availLabel = 'Unavailable'; availClass = 'avail-absent'; }
      else if (p.status === 'break' || p.status === 'lunch' || p.status === 'overdue') { availLabel = 'Unavailable'; }
      else if (p.status === 'not_here') { availLabel = 'Not here'; }
      else if (p.status === 'clocked_out') { availLabel = 'Clocked out'; availClass = 'avail-not-here'; }
      const availHtml = `<span class="avail-sign ${availClass}">${availLabel}</span>`;
      const shiftLine = (p.shiftStartMs && p.shiftEndMs) ? `${fmtTime(p.shiftStartMs)} — ${fmtTime(p.shiftEndMs)}` : '';
      const paid = computePaidHours(p);
      const paidHtml = (paid !== null && paid !== undefined) ? `<div class="person-shift">${shiftLine} · ${paid} hrs</div>` : (shiftLine ? `<div class="person-shift">${shiftLine}</div>` : '');

      // Build compact per-break indicators (small dots) to reduce visual clutter
      let breakBadges = '';
      if (p.breaks && p.breaks.length > 0) {
        const sorted = [...p.breaks].slice().sort((a, b) => (a.scheduledMs || 0) - (b.scheduledMs || 0));
        const dots = sorted.map(b => {
          let cls = 'br-sched';
          if (b.status === 'done') cls = 'br-done';
          else if (b.status === 'active') cls = 'br-active';
          else if (b.status === 'overdue') cls = 'br-overdue';
          const label = b.type === 'lunch' ? 'Lunch' : '';
          const title = `${label} ${b.scheduledTime || ''}`.trim();
          return `<span class="break-dot ${cls}" title="${escapeHtml(title)}"></span>`;
        }).join('');
        breakBadges = `<div class="break-dots" aria-hidden="true">${dots}</div>`;
      }

      const card = document.createElement('div');
      card.className = 'person-card' + (p.status === 'overdue' ? ' overdue' : '');
        // Note display or inline editor
        let noteHtml = '';
        if (p.note) {
          const full = escapeHtml(p.note);
          if (full.length <= NOTE_PREVIEW_LEN) {
            noteHtml = `<div class="inline-note">${full}</div>`;
          } else if (p.noteExpanded) {
            noteHtml = `<div class="inline-note">${full} <a class="note-toggle" href="#" onclick="event.stopPropagation();toggleNoteExpand('${p.id}');return false;">Show less</a></div>`;
          } else {
            const preview = full.slice(0, NOTE_PREVIEW_LEN) + '…';
            noteHtml = `<div class="inline-note">${preview} <a class="note-toggle" href="#" onclick="event.stopPropagation();toggleNoteExpand('${p.id}');return false;">Show more</a></div>`;
          }
        }
        let editorHtml = '';
        if (inlineEditId === p.id) {
          editorHtml = `<div class="inline-editor"><textarea id="inline-note-${p.id}">${p.note||''}</textarea><div style="display:flex;flex-direction:column;gap:6px;"><button class="btn-primary" onclick="event.stopPropagation();saveInline('${p.id}')">Save</button><button class="btn-secondary" onclick="event.stopPropagation();cancelInline()">Cancel</button></div></div>`;
        }

        const editActions = `<button class="btn-tiny" onclick="event.stopPropagation();openModal('${p.id}')">Edit</button>`;
        const clockOutBtn = (!p.clockedOut && !p.absent && (p.status === 'available' || p.shouldClockOut || p.clockOutOverdue)) ? `<button class="btn-tiny btn-warn" onclick="event.stopPropagation();manualClockOut('${p.id}')">Clock out</button>` : '';
        // Core quick actions only — late/absent/note moved into modal
        let primaryBtn = '';
        if (isActive(p)) {
          primaryBtn = `<button class="btn-tiny btn-ok" onclick="event.stopPropagation();markReturned('${p.id}')">Returned</button>`;
        } else if (next && next.scheduledMs && next.scheduledMs <= Date.now() && p.status !== 'not_here') {
          primaryBtn = `<button class="btn-tiny btn-warn" onclick="event.stopPropagation();markBreakDone('${p.id}')">Mark taken</button>`;
        } else if (p.status === 'available' && !p.absent) {
          primaryBtn = `<button class="btn-tiny" onclick="event.stopPropagation();startBreak('${p.id}','break')">Send break</button>`;
        }
        const actions = `<div class="card-actions">${primaryBtn}${clockOutBtn}${editActions}</div>`;

        // Add an upbeat animation class when a break is actively running
        const animClass = (activeBreak && activeBreak.status === 'active') ? ' active-anim' : '';
        const soonClass = soonFlag ? ' soon' : '';
        const overdueMin = (activeBreak && activeBreak.status === 'overdue' && activeBreak.startMs)
          ? Math.max(1, Math.floor((Date.now() - activeBreak.startMs) / 60000) - (activeBreak.dur || 15))
          : 0;
        const avatarHtml = overdueMin > 0
          ? `<div class="avatar-wrap"><div class="avatar ${avClass}${animClass}">${initials(p.name)}</div><span class="overdue-badge">+${overdueMin}m</span></div>`
          : `<div class="avatar ${avClass}${animClass}">${initials(p.name)}</div>`;
        card.innerHTML = `${avatarHtml}<div class="person-info"><div class="person-name">${availHtml} ${p.name} ${takenHtml} ${lateHtml} ${absentHtml} ${clockOutHtml}</div>${breakBadges}${paidHtml}<div class="person-timer${p.status === 'overdue' ? ' overdue' : ''}">${timerText}</div>${noteHtml}${editorHtml}${actions}</div><span class="status-badge ${sbClass}">${sbLabel}</span>`;
        if (soonFlag) card.classList.add('soon');
        if (p.clockedOut) card.classList.add('clocked-out');
        card.onclick = () => openModal(p.id);
      list.appendChild(card);
    });
  });
}

// Inline edit helpers
function startInline(personId) {
  inlineEditId = personId;
  render();
}
function cancelInline() { inlineEditId = null; render(); }
function saveInline(personId) {
  const el = document.getElementById('inline-note-' + personId);
  if (!el) { cancelInline(); return; }
  const p = people.find(x => x.id === personId);
  if (!p) return;
  p.note = el.value.trim();
  inlineEditId = null; saveState(); showToast('Note saved'); render();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function(m) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]; });
}

function toggleNoteExpand(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  p.noteExpanded = !p.noteExpanded;
  saveState(); render();
}

function renderStats() {
  let avail = 0, onBreak = 0, overdue = 0, upcoming = 0, notHere = 0, absentCount = 0;
  const now = Date.now();
  const soon = 20 * 60000;
  people.forEach(p => {
    if (p.status === 'overdue') overdue++;
    else if (p.status === 'break' || p.status === 'lunch') onBreak++;
    else if (p.status === 'not_here') notHere++;
    else if (p.absent) {
      absentCount++;
    } else if (p.status === 'available') {
      // Only count truly available people (not absent and not manually clocked out)
      if (!p.absent && !p.clockedOut) {
        avail++;
        const next = getNextScheduledBreak(p);
        if (next && (next.scheduledMs - now) < soon && (next.scheduledMs - now) > 0) upcoming++;
      }
    }
  });
  const s = id => document.getElementById(id);
  if (s('stat-available')) s('stat-available').textContent = avail;
  if (s('stat-onbreak'))   s('stat-onbreak').textContent = onBreak;
  if (s('stat-overdue'))   s('stat-overdue').textContent = overdue;
  if (s('stat-upcoming'))  s('stat-upcoming').textContent = upcoming;
  // Optionally show not-here count in the UI by reusing stat-overdue slot when needed
  const notHereEl = document.getElementById('stat-not-here');
  if (notHereEl) notHereEl.textContent = notHere;
  // Update optional absent stat if present
  const absentEl = document.getElementById('stat-absent');
  if (absentEl) absentEl.textContent = absentCount;
}

function renderCoverage() {
  const active = people.filter(p => isActive(p)).length;
  const total = Math.max(1, TOTAL_ON_BREAK_MAX);
  const pct = Math.round((active / total) * 100);
  const overLimit = active > TOTAL_ON_BREAK_MAX;
  const label = overLimit ? 'too many out' : (pct >= 40 ? 'too many out' : pct >= 25 ? 'caution' : 'ok');
  const cls = overLimit ? 'cov-danger' : (pct >= 40 ? 'cov-danger' : pct >= 25 ? 'cov-warn' : 'cov-ok');
  const bfill = overLimit ? 'bfill-danger' : (pct >= 40 ? 'bfill-danger' : pct >= 25 ? 'bfill-warn' : 'bfill-ok');

  const badge = document.getElementById('cov-total-badge');
  const bar = document.getElementById('cov-bar');
  const pctLbl = document.getElementById('cov-pct-label');
  if (badge) { badge.textContent = `${active} / ${TOTAL_ON_BREAK_MAX}`; badge.className = 'cov-badge ' + cls; }
  if (bar) { bar.style.width = Math.min(pct, 100) + '%'; bar.className = 'bar-fill ' + bfill; }
  if (pctLbl) pctLbl.textContent = `${pct}% — ${label}`;

  Object.keys(ZONE_MAX).forEach(zone => {
    const onBreak = people.filter(p => p.zone === zone && isActive(p)).length;
    const total = people.filter(p => p.zone === zone && !p.absent && !p.clockedOut).length;
    const tile = document.getElementById('ztile-' + zone);
    const cntEl = document.getElementById('zcnt-' + zone);
    const maxEl = tile ? tile.querySelector('.zone-tile-max') : null;
    if (cntEl) cntEl.textContent = total;
    if (maxEl) maxEl.textContent = onBreak > 0 ? `${onBreak} on break · max ${ZONE_MAX[zone]} at once` : `max ${ZONE_MAX[zone]} at once`;
    if (tile) tile.className = 'zone-tile' + (onBreak > ZONE_MAX[zone] ? ' over' : '');
  });

  // If overall on-break exceeds TOTAL_ON_BREAK_MAX, make coverage bar red
  if (active > TOTAL_ON_BREAK_MAX) {
    const covNote = document.getElementById('cov-pct-label');
    if (covNote) covNote.textContent = `${active}/${TOTAL_ON_BREAK_MAX} — too many out`;
  }

  const now = Date.now();
  const upcoming = people.map(p => ({ p, next: getNextScheduledBreak(p) }))
    .filter(x => x.p.status === 'available' && x.next && x.next.scheduledMs && (x.next.scheduledMs - now) < 20*60000 && (x.next.scheduledMs - now) > 0)
    .sort((a, b) => a.next.scheduledMs - b.next.scheduledMs);
  const upEl = document.getElementById('upcoming-list');
  if (upEl) {
    upEl.innerHTML = upcoming.length === 0
      ? '<div class="empty-small">No upcoming breaks in the next 20 minutes.</div>'
      : upcoming.map(x => {
          const minsUntil = Math.round((x.next.scheduledMs - now) / 60000);
          return `<div class="upcoming-card"><div class="avatar av-break">${initials(x.p.name)}</div><div class="person-info"><div class="person-name">${x.p.name}</div><div class="person-detail">${ZONE_LABELS[x.p.zone]} — ${x.next.type === 'break' ? `${BREAK_DUR['break']}-min break` : `${BREAK_DUR['lunch']}-min lunch`}</div></div><span class="status-badge sb-upcoming">in ${minsUntil}m</span></div>`;
        }).join('');
  }
}

function renderAlerts() {
  const el = document.getElementById('alerts-inner');
  if (!el) return;
  alerts = alerts.filter(a => Date.now() - a.ts < 60*60000);
  // Cap completed (ok) entries so they don't pile up
  const okEntries = alerts.filter(a => a.type === 'ok').slice(0, 20);
  alerts = [...alerts.filter(a => a.type !== 'ok'), ...okEntries];

  const liveAlerts = [];
  const activeCount = people.filter(p => isActive(p)).length;
  if (activeCount > TOTAL_ON_BREAK_MAX) {
    liveAlerts.push({ id: 'total-over', type: 'urgent',
      msg: `${activeCount} people on break — max is ${TOTAL_ON_BREAK_MAX}`,
      actions: [{ label: 'View coverage', fn: "switchTab('coverage')" }] });
  }

  people.filter(p => p.status === 'overdue').forEach(p => {
    const over = getElapsedMin(p) - getDur(p);
    liveAlerts.push({ id: 'overdue-' + p.id, type: 'urgent',
      msg: `${p.name} is ${over} min overdue from ${p.type} — ${ZONE_LABELS[p.zone]}`,
      actions: [{ label: 'Mark returned', fn: `markReturned('${p.id}')` }] });
  });
  // Shift end (clock-out) alerts
  people.forEach(p => {
    if (p.shiftEndMs && Date.now() > p.shiftEndMs) {
      if (p.status !== 'available') {
        liveAlerts.push({ id: 'clockout-overdue-' + p.id, type: 'urgent',
          msg: `${p.name} is overdue to clock out — shift ended ${fmtTime(p.shiftEndMs)}`,
          actions: [{ label: 'Clock out', fn: `manualClockOut('${p.id}')` }] });
      } else {
        liveAlerts.push({ id: 'clockout-due-' + p.id, type: 'info',
          msg: `${p.name} should clock out — shift ended ${fmtTime(p.shiftEndMs)}`,
          actions: [{ label: 'Clock out', fn: `manualClockOut('${p.id}')` }] });
      }
    }
  });
  Object.keys(ZONE_MAX).forEach(zone => {
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    if (cnt > ZONE_MAX[zone]) liveAlerts.push({ id: 'zone-' + zone, type: 'urgent',
      msg: `${cnt} people on break in ${ZONE_LABELS[zone]} — max is ${ZONE_MAX[zone]}`,
      actions: [{ label: 'View coverage', fn: "switchTab('coverage')" }] });
  });
  const now = Date.now();
  people.forEach(p => {
    const next = getNextScheduledBreak(p);
    if (p.status === 'available' && next && next.scheduledMs && (next.scheduledMs - now) < 15*60000 && (next.scheduledMs - now) > 0) {
      const m = Math.round((next.scheduledMs - now) / 60000);
      liveAlerts.push({ id: 'upcoming-' + p.id, type: 'info',
        msg: `${p.name}'s ${next.type === 'break' ? 'break' : 'lunch'} is due in ${m} min — ${ZONE_LABELS[p.zone]} (${next.scheduledTime})` });
    }
  });
  liveAlerts.push(...alerts.filter(a => a.type === 'ok'));

  const urgentCount = liveAlerts.filter(a => a.type === 'urgent').length;
  const badge = document.getElementById('alert-count');
  if (badge) { badge.textContent = urgentCount; badge.classList.toggle('hidden', urgentCount === 0); }
  // Toggle topbar notification bell and count
  const notifBtn = document.getElementById('notif-btn');
  const notifCount = document.getElementById('notif-count');
  if (notifBtn) {
    notifBtn.classList.toggle('hidden', liveAlerts.length === 0);
    if (notifCount) {
      notifCount.textContent = String(liveAlerts.length || '');
      notifCount.classList.toggle('hidden', liveAlerts.length === 0);
    }
  }

  if (liveAlerts.length === 0) { el.innerHTML = '<div class="empty-small">No active alerts. All good!</div>'; return; }
  el.innerHTML = liveAlerts.map(a => {
    const ts = a.ts ? fmtTime(a.ts) : '';
    const acts = (a.actions || []).map(act => `<button class="btn-tiny" onclick="${act.fn}">${act.label}</button>`).join('');
    return `<div class="alert-item ${a.type}"><div class="alert-dot2 ad-${a.type}"></div><div class="alert-body"><div class="alert-msg">${a.msg}</div>${ts ? `<div class="alert-ts">${ts}</div>` : ''}${acts ? `<div class="alert-actions">${acts}</div>` : ''}</div></div>`;
  }).join('');
}

function renderAlertBanner() {
  const overdue = people.filter(p => p.status === 'overdue');
  const zoneOver = Object.keys(ZONE_MAX).some(zone => people.filter(p => p.zone === zone && isActive(p)).length > ZONE_MAX[zone]);
  const clockOutOver = people.some(p => p.clockOutOverdue);
  const banner = document.getElementById('alert-banner');
  const text = document.getElementById('alert-text');
  if (!banner) return;
  if (overdue.length > 0) { banner.classList.remove('hidden'); text.textContent = `${overdue[0].name} is overdue from ${overdue[0].type} — tap for details`; }
  else if (clockOutOver) { banner.classList.remove('hidden'); const p = people.find(x => x.clockOutOverdue); text.textContent = `${p.name} is overdue to clock out — tap for details`; }
  else if (zoneOver) { banner.classList.remove('hidden'); text.textContent = 'Coverage alert: too many on break in a zone'; }
  else { banner.classList.add('hidden'); }
}

// ── Tabs ──────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ['board','coverage','upload','alerts'].forEach(t => {
    document.getElementById('view-' + t)?.classList.toggle('active', t === tab);
    document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
  });
  render();
}

// ── Modal ─────────────────────────────────────────────────────────────
function openModal(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const overlay = document.getElementById('modal-overlay');
  const av = document.getElementById('modal-avatar');
  const nm = document.getElementById('modal-name');
  const sub = document.getElementById('modal-sub');
  const body = document.getElementById('modal-body');
  let avClass = 'av-available';
  if (p.status === 'break') avClass = 'av-break';
  if (p.status === 'lunch') avClass = 'av-lunch';
  if (p.status === 'overdue') avClass = 'av-overdue';
  av.className = 'modal-avatar ' + avClass;
  av.textContent = initials(p.name);
  nm.textContent = p.name;
  const typeLabel = p.type === 'lunch' ? `${BREAK_DUR['lunch']}-min lunch` : p.type === 'break' ? `${BREAK_DUR['break']}-min break` : 'Team member';
  sub.textContent = ZONE_LABELS[p.zone] + ' · ' + typeLabel;
  const elapsed = getElapsedMin(p);
  const dur = getDur(p);
  const remaining = dur - elapsed;
  const shiftText = (p.shiftStartMs || p.shiftEndMs) ? `${fmtTime(p.shiftStartMs)} — ${fmtTime(p.shiftEndMs)}` : '—';
  // Offer start buttons when available. Offer "Mark taken" when a break/lunch is active or due.
  const now = Date.now();
  const next = getNextScheduledBreak(p);
  const hasDue = p.breaks && (p.breaks.find(b => b.status === 'active' || b.status === 'overdue') || (next && next.scheduledMs && next.scheduledMs <= now));
  let actionsHtml = '';
  if (p.absent || p.status === 'not_here' || p.status === 'clocked_out') {
    // No break/lunch actions for unavailable people
  } else if (p.status === 'available') {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn start-break" onclick="startBreak('${p.id}','break');closeModal()">Start ${BREAK_DUR['break']}-min break</button><button class="modal-btn start-lunch" onclick="startBreak('${p.id}','lunch');closeModal()">Start ${BREAK_DUR['lunch']}-min lunch</button></div>`;
  } else {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn mark-back" onclick="markReturned('${p.id}');closeModal()">Mark returned</button></div>`;
  }
  // Offer manual clock-out when available on shift or when shift has ended
  if (!p.clockedOut && !p.absent && (p.status === 'available' || p.shouldClockOut || p.clockOutOverdue)) {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn ok" onclick="manualClockOut('${p.id}');closeModal()">Clock out</button></div>`;
  }
  if (hasDue) {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn ok" onclick="markBreakDone('${p.id}');closeModal()">Mark break taken</button></div>`;
  }
  actionsHtml += `<div class="modal-action-row"><button class="modal-btn remove" onclick="removePerson('${p.id}');closeModal()">Remove</button></div>`;
  // Build editable break rows for this person
  const breaksHtml = (p.breaks || []).map(b => {
    const tval = b.scheduledTime || (b.scheduledMs ? fmtTime(b.scheduledMs) : '');
    return `<div class="modal-break-row" style="display:flex;gap:8px;align-items:center;margin-top:8px"><div style="flex:1"><strong>${b.type.charAt(0).toUpperCase()+b.type.slice(1)}</strong><div style="font-size:12px;color:var(--gray-400)">Current: ${tval}</div></div><div style="width:42%"><input id="modal-break-time-${b.id}" class="form-input" value="${tval}"></div><div style="width:26%"><input id="modal-break-dur-${b.id}" class="form-input" value="${b.dur || (b.type==='lunch'?BREAK_DUR['lunch']:15)}"></div><div><button class="btn-tiny" onclick="event.stopPropagation();removeBreak('${p.id}','${b.id}');return false;">Remove</button></div></div>`;
  }).join('');

  let statusLabel = '';
  if (p.status === 'not_here') statusLabel = 'Not here';
  else if (p.status === 'available') statusLabel = 'Available';
  else if (p.status === 'break') statusLabel = 'On break';
  else if (p.status === 'lunch') statusLabel = 'Lunch';
  else if (p.status === 'overdue') statusLabel = 'Overdue';
  else if (p.status === 'clocked_out') statusLabel = 'Clocked out';
  else statusLabel = p.status ? (p.status.charAt(0).toUpperCase()+p.status.slice(1)) : '';

  body.innerHTML = `${actionsHtml}
    <div class="modal-info-row"><span class="modal-info-label">Status</span><span class="modal-info-value">${statusLabel}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Zone</span><span class="modal-info-value">${ZONE_LABELS[p.zone]}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Shift</span><span class="modal-info-value">${shiftText}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Next break</span><span class="modal-info-value">${(next && next.scheduledTime) ? next.scheduledTime : (p.scheduledTime||'—')}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Break started</span><span class="modal-info-value">${p.startMs?fmtTime(p.startMs):'—'}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Time remaining</span><span class="modal-info-value">${isActive(p)?(remaining>0?remaining+' min':'Overdue by '+Math.abs(remaining)+' min'):'—'}</span></div>
    <div style="margin-top:10px"><h4 style="margin:0 0 6px 0">Edit breaks</h4>${breaksHtml || '<div class="empty-small">No scheduled breaks</div>'}<div style="margin-top:8px"><button class="modal-btn" onclick="saveBreakEdits('${p.id}');closeModal()">Save breaks</button></div></div>
    <div style="margin-top:10px"><label style="display:block;font-size:12px;color:var(--gray-400);margin-bottom:6px">Note</label><textarea id="modal-note" class="modal-note">${p.note || ''}</textarea></div>
    <div style="display:flex;gap:8px;margin-top:8px;"><button class="modal-btn" onclick="saveNote('${p.id}');closeModal()">Save note</button><button class="modal-btn" onclick="toggleLate('${p.id}');closeModal()">${p.late? 'Clear late':'Mark late'}</button><button class="modal-btn" onclick="toggleAbsent('${p.id}');closeModal()">${p.absent? 'Clear absent':'Mark absent'}</button></div>`;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

// ── Actions ───────────────────────────────────────────────────────────
function startBreak(personId, type) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const now = Date.now();
  // Zone conflict warning: check if sending this person would leave their zone with 0 available
  const zoneAvailable = people.filter(x =>
    x.zone === p.zone && x.id !== p.id &&
    !x.absent && !x.clockedOut &&
    x.status !== 'not_here' && x.status !== 'break' && x.status !== 'lunch' && x.status !== 'overdue'
  ).length;
  if (zoneAvailable === 0) {
    const zoneName = ZONE_LABELS[p.zone] || p.zone;
    if (!confirm(`⚠️ ${zoneName} will have no one available if ${p.name} goes on ${type}.\n\nSend anyway?`)) return;
  }
  // Find a scheduled break of this type to mark active; prefer nearest scheduled time
  if (!p.breaks) p.breaks = [];
  let target = null;
  const scheduled = p.breaks.filter(b => b.type === type && b.status === 'scheduled');
  if (scheduled.length > 0) {
    scheduled.sort((a, b) => Math.abs((a.scheduledMs || now) - now) - Math.abs((b.scheduledMs || now) - now));
    target = scheduled[0];
  }
  if (!target) {
    // create an ad-hoc break record
    target = { id: uid(), type, scheduledMs: now, scheduledTime: fmtTime(now), status: 'scheduled', startMs: null, dur: BREAK_DUR[type] || 15 };
    p.breaks.push(target);
  }
  target.status = 'active';
  target.startMs = now;
  // When starting lunch, auto-mark the first scheduled break as done (assumed taken)
  if (type === 'lunch') {
    const pendingBreaks = p.breaks.filter(b => b.type === 'break' && b.status === 'scheduled').sort((a, b) => (a.scheduledMs || 0) - (b.scheduledMs || 0));
    if (pendingBreaks.length > 0) pendingBreaks[0].status = 'done';
  }
  p.status = type === 'lunch' ? 'lunch' : 'break';
  p.type = type; p.startMs = now;
  // Cancel any scheduled notification for this break since it's now active
  cancelScheduledNotification('trigger:' + target.id);
  saveState(); showToast(`${p.name} — ${type==='break'?`${BREAK_DUR['break']}-min break`:type==='lunch'?`${BREAK_DUR['lunch']}-min lunch`:''} started`); render();
}

function saveNote(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const el = document.getElementById('modal-note');
  if (!el) return;
  p.note = el.value.trim();
  saveState();
  showToast('Note saved');
  render();
}

// Save edited breaks from the modal. Validates lunch cannot be at/after 5 hours into shift.
function saveBreakEdits(personId) {
  const p = people.find(x => x.id === personId);
  if (!p || !p.breaks) return;
  p.breaks.forEach(b => {
    const timeEl = document.getElementById('modal-break-time-' + b.id);
    const durEl = document.getElementById('modal-break-dur-' + b.id);
    if (timeEl) {
      const raw = timeEl.value.trim();
      const parsed = parseMilTime(raw);
      if (parsed) {
        b.scheduledMs = parsed.getTime();
        b.scheduledTime = parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
    }
    if (durEl) {
      const v = Number(durEl.value) || b.dur || (b.type === 'lunch' ? BREAK_DUR['lunch'] : 15);
      b.dur = v;
    }
    // If lunch, enforce 5-hour rule relative to shiftStartMs
    if (b.type === 'lunch' && p.shiftStartMs) {
      const limitMs = p.shiftStartMs + 5 * 3600000;
      if (b.scheduledMs && b.scheduledMs >= limitMs) {
        b.scheduledMs = limitMs - 60000; // move to 1 minute before 5-hour mark
        b.scheduledTime = new Date(b.scheduledMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        showToast('Lunch adjusted: cannot schedule at/after 5 hours into shift');
      }
    }
    // ensure status remains scheduled if not active/done
    if (!b.status) b.status = 'scheduled';
  });
  // After edits, cancel and reschedule notifications for this person
  syncPersonStatus(p); saveState(); showToast('Breaks updated'); render();
  cancelScheduledNotificationsForPerson(p.id);
}

function manualClockOut(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  p.clockedOut = true;
  p.shouldClockOut = false;
  p.clockOutOverdue = false;
  p.status = 'clocked_out';
  syncPersonStatus(p);
  saveState();
  pushAlert({ type: 'ok', msg: `${p.name} clocked out manually`, personId: p.id });
  // Cancel any scheduled notifications for this person
  cancelScheduledNotificationsForPerson(p.id);
  showToast(`${p.name} clocked out`);
  render();
}

function removeBreak(personId, breakId) {
  const p = people.find(x => x.id === personId);
  if (!p || !p.breaks) return;
  p.breaks = p.breaks.filter(b => b.id !== breakId);
  syncPersonStatus(p); saveState(); showToast('Break removed'); render();
}

// Undo support
function pushUndo(obj) {
  lastAction = obj;
  const ub = document.getElementById('undo-bar');
  const ut = document.getElementById('undo-text');
  if (ut) ut.textContent = obj?.message || 'Action performed';
  if (ub) ub.classList.remove('hidden');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { lastAction = null; ub.classList.add('hidden'); }, 6000);
}

function undoLast() {
  if (!lastAction) { showToast('Nothing to undo'); return; }
  const act = lastAction;
  lastAction = null;
  const ub = document.getElementById('undo-bar'); if (ub) ub.classList.add('hidden');
  clearTimeout(undoTimer);
  if (act.action === 'markBreakDone') {
    const p = people.find(x => x.id === act.personId);
    if (p && p.breaks) {
      const b = p.breaks.find(x => x.id === act.breakId);
      if (b) {
        b.status = act.prev.status;
        b.startMs = act.prev.startMs;
        syncPersonStatus(p);
        saveState(); showToast('Undo: break marked back'); render(); return;
      }
    }
  } else if (act.action === 'toggleLate') {
    const p = people.find(x => x.id === act.personId); if (!p) return;
    p.late = act.prev;
    saveState(); showToast('Undo: late cleared'); render(); return;
  } else if (act.action === 'toggleAbsent') {
    const p = people.find(x => x.id === act.personId); if (!p) return;
    p.absent = act.prev;
    saveState(); showToast('Undo: absent cleared'); render(); return;
  }
  showToast('Nothing to undo');
}

function toggleLate(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const prev = !!p.late;
  p.late = !p.late;
  pushUndo({ action: 'toggleLate', personId, prev, message: p.late ? `${p.name} marked late` : 'Late cleared' });
  if (p.late) pushAlert({ type: 'info', msg: `${p.name} marked late` });
  saveState(); render();
}

function toggleAbsent(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  const prev = !!p.absent;
  p.absent = !p.absent;
  pushUndo({ action: 'toggleAbsent', personId, prev, message: p.absent ? `${p.name} marked absent` : 'Absent cleared' });
  if (p.absent) pushAlert({ type: 'urgent', msg: `${p.name} marked absent` });
  saveState(); render();
  if (p.absent) cancelScheduledNotificationsForPerson(p.id);
}

function markReturned(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  // Mark any active/overdue break as done when returning
  if (p.breaks && p.breaks.length > 0) {
    const active = p.breaks.find(b => b.status === 'active' || b.status === 'overdue');
    if (active) { active.status = 'done'; if (!active.startMs) active.startMs = active.scheduledMs || Date.now(); }
  }
  pushAlert({ type: 'ok', msg: `${p.name} returned` });
  p.status = 'available'; p.startMs = null;
  // Cancel any scheduled notifications for this person (they returned)
  cancelScheduledNotificationsForPerson(p.id);
  saveState(); showToast(`${p.name} marked as returned`); render();
}

function removePerson(personId) {
  people = people.filter(x => x.id !== personId);
  // Cancel any scheduled notifications for removed person
  cancelScheduledNotificationsForPerson(personId);
  saveState(); showToast('Team member removed'); render();
}

function addManual() {
  try {
  const name = document.getElementById('manual-name')?.value.trim();
  if (!name) { showToast('Please enter a name'); return; }

  const shiftStart = document.getElementById('manual-shift-start')?.value;
  const shiftEnd = document.getElementById('manual-shift-end')?.value;
  const firstBreak = document.getElementById('manual-first-break')?.value;
  const lunch = document.getElementById('manual-lunch')?.value;
  const secondBreak = document.getElementById('manual-second-break')?.value;
  const lunchDurVal = document.getElementById('manual-lunch-duration')?.value || String(BREAK_DUR['lunch']);
  const zone = document.getElementById('manual-zone')?.value || 'checklanes';

  const timeToDate = (t) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0); d.setSeconds(0); d.setMilliseconds(0);
    return d;
  };

  const sStart = timeToDate(shiftStart);
  const sEnd = timeToDate(shiftEnd);
  const breaks = [];

  if (firstBreak) breaks.push({ type: 'break', date: timeToDate(firstBreak), dur: 15 });
  if (lunch && lunchDurVal !== 'none') breaks.push({ type: 'lunch', date: timeToDate(lunch), dur: Number(lunchDurVal) });
  if (secondBreak) breaks.push({ type: 'break', date: timeToDate(secondBreak), dur: 15 });

  // If no explicit times provided, auto-generate breaks based on shift length.
  const durHours = (sStart && sEnd) ? ((sEnd.getTime() - sStart.getTime()) / 3600000) : 0;
  if ((!firstBreak && !lunch && !secondBreak) && sStart && sEnd) {
    if (durHours >= 2) {
      const b = new Date(sStart.getTime() + 2 * 3600000);
      if (b < sEnd) breaks.push({ type: 'break', date: b, dur: 15 });
    }
    if (durHours > 5 && lunchDurVal !== 'none') {
      const mid = new Date((sStart.getTime() + sEnd.getTime()) / 2);
      breaks.push({ type: 'lunch', date: mid, dur: Number(lunchDurVal) });
    }
    if (durHours > 6) {
      const b2 = new Date(sStart.getTime() + 6 * 3600000);
      if (b2 < sEnd) breaks.push({ type: 'break', date: b2, dur: 15 });
    }
  } else if (sStart && sEnd) {
    // If user provided some break times but selected a lunch option without a lunch time,
    // auto-place lunch at midpoint when shift long enough.
    const hasLunch = breaks.some(b => b.type === 'lunch');
    if (!hasLunch && lunchDurVal !== 'none' && durHours > 5) {
      const mid = new Date((sStart.getTime() + sEnd.getTime()) / 2);
      breaks.push({ type: 'lunch', date: mid, dur: Number(lunchDurVal) });
    }
  }

  // Validate explicit lunch time is within shift bounds; if not, auto-place at midpoint and warn.
  if (sStart && sEnd && lunch) {
    const lunchDate = timeToDate(lunch);
    if (lunchDate && (lunchDate < sStart || lunchDate > sEnd)) {
      const mid = new Date((sStart.getTime() + sEnd.getTime()) / 2);
      // replace any lunch entry with corrected one
      for (let i = 0; i < breaks.length; i++) {
        if (breaks[i].type === 'lunch') { breaks[i].date = mid; breaks[i].dur = Number(lunchDurVal); }
      }
      showToast('Lunch time was outside the shift — placed at midpoint');
    }
  }

  // Enforce lunch cannot be scheduled at or after 5 hours into the shift.
  if (sStart) {
    const limitMs = sStart.getTime() + 5 * 3600000; // 5 hours after shift start
    for (let i = 0; i < breaks.length; i++) {
      const b = breaks[i];
      if (b && b.type === 'lunch' && b.date) {
        if (b.date.getTime() >= limitMs) {
          // move lunch to 1 minute before the 5-hour mark
          b.date = new Date(limitMs - 60000);
          b.dur = Number(lunchDurVal);
          showToast('Lunch adjusted: cannot schedule at/after 5 hours into shift');
        }
      }
    }
  }

  if (breaks.length === 0 && !sStart && !sEnd) {
    showToast('No break times or shift provided — enter a time or shift start/end');
    return;
  }

  let created = 0;
  // Attach breaks to existing person (same name & zone) or create new person with breaks array
  const existing = people.find(p => p.name === name && p.zone === zone);
  if (existing) {
    if (!existing.breaks) existing.breaks = [];
    breaks.forEach(b => {
      if (!b.date) return;
      const scheduledMs = b.date.getTime();
      const scheduledTime = b.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      existing.breaks.push({ id: uid(), type: b.type, scheduledMs, scheduledTime, status: 'scheduled', startMs: null, dur: b.dur || (b.type === 'lunch' ? BREAK_DUR['lunch'] : 15) });
      created++;
    });
    // ensure shift window is set
    if (sStart) existing.shiftStartMs = sStart.getTime();
    if (sEnd) existing.shiftEndMs = sEnd.getTime();
    syncPersonStatus(existing);
  } else {
    const personBreaks = [];
    breaks.forEach(b => {
      if (!b.date) return;
      const scheduledMs = b.date.getTime();
      const scheduledTime = b.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      personBreaks.push({ id: uid(), type: b.type, scheduledMs, scheduledTime, status: 'scheduled', startMs: null, dur: b.dur || (b.type === 'lunch' ? BREAK_DUR['lunch'] : 15) });
      created++;
    });
    if (personBreaks.length > 0) {
      const person = { id: uid(), name, zone, role: '', breaks: personBreaks, status: 'available', startMs: null, shiftStartMs: sStart ? sStart.getTime() : null, shiftEndMs: sEnd ? sEnd.getTime() : null };
      syncPersonStatus(person);
      people.push(person);
    }
  }

  if (created === 0) { showToast('No valid break times to add'); return; }

  saveState();
  resetManualForm();
  showToast(`${name} — ${created} break${created>1?'s':''} added to ${ZONE_LABELS[zone]}`);
  switchTab('board');
  } catch (e) {
    console.error('addManual error', e);
    showToast('Error adding person. See console.');
  }
}

function resetManualForm() {
  ['manual-name','manual-shift-start','manual-shift-end','manual-first-break','manual-lunch','manual-second-break'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const dur = document.getElementById('manual-lunch-duration'); if (dur) dur.value = String(BREAK_DUR['lunch']);
  const zone = document.getElementById('manual-zone'); if (zone) zone.value = 'checklanes';
}

function confirmReset() {
  if (confirm('Clear all team members and start a fresh shift?')) {
    people = []; alerts = []; saveState(); showToast('Shift reset — ready for a new day'); render();
  }
}

// ── File upload handler (image + PDF) ────────────────────────────────
async function handleFileUpload(input) {
  const file = input.files[0];
  if (!file) return;

  // We no longer expect an API key in the client. The request is sent to
  // the server-side proxy which holds the API key in an environment variable.

  document.getElementById('upload-box').classList.add('hidden');
  document.getElementById('scan-loading').classList.remove('hidden');
  const scanText = document.getElementById('scan-text');
  if (scanText) scanText.textContent = file.type === 'application/pdf' ? 'Reading your PDF schedule...' : 'Reading your schedule photo...';

  try {
    const base64 = await fileToBase64(file);
    const isPDF = file.type === 'application/pdf';
    const mediaType = isPDF ? 'application/pdf' : (file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg');

    const contentBlock = isPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

    // Send to server-side proxy which attaches the API key from env vars.
    const response = await fetch('/api/anthropic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: buildScanPrompt() }] }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}. Check your API key is correct.`);
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';

    let parsed = [];
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      console.error('Raw AI response:', text);
      throw new Error('Could not parse the schedule. Try a clearer, straight-on photo with good lighting.');
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('No team members found in the schedule. Make sure the table is clearly visible.');
    }

    showParsedResults(parsed);

  } catch (err) {
    document.getElementById('scan-loading').classList.add('hidden');
    document.getElementById('upload-box').classList.remove('hidden');
    showToast(err.message || 'Error reading file. Please try again.');
    console.error(err);
  }

  input.value = '';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function buildScanPrompt() {
  return `You are reading a Target store "Additional Assignment Sheet" — a break and lunch schedule.

The table has columns: TM Name, Shift, 1st Break, Lunch, 2nd Break, Task(s).
Times in the break columns are written in SHORT military format:
  9 = 9:00 AM, 10 = 10:00 AM, 11 = 11:00 AM, 12 = 12:00 PM
  1 = 1:00 PM, 2 = 2:00 PM, 3 = 3:00 PM, 4 = 4:00 PM, 5 = 5:00 PM, 6 = 6:00 PM
  1130 = 11:30 AM, 1245 = 12:45 PM, 245 = 2:45 PM, 315 = 3:15 PM
  530 = 5:30 PM, 545 = 5:45 PM, 615 = 6:15 PM, 630 = 6:30 PM
  715 = 7:15 PM, 745 = 7:45 PM, 815 = 8:15 PM, 830 = 8:30 PM
  1015 = 10:15 PM

For each team member row, output ONE entry per break slot that has a time filled in.
If a person has both a 1st break AND a lunch, output TWO separate entries for that person.
If a person has a 1st break, lunch, AND 2nd break, output THREE entries.

Return ONLY a JSON array. No markdown, no explanation. Each item:
{
  "name": "name exactly as written",
  "time": "the raw time value exactly as written in the cell e.g. 9, 1130, 245, 815",
  "type": "break" or "lunch",
  "zone": "checklanes" or "sco" or "service" or "driveup" or "",
  "task": "contents of the Task(s) column, or empty string"
}

Zone rules from Task(s) column:
- CL, CL/PS, CL/SCO SUPPORT, CL/CASH OFFICE → "checklanes"
- SCO, SCO 1, SCO 2, SCO 2/CL SUPPORT → "sco"
- SERVICE DESK, GUEST SERVICE → "service"
- DRIVE UP, OPU, G ATTENDENT, GUEST ATTENDANT → "driveup"
- If task cell is blank or unclear → set zone to ""

1st Break and 2nd Break entries use type "break".
Lunch entries use type "lunch".
Skip any row with no name. Return only the JSON array.`;
}

// ── Parse results + auto-zone warning ────────────────────────────────
function showParsedResults(rawRows) {
  try {
  document.getElementById('scan-loading').classList.add('hidden');

  const expanded = [];
  const autoAssignedMap = new Map();

  rawRows.forEach(row => {
    if (!row.name || !row.name.trim()) return;

    let zone = row.zone || '';
    let wasAutoAssigned = false;

    if (!zone) {
      const inferred = inferZone(row.task || '');
      zone = inferred || 'checklanes';
      wasAutoAssigned = true;
      if (!autoAssignedMap.has(row.name)) {
        autoAssignedMap.set(row.name, { name: row.name, assignedZone: ZONE_LABELS[zone], task: row.task || '(no task listed)' });
      }
    }

    const parsed = fmtParsedTime(row.time);

    expanded.push({
      name: row.name.trim(),
      rawTime: row.time,
      displayTime: parsed ? parsed.display : (row.time ? String(row.time) : ''),
      scheduledMs: parsed ? parsed.ms : null,
      type: row.type || 'break',
      zone,
      wasAutoAssigned,
      task: row.task || ''
    });
  });

  window._parsedSchedule = expanded;

  const list = document.getElementById('parsed-list');
  const countEl = document.getElementById('parsed-count');
  list.innerHTML = '';
  if (countEl) countEl.textContent = `${expanded.length} break entries found from ${new Set(expanded.map(r=>r.name)).size} team members`;

  // Remove any existing warning
  document.getElementById('auto-assign-warning')?.remove();

  const autoAssigned = [...autoAssignedMap.values()];
  if (autoAssigned.length > 0) {
    const warn = document.createElement('div');
    warn.id = 'auto-assign-warning';
    warn.className = 'assign-warning';
    warn.innerHTML = `
      <div class="warn-header">
        <div class="warn-icon">!</div>
        <div class="warn-header-text">
          <div class="warn-title">Zone auto-assigned for ${autoAssigned.length} team member${autoAssigned.length > 1 ? 's' : ''}</div>
          <div class="warn-sub">These team members had no task listed — zone was guessed based on name or defaulted to Checklanes. Please review before importing.</div>
        </div>
      </div>
      <div class="warn-list">
        ${autoAssigned.map(a => `
          <div class="warn-row">
            <span class="warn-name">${a.name}</span>
            <span class="warn-arrow">→</span>
            <span class="warn-zone">${a.assignedZone}</span>
            <span class="warn-task">${a.task}</span>
          </div>`).join('')}
      </div>
    `;
    // Insert before parsed-list's parent content
    list.parentNode.insertBefore(warn, document.getElementById('parsed-section').querySelector('.parsed-header').nextSibling);
  }

  expanded.forEach(row => {
    const div = document.createElement('div');
    div.className = 'parsed-row' + (row.wasAutoAssigned ? ' auto-assigned' : '');
    const typeLabel = row.type === 'break' ? `${BREAK_DUR['break']}-min break` : `${BREAK_DUR['lunch']}-min lunch`;
    const typeCls = row.type === 'break' ? 'pt-break' : 'pt-lunch';
    div.innerHTML = `
      <div class="parsed-row-main">
        <span class="parsed-name">${row.name}</span>
        <span class="parsed-meta">${ZONE_LABELS[row.zone]}${row.displayTime ? ' · ' + row.displayTime : ''}${row.wasAutoAssigned ? ' <span class="auto-tag">auto</span>' : ''}</span>
      </div>
      <span class="parsed-type ${typeCls}">${typeLabel}</span>
    `;
    list.appendChild(div);
  });

  document.getElementById('parsed-section').classList.remove('hidden');
  } catch (e) { console.error('showParsedResults error', e); showToast('Error parsing schedule.'); }
}

function importSchedule() {
  try {
  const parsed = window._parsedSchedule || [];
  const map = new Map();

  // Group parsed rows by name+zone into person -> breaks
  parsed.forEach(row => {
    if (!row.name) return;
    const name = row.name.trim();
    const zone = row.zone || 'checklanes';
    const key = name + '||' + zone;
    if (!map.has(key)) map.set(key, { name, zone, breaks: [] });
    const p = map.get(key);
    const dur = (row.type === 'lunch') ? (BREAK_DUR['lunch'] || 45) : (BREAK_DUR['break'] || 15);
    p.breaks.push({ id: uid(), type: row.type || 'break', scheduledMs: row.scheduledMs || null, scheduledTime: row.displayTime || '', status: row.scheduledMs ? 'scheduled' : 'scheduled', startMs: null, dur });
  });

  const created = [];
  map.forEach(v => {
    // Infer a rough shift window from earliest/latest scheduled breaks (heuristic)
    const times = v.breaks.map(b => b.scheduledMs).filter(Boolean);
    let shiftStartMs = null, shiftEndMs = null;
    if (times.length > 0) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      // assume ~2 hours padding before first and after last scheduled break
      shiftStartMs = Math.max(0, min - 2 * 3600000);
      shiftEndMs = max + 2 * 3600000;
    }
    const person = { id: uid(), name: v.name, zone: v.zone, role: '', breaks: v.breaks, status: 'available', startMs: null, shiftStartMs, shiftEndMs };
    syncPersonStatus(person);
    people.push(person);
    created.push(person);
  });

  saveState();
  document.getElementById('parsed-section').classList.add('hidden');
  document.getElementById('auto-assign-warning')?.remove();
  document.getElementById('import-success').classList.remove('hidden');
  showToast(`${created.length} team members imported (${parsed.length} break entries)`);
  } catch (e) {
    console.error('importSchedule error', e);
    showToast('Error importing schedule. See console.');
  }
}

function resetUpload() {
  document.getElementById('parsed-section').classList.add('hidden');
  document.getElementById('import-success').classList.add('hidden');
  document.getElementById('upload-box').classList.remove('hidden');
  document.getElementById('auto-assign-warning')?.remove();
  window._parsedSchedule = [];
}

// ── Alerts ────────────────────────────────────────────────────────────
function pushAlert(alert) {
  alert.id = alert.id || ('alert-' + alertIdCounter++);
  alert.ts = Date.now();
  if (!alerts.find(a => a.id === alert.id && a.type === alert.type)) alerts.unshift(alert);
  // Pulse the topbar notification bell briefly when a new alert is pushed
  try {
    const nb = document.getElementById('notif-btn');
    if (nb) {
      nb.classList.remove('hidden');
      nb.classList.add('pulse');
      setTimeout(() => nb.classList.remove('pulse'), 1200);
    }
  } catch (e) {}
}

// ── Toast ─────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ── PWA + Notifications ───────────────────────────────────────────────
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function sendPushNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch(e) {}
  }
}

// Persist notifiedPush so we don't re-fire on page reload
let notifiedPush = new Set();
try {
  const saved = localStorage.getItem('bm_notified_push');
  if (saved) notifiedPush = new Set(JSON.parse(saved));
} catch(e) {}

function saveNotifiedPush() {
  try {
    // Only persist entries from the last 12 hours to avoid stale entries
    const cutoff = Date.now() - 12 * 3600000;
    const valid = Array.from(notifiedPush).filter(k => {
      const ts = Number(k.split('|')[1]);
      return !ts || ts > cutoff;
    });
    localStorage.setItem('bm_notified_push', JSON.stringify(valid));
    notifiedPush = new Set(valid);
  } catch(e) {}
}

// Client-side scheduled notifications only (no SW TimestampTrigger — unsupported in all browsers)
const scheduledNotifications = new Map(); // tag -> { title, body, tag, time, data }
const scheduledTimeouts = new Map();      // tag -> timeoutId
let scheduledTriggers = new Set();        // break ids we've already scheduled

function saveScheduledNotifications() {
  try { localStorage.setItem('bm_scheduled_notifications', JSON.stringify(Array.from(scheduledNotifications.entries()))); } catch(e){}
}

function restoreScheduledNotifications() {
  try {
    const raw = localStorage.getItem('bm_scheduled_notifications');
    if (!raw) return;
    const arr = JSON.parse(raw);
    const now = Date.now();
    arr.forEach(([tag, obj]) => {
      // Skip already-past notifications
      if (!obj || !obj.time || Number(obj.time) < now) return;
      scheduledNotifications.set(tag, obj);
      scheduleClientFallback(obj);
    });
  } catch(e) {}
}

function scheduleClientFallback(obj) {
  try {
    if (!obj || !obj.tag) return;
    const now = Date.now();
    if (scheduledTimeouts.has(obj.tag)) {
      clearTimeout(scheduledTimeouts.get(obj.tag));
      scheduledTimeouts.delete(obj.tag);
    }
    const delay = Math.max(0, (Number(obj.time) || now) - now);
    // Don't schedule if it would fire in less than 60 seconds (likely already stale)
    if (delay < 60000 && obj.time < now) return;
    const tid = setTimeout(() => {
      try {
        if (Notification.permission === 'granted') {
          const personId = obj.data && obj.data.personId;
          const p = people.find(x => x.id === personId);
          if (!p || p.absent || p.clockedOut || p.status === 'not_here') {
            cancelScheduledNotification(obj.tag); return;
          }
          sendPushNotification(obj.title, obj.body);
          pushAlert({ id: obj.tag, type: 'info', msg: obj.body, personId });
        }
      } catch (e) {}
      cancelScheduledNotification(obj.tag);
    }, delay);
    scheduledTimeouts.set(obj.tag, tid);
  } catch(e) {}
}

function cancelScheduledNotification(tag) {
  try {
    if (!tag) return;
    if (scheduledTimeouts.has(tag)) { clearTimeout(scheduledTimeouts.get(tag)); scheduledTimeouts.delete(tag); }
    if (scheduledNotifications.has(tag)) { scheduledNotifications.delete(tag); saveScheduledNotifications(); }
    if (scheduledTriggers.has(tag)) scheduledTriggers.delete(tag);
  } catch(e) {}
}

function cancelScheduledNotificationsForPerson(personId) {
  try {
    for (const [tag, obj] of Array.from(scheduledNotifications.entries())) {
      if (obj && obj.data && obj.data.personId === personId) cancelScheduledNotification(tag);
    }
    // Also remove from notifiedPush for this person so they can get fresh notifications
    notifiedPush.forEach(k => { if (k.includes(personId)) notifiedPush.delete(k); });
  } catch(e) {}
}

function checkPushNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = Date.now();
  people.forEach(p => {
    if (p.absent || p.clockedOut || p.status === 'not_here') return;

    // Overdue break notification (fires once per overdue event)
    if (p.status === 'overdue') {
      const key = `overdue:${p.id}`;
      if (!notifiedPush.has(key)) {
        notifiedPush.add(key);
        saveNotifiedPush();
        sendPushNotification('Break overdue!', `${p.name} needs to return — ${ZONE_LABELS[p.zone]}`);
      }
    }

    // Clock-out overdue
    if (p.clockOutOverdue) {
      const key = `clockout:${p.id}`;
      if (!notifiedPush.has(key)) {
        notifiedPush.add(key);
        saveNotifiedPush();
        sendPushNotification('Shift ended — clock out', `${p.name} is still on break after shift end`);
      }
    }

    // Schedule future break notifications using client-side setTimeout only
    if (p.breaks && p.breaks.length > 0) {
      p.breaks.forEach(b => {
        if (b.status !== 'scheduled' || !b.scheduledMs) return;

        if (b.scheduledMs <= now) {
          // Break is due now — fire immediately (once)
          const key = `due:${b.id}`;
          if (!notifiedPush.has(key)) {
            notifiedPush.add(key);
            saveNotifiedPush();
            const title = b.type === 'lunch' ? 'Lunch due' : 'Break due';
            sendPushNotification(title, `${p.name}'s ${b.type} is due — ${ZONE_LABELS[p.zone]}`);
            pushAlert({ id: key, type: 'info', msg: `${p.name}'s ${b.type} is due — ${ZONE_LABELS[p.zone]}`, personId: p.id });
          }
        } else {
          // Future break — schedule a client-side timeout (once per break)
          const key = `trigger:${b.id}`;
          if (!scheduledTriggers.has(key)) {
            scheduledTriggers.add(key);
            const obj = {
              title: b.type === 'lunch' ? 'Lunch due' : 'Break due',
              body: `${p.name}'s ${b.type} is due — ${ZONE_LABELS[p.zone]}`,
              tag: key, time: b.scheduledMs,
              data: { personId: p.id, breakId: b.id }
            };
            scheduledNotifications.set(key, obj);
            saveScheduledNotifications();
            scheduleClientFallback(obj);
          }
        }
      });
    }
  });

  // Clean up stale notifiedPush entries when the condition clears
  notifiedPush.forEach(key => {
    const [type, id] = key.split(':');
    if (type === 'due') {
      let found = false;
      for (const p of people) {
        const b = (p.breaks || []).find(x => x.id === id);
        if (b) { found = true; if (b.status !== 'scheduled') notifiedPush.delete(key); break; }
      }
      if (!found) notifiedPush.delete(key);
    } else if (type === 'overdue') {
      const p = people.find(x => x.id === id);
      if (!p || p.status !== 'overdue') notifiedPush.delete(key);
    } else if (type === 'clockout') {
      const p = people.find(x => x.id === id);
      if (!p || !p.clockOutOverdue) notifiedPush.delete(key);
    }
  });

  // Clean up scheduledTriggers when the break is done/cancelled/removed
  scheduledTriggers.forEach(key => {
    const id = key.split(':')[1];
    let found = false;
    for (const p of people) {
      const b = (p.breaks || []).find(x => x.id === id);
      if (b) { found = true; if (b.status !== 'scheduled') { cancelScheduledNotification(key); } break; }
    }
    if (!found) cancelScheduledNotification(key);
  });
}

// Manual refresh triggered by user
function manualRefresh() {
  try { document.getElementById('refresh-btn')?.classList.add('pulse'); } catch(e){}
  showToast('Refreshing...');
  loadState();
  // tick() calls render() internally — no need for a separate render() call
  try { tick(); checkPushNotifications(); } catch(e){ render(); }
  setTimeout(() => { try { document.getElementById('refresh-btn')?.classList.remove('pulse'); } catch(e){} }, 800);
}

// Debug helpers: global error capture and state dump
window.addEventListener('error', function (ev) {
  try {
    console.error('Uncaught error', ev.error || ev.message, ev.filename + ':' + ev.lineno + ':' + ev.colno);
    showToast('Error: ' + (ev.message || 'See console'));
  } catch (e) {}
});
window.addEventListener('unhandledrejection', function (ev) {
  try { console.error('Unhandled promise rejection', ev.reason); showToast('Async error: see console'); } catch (e) {}
});

function dumpState() {
  try {
    const s = { people, alerts, scheduledNotifications: Array.from(scheduledNotifications.entries()), notifiedPush: Array.from(notifiedPush), scheduledTriggers: Array.from(scheduledTriggers) };
    console.log('Break Manager state dump:', s);
    // copy to clipboard for easy sharing
    const txt = JSON.stringify(s, null, 2);
    navigator.clipboard?.writeText(txt).then(() => showToast('State copied to clipboard'), () => showToast('State logged to console'));
  } catch (e) { console.error('dumpState error', e); showToast('Could not dump state'); }
}

// ── Init ──────────────────────────────────────────────────────────────
loadState();
requestNotificationPermission();
// Sync toggle-offline button to persisted state
(function() {
  const btn = document.getElementById('toggle-offline-btn');
  const lbl = document.getElementById('toggle-offline-label');
  if (btn) btn.classList.toggle('active', !showOffline);
  if (lbl) lbl.textContent = showOffline ? 'Hide offline' : 'Show offline';
})();
render();
// Restore any previously scheduled notifications (client-side fallbacks)
restoreScheduledNotifications();
setInterval(() => { tick(); checkPushNotifications(); }, 15000);
updateClock();
setInterval(updateClock, 10000);

// ── Keep screen awake ──────────────────────────────────────────────────
(function() {
  async function requestWakeLock() {
    if (!navigator.wakeLock) return;
    try { await navigator.wakeLock.request('screen'); } catch(e) {}
  }
  requestWakeLock();
  // Re-acquire after tab becomes visible again (wake lock is released on hide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
})();

function toggleShowOffline() {
  showOffline = !showOffline;
  try { localStorage.setItem('bm_show_offline', String(showOffline)); } catch(e) {}
  const btn = document.getElementById('toggle-offline-btn');
  const lbl = document.getElementById('toggle-offline-label');
  if (btn) btn.classList.toggle('active', !showOffline);
  if (lbl) lbl.textContent = showOffline ? 'Hide offline' : 'Show offline';
  showToast(showOffline ? 'Showing all team members' : 'Hiding clocked out & absent');
  render();
}

// Render a compact shift timeline: upcoming scheduled breaks across the shift
function renderShiftTimeline() {
  const el = document.getElementById('shift-timeline');
  if (!el) return;
  const now = Date.now();
  const upcoming = [];
  people.forEach(p => {
    if (p.absent || p.clockedOut || p.status === 'not_here') return;
    if (!p.breaks) return;
    p.breaks.forEach(b => {
      if (b.status === 'scheduled' && b.scheduledMs && b.scheduledMs > now) {
        upcoming.push({ p, b });
      }
    });
  });
  upcoming.sort((a, b) => a.b.scheduledMs - b.b.scheduledMs);
  const shown = upcoming.slice(0, 10);

  if (shown.length === 0) {
    el.innerHTML = '';
    return;
  }

  const items = shown.map(x => {
    const mins = Math.max(0, Math.round((x.b.scheduledMs - now) / 60000));
    const time = fmtTime(x.b.scheduledMs);
    const cls = x.b.type === 'lunch' ? 'tl-lunch' : 'tl-break';
    const soonCls = mins <= 15 ? ' soon' : '';
    const minsLabel = mins === 0 ? 'now' : `${mins}m`;
    return `<div class="timeline-item ${cls}">
      <div class="timeline-time">${time}</div>
      <div class="timeline-name">${escapeHtml(x.p.name)}</div>
      <div class="timeline-zone">${ZONE_LABELS[x.p.zone]}</div>
      <span class="timeline-mins${soonCls}">${minsLabel}</span>
      <div class="timeline-action"><button class="btn-tiny" onclick="event.stopPropagation();startBreak('${x.p.id}','${x.b.type}');return false;">Send</button></div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="timeline-wrap">
    <div class="timeline-header">
      <span class="timeline-header-title">Up next</span>
      <span class="timeline-header-count">${shown.length} break${shown.length !== 1 ? 's' : ''} scheduled</span>
    </div>
    ${items}
  </div>`;
}

