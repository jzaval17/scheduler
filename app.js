// ── State ──────────────────────────────────────────────────────────
const ZONE_MAX = { checklanes: 10, sco: 2, service: 1, driveup: 5 };
const TOTAL_ON_BREAK_MAX = 3; // overall max people on break before critical warning
const ZONE_LABELS = { checklanes: 'Checklanes', sco: 'SCO', service: 'Service Desk', driveup: 'Drive Up' };
const BREAK_DUR = { break: 15, lunch: 45, lunch60: 60 };
const NOTE_PREVIEW_LEN = 120;

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
let inlineNoteDraft = '';

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

function saveState() {
  try { localStorage.setItem('bm_people', JSON.stringify(people)); } catch(e) {}
}

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function isActive(p) {
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
    syncPersonStatus(p);
  });
  if (changed) saveState();
  render();
}

// ── Rendering ─────────────────────────────────────────────────────────
function render() {
  renderBoard(); renderStats(); renderCoverage(); renderAlerts(); renderAlertBanner(); updateClock();
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
      if (onBreak > max) { pill.textContent = `${onBreak}/${max} — over limit`; pill.className = 'zone-pill pill-danger'; }
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
    [...zp].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).forEach(p => {
      // Determine active break or next scheduled
      const activeBreak = p.breaks ? p.breaks.find(b => b.status === 'active' || b.status === 'overdue') : null;
      const next = getNextScheduledBreak(p);
      let avClass = 'av-available', sbClass = 'sb-available', sbLabel = 'Available';
      let timerText = next ? `Next: ${next.scheduledTime || ''}` : '';

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

      const taken = p.breaks && p.breaks.some(b => b.status === 'done');
      const takenHtml = taken ? '<span class="taken-badge">✓</span>' : '';
      const lateHtml = p.late ? '<span class="person-flag late">Late</span>' : '';
      const absentHtml = p.absent ? '<span class="person-flag absent">Absent</span>' : '';
      const clockOutHtml = p.clockOutOverdue ? '<span class="person-flag absent">Overtime</span>' : (p.shouldClockOut ? '<span class="person-flag late">Clock out</span>' : '');
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
      const availHtml = `<span class="avail-sign ${availClass}">${availLabel}</span>`;
      const shiftLine = (p.shiftStartMs && p.shiftEndMs) ? `${fmtTime(p.shiftStartMs)} — ${fmtTime(p.shiftEndMs)}` : '';
      const paid = computePaidHours(p);
      const paidHtml = (paid !== null && paid !== undefined) ? `<div class="person-shift">${shiftLine} · ${paid} hrs</div>` : (shiftLine ? `<div class="person-shift">${shiftLine}</div>` : '');

      // Build per-break badges (1st break, lunch, 2nd break) showing status
      let breakBadges = '';
      if (p.breaks && p.breaks.length > 0) {
        const sorted = [...p.breaks].slice().sort((a, b) => (a.scheduledMs || 0) - (b.scheduledMs || 0));
        let breakIdx = 0;
        const badges = sorted.map(b => {
          let label = b.type === 'lunch' ? 'Lunch' : (breakIdx === 0 ? '1st' : '2nd');
          if (b.type !== 'lunch') breakIdx++;
          let cls = 'br-sched';
          let content = label;
          if (b.status === 'done') { cls = 'br-done'; content = '✓'; }
          else if (b.status === 'active') { cls = 'br-active'; content = 'In'; }
          else if (b.status === 'overdue') { cls = 'br-overdue'; content = '!'; }
          const title = `${label} ${b.scheduledTime || ''}`.trim();
          return `<span class="break-badge ${cls}" title="${escapeHtml(title)}">${content}</span>`;
        }).join('');
        breakBadges = `<div class="break-badges">${badges}</div>`;
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

        const editActions = `<button class="btn-tiny" onclick="event.stopPropagation();openModal('${p.id}')">Edit breaks</button>`;
        const actions = `<div style="display:flex;gap:6px;margin-top:8px"><button class="btn-tiny" onclick="event.stopPropagation();startInline('${p.id}')">Edit</button><button class="btn-tiny" onclick="event.stopPropagation();toggleLate('${p.id}')">${p.late? 'Clear late':'Late'}</button><button class="btn-tiny" onclick="event.stopPropagation();toggleAbsent('${p.id}')">${p.absent? 'Clear absent':'Absent'}</button>${(next && next.scheduledMs && next.scheduledMs <= Date.now())?`<button class="btn-tiny" onclick="event.stopPropagation();markBreakDone('${p.id}')">Mark taken</button>`:''}${editActions}</div>`;

        // Add an upbeat animation class when a break is actively running
        const animClass = (activeBreak && activeBreak.status === 'active') ? ' active-anim' : '';
        card.innerHTML = `<div class="avatar ${avClass}${animClass}">${initials(p.name)}</div><div class="person-info"><div class="person-name">${availHtml} ${p.name} ${takenHtml} ${lateHtml} ${absentHtml} ${clockOutHtml}</div>${breakBadges}${paidHtml}<div class="person-timer${p.status === 'overdue' ? ' overdue' : ''}">${timerText}</div>${noteHtml}${editorHtml}${actions}</div><span class="status-badge ${sbClass}">${sbLabel}</span>`;
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
      avail++;
      const next = getNextScheduledBreak(p);
      if (next && (next.scheduledMs - now) < soon && (next.scheduledMs - now) > 0) upcoming++;
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
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    const tile = document.getElementById('ztile-' + zone);
    const cntEl = document.getElementById('zcnt-' + zone);
    if (cntEl) cntEl.textContent = cnt;
    if (tile) tile.className = 'zone-tile' + (cnt > ZONE_MAX[zone] ? ' over' : '');
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
          actions: [{ label: 'Mark returned', fn: `markReturned('${p.id}')` }] });
      } else {
        liveAlerts.push({ id: 'clockout-due-' + p.id, type: 'info',
          msg: `${p.name} should clock out — shift ended ${fmtTime(p.shiftEndMs)}` });
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
  sub.textContent = ZONE_LABELS[p.zone] + ' · ' + (p.type === 'break' ? `${BREAK_DUR['break']}-min break` : `${BREAK_DUR['lunch']}-min lunch`);
  const elapsed = getElapsedMin(p);
  const dur = getDur(p);
  const remaining = dur - elapsed;
  const shiftText = (p.shiftStartMs || p.shiftEndMs) ? `${fmtTime(p.shiftStartMs)} — ${fmtTime(p.shiftEndMs)}` : '—';
  // Offer start buttons when available. Offer "Mark taken" when a break/lunch is active or due.
  const now = Date.now();
  const next = getNextScheduledBreak(p);
  const hasDue = p.breaks && (p.breaks.find(b => b.status === 'active' || b.status === 'overdue') || (next && next.scheduledMs && next.scheduledMs <= now));
  let actionsHtml = '';
  if (p.status === 'available') {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn start-break" onclick="startBreak('${p.id}','break');closeModal()">Start ${BREAK_DUR['break']}-min break</button><button class="modal-btn start-lunch" onclick="startBreak('${p.id}','lunch');closeModal()">Start ${BREAK_DUR['lunch']}-min lunch</button></div>`;
  } else {
    actionsHtml += `<div class="modal-action-row"><button class="modal-btn mark-back" onclick="markReturned('${p.id}');closeModal()">Mark returned</button></div>`;
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

  const statusLabel = p.status === 'not_here' ? 'Not here' : (p.status === 'available' ? 'Available' : (p.status === 'break' ? 'On break' : (p.status === 'lunch' ? 'Lunch' : (p.status === 'overdue' ? 'Overdue' : p.status.charAt(0).toUpperCase()+p.status.slice(1)))));

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
  p.status = type === 'lunch' ? 'lunch' : 'break';
  p.type = type; p.startMs = now;
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
  syncPersonStatus(p); saveState(); showToast('Breaks updated'); render();
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
  saveState(); showToast(`${p.name} marked as returned`); render();
}

function removePerson(personId) {
  people = people.filter(x => x.id !== personId);
  saveState(); showToast('Team member removed'); render();
}

function addManual() {
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
}

function importSchedule() {
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
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function sendPushNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body, icon: '/icons/icon-192.png' });
}
let notifiedPush = new Set();
function checkPushNotifications() {
  if (!('Notification' in window)) return;
  // Notify for active/overdue breaks
  people.forEach(p => {
    // overdue break
    if (p.status === 'overdue') {
      const key = 'overdue:' + p.id;
      if (!notifiedPush.has(key) && Notification.permission === 'granted') {
        notifiedPush.add(key);
        sendPushNotification('Break overdue!', `${p.name} needs to return — ${ZONE_LABELS[p.zone]}`);
      }
    }
    // clock-out overdue (shift ended but still on break/lunch)
    if (p.clockOutOverdue) {
      const key = 'clockout:' + p.id;
      if (!notifiedPush.has(key) && Notification.permission === 'granted') {
        notifiedPush.add(key);
        sendPushNotification('Shift ended — clock out', `${p.name} still on break after shift end — ${ZONE_LABELS[p.zone]}`);
      }
    }
  });

  // Cleanup notifiedPush entries when condition clears or person removed
  notifiedPush.forEach(key => {
    const [type, id] = key.split(':');
    const p = people.find(x => x.id === id);
    if (!p) { notifiedPush.delete(key); return; }
    if (type === 'overdue' && p.status !== 'overdue') notifiedPush.delete(key);
    if (type === 'clockout' && !p.clockOutOverdue) notifiedPush.delete(key);
  });
  // If notifications aren't granted, optionally request once
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// ── Init ──────────────────────────────────────────────────────────────
loadState();
requestNotificationPermission();
render();
setInterval(() => { tick(); checkPushNotifications(); }, 15000);
updateClock();
setInterval(updateClock, 10000);
