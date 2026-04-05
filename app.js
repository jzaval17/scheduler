// ── State ──────────────────────────────────────────────────────────
const ZONE_MAX = { checklanes: 2, sco: 2, service: 1, driveup: 1 };
const ZONE_LABELS = { checklanes: 'Checklanes', sco: 'SCO', service: 'Service Desk', driveup: 'Drive Up' };
const BREAK_DUR = { break: 15, lunch: 30, lunch60: 60 };

// The Anthropic API key is no longer stored in the client. Requests
// are proxied to a server-side function at `/api/anthropic` which reads
// the key from server environment variables (e.g. Vercel Environment Variables).

let people = [];
let alerts = [];
let alertIdCounter = 0;
let toastTimer = null;
let activeTab = 'board';

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
  const active = person.breaks.find(b => b.status === 'active' || b.status === 'overdue');
  if (active) {
    person.status = active.status === 'overdue' ? 'overdue' : (active.type === 'break' ? 'break' : 'lunch');
    person.type = active.type;
    person.startMs = active.startMs || null;
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

    const order = { overdue: 0, break: 1, lunch: 2, available: 3 };
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
          avClass = 'av-break'; sbClass = 'sb-break'; sbLabel = '15-min break'; timerText = remaining > 0 ? `${remaining} min left` : 'time up';
        } else {
          avClass = 'av-lunch'; sbClass = 'sb-lunch'; sbLabel = `${dur}-min lunch`; timerText = remaining > 0 ? `${remaining} min left` : 'time up';
        }
      }

      const card = document.createElement('div');
      card.className = 'person-card' + (p.status === 'overdue' ? ' overdue' : '');
      card.innerHTML = `<div class="avatar ${avClass}">${initials(p.name)}</div><div class="person-info"><div class="person-name">${p.name}</div><div class="person-timer${p.status === 'overdue' ? ' overdue' : ''}">${timerText}</div></div><span class="status-badge ${sbClass}">${sbLabel}</span>`;
      card.onclick = () => openModal(p.id);
      list.appendChild(card);
    });
  });
}

function renderStats() {
  let avail = 0, onBreak = 0, overdue = 0, upcoming = 0;
  const now = Date.now();
  const soon = 20 * 60000;
  people.forEach(p => {
    if (p.status === 'overdue') overdue++;
    else if (p.status === 'break' || p.status === 'lunch') onBreak++;
    else {
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
}

function renderCoverage() {
  const active = people.filter(p => isActive(p)).length;
  const total = people.length || 1;
  const pct = Math.round((active / total) * 100);
  const label = pct >= 40 ? 'too many out' : pct >= 25 ? 'caution' : 'ok';
  const cls = pct >= 40 ? 'cov-danger' : pct >= 25 ? 'cov-warn' : 'cov-ok';
  const bfill = pct >= 40 ? 'bfill-danger' : pct >= 25 ? 'bfill-warn' : 'bfill-ok';

  const badge = document.getElementById('cov-total-badge');
  const bar = document.getElementById('cov-bar');
  const pctLbl = document.getElementById('cov-pct-label');
  if (badge) { badge.textContent = `${active} / ${people.length}`; badge.className = 'cov-badge ' + cls; }
  if (bar) { bar.style.width = Math.min(pct, 100) + '%'; bar.className = 'bar-fill ' + bfill; }
  if (pctLbl) pctLbl.textContent = `${pct}% — ${label}`;

  Object.keys(ZONE_MAX).forEach(zone => {
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    const tile = document.getElementById('ztile-' + zone);
    const cntEl = document.getElementById('zcnt-' + zone);
    if (cntEl) cntEl.textContent = cnt;
    if (tile) tile.className = 'zone-tile' + (cnt > ZONE_MAX[zone] ? ' over' : '');
  });

  const now = Date.now();
  const upcoming = people.filter(p => p.status === 'available' && p.scheduledMs && (p.scheduledMs - now) < 20*60000 && (p.scheduledMs - now) > 0)
    .sort((a, b) => a.scheduledMs - b.scheduledMs);
  const upEl = document.getElementById('upcoming-list');
  if (upEl) {
    upEl.innerHTML = upcoming.length === 0
      ? '<div class="empty-small">No upcoming breaks in the next 20 minutes.</div>'
      : upcoming.map(p => {
          const minsUntil = Math.round((p.scheduledMs - now) / 60000);
          return `<div class="upcoming-card"><div class="avatar av-break">${initials(p.name)}</div><div class="person-info"><div class="person-name">${p.name}</div><div class="person-detail">${ZONE_LABELS[p.zone]} — ${p.type === 'break' ? '15-min break' : 'lunch'}</div></div><span class="status-badge sb-upcoming">in ${minsUntil}m</span></div>`;
        }).join('');
  }
}

function renderAlerts() {
  const el = document.getElementById('alerts-inner');
  if (!el) return;
  alerts = alerts.filter(a => Date.now() - a.ts < 60*60000);

  const liveAlerts = [];
  people.filter(p => p.status === 'overdue').forEach(p => {
    const over = getElapsedMin(p) - getDur(p);
    liveAlerts.push({ id: 'overdue-' + p.id, type: 'urgent',
      msg: `${p.name} is ${over} min overdue from ${p.type} — ${ZONE_LABELS[p.zone]}`,
      actions: [{ label: 'Mark returned', fn: `markReturned('${p.id}')` }] });
  });
  Object.keys(ZONE_MAX).forEach(zone => {
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    if (cnt > ZONE_MAX[zone]) liveAlerts.push({ id: 'zone-' + zone, type: 'urgent',
      msg: `${cnt} people on break in ${ZONE_LABELS[zone]} — max is ${ZONE_MAX[zone]}`,
      actions: [{ label: 'View coverage', fn: "switchTab('coverage')" }] });
  });
  const now = Date.now();
  people.filter(p => p.status === 'available' && p.scheduledMs && (p.scheduledMs - now) < 15*60000 && (p.scheduledMs - now) > 0)
    .forEach(p => {
      const m = Math.round((p.scheduledMs - now) / 60000);
      liveAlerts.push({ id: 'upcoming-' + p.id, type: 'info',
        msg: `${p.name}'s ${p.type === 'break' ? 'break' : 'lunch'} is due in ${m} min — ${ZONE_LABELS[p.zone]} (${p.scheduledTime})` });
    });
  liveAlerts.push(...alerts.filter(a => a.type === 'ok'));

  const urgentCount = liveAlerts.filter(a => a.type === 'urgent').length;
  const badge = document.getElementById('alert-count');
  if (badge) { badge.textContent = urgentCount; badge.classList.toggle('hidden', urgentCount === 0); }

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
  const banner = document.getElementById('alert-banner');
  const text = document.getElementById('alert-text');
  if (!banner) return;
  if (overdue.length > 0) { banner.classList.remove('hidden'); text.textContent = `${overdue[0].name} is overdue from ${overdue[0].type} — tap for details`; }
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
  sub.textContent = ZONE_LABELS[p.zone] + ' · ' + (p.type === 'break' ? '15-min break' : '30-min lunch');
  const elapsed = getElapsedMin(p);
  const dur = getDur(p);
  const remaining = dur - elapsed;
  const shiftText = (p.shiftStartMs || p.shiftEndMs) ? `${fmtTime(p.shiftStartMs)} — ${fmtTime(p.shiftEndMs)}` : '—';
  let actionsHtml = p.status === 'available'
    ? `<div class="modal-action-row"><button class="modal-btn start-break" onclick="startBreak('${p.id}','break');closeModal()">Start 15-min break</button><button class="modal-btn start-lunch" onclick="startBreak('${p.id}','lunch');closeModal()">Start 30-min lunch</button></div><div class="modal-action-row"><button class="modal-btn remove" onclick="removePerson('${p.id}');closeModal()">Remove</button></div>`
    : `<div class="modal-action-row"><button class="modal-btn mark-back" onclick="markReturned('${p.id}');closeModal()">Mark returned</button><button class="modal-btn remove" onclick="removePerson('${p.id}');closeModal()">Remove</button></div>`;
  body.innerHTML = `${actionsHtml}
    <div class="modal-info-row"><span class="modal-info-label">Status</span><span class="modal-info-value">${p.status.charAt(0).toUpperCase()+p.status.slice(1)}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Zone</span><span class="modal-info-value">${ZONE_LABELS[p.zone]}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Shift</span><span class="modal-info-value">${shiftText}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Next break</span><span class="modal-info-value">${p.scheduledTime||'—'}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Break started</span><span class="modal-info-value">${p.startMs?fmtTime(p.startMs):'—'}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Time remaining</span><span class="modal-info-value">${isActive(p)?(remaining>0?remaining+' min':'Overdue by '+Math.abs(remaining)+' min'):'—'}</span></div>`;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

// ── Actions ───────────────────────────────────────────────────────────
function startBreak(personId, type) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
    p.status = type === 'lunch' ? 'lunch' : type;
  p.type = type; p.startMs = Date.now();
    saveState(); showToast(`${p.name} — ${type==='break'?'15-min break':type==='lunch'?'30-min lunch':''} started`); render();
}

function markReturned(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  pushAlert({ type: 'ok', msg: `${p.name} returned from ${p.type}` });
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
  const lunchDurVal = document.getElementById('manual-lunch-duration')?.value || '30';
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
  if (lunch && lunchDurVal !== 'none') breaks.push({ type: 'lunch', date: timeToDate(lunch), dur: 30 });
  if (secondBreak) breaks.push({ type: 'break', date: timeToDate(secondBreak), dur: 15 });

  if ((!firstBreak && !lunch && !secondBreak) && sStart && sEnd) {
    const durHours = (sEnd.getTime() - sStart.getTime()) / 3600000;
    if (durHours >= 2) {
      const b = new Date(sStart.getTime() + 2 * 3600000);
      if (b < sEnd) breaks.push({ type: 'break', date: b, dur: 15 });
    }
    if (durHours > 5 && lunchDurVal !== 'none') {
      const mid = new Date((sStart.getTime() + sEnd.getTime()) / 2);
      breaks.push({ type: 'lunch', date: mid, dur: 30 });
    }
    if (durHours > 6) {
      const b2 = new Date(sStart.getTime() + 6 * 3600000);
      if (b2 < sEnd) breaks.push({ type: 'break', date: b2, dur: 15 });
    }
  }

  if (breaks.length === 0 && !sStart && !sEnd) {
    showToast('No break times or shift provided — enter a time or shift start/end');
    return;
  }

  let created = 0;
  breaks.forEach(b => {
    if (!b.date) return;
    const scheduledMs = b.date.getTime();
    const scheduledTime = b.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    people.push({ id: uid(), name, zone, type: b.type, role: '', status: 'available', startMs: null, scheduledTime, scheduledMs, shiftStartMs: sStart ? sStart.getTime() : null, shiftEndMs: sEnd ? sEnd.getTime() : null });
    created++;
  });

  if (created === 0) { showToast('No valid break times to add'); return; }

  saveState();
  resetManualForm();
  showToast(`${name} — ${created} break${created>1?'s':''} added to ${ZONE_LABELS[zone]}`);
  switchTab('board');
}

function resetManualForm() {
  ['manual-name','manual-shift-start','manual-shift-end','manual-first-break','manual-lunch','manual-second-break'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const dur = document.getElementById('manual-lunch-duration'); if (dur) dur.value = '30';
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
    const typeLabel = row.type === 'break' ? '15-min break' : '30-min lunch';
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
  parsed.forEach(row => {
    people.push({ id: uid(), name: row.name, zone: row.zone, type: row.type, status: 'available', startMs: null, scheduledTime: row.displayTime, scheduledMs: row.scheduledMs });
  });
  saveState();
  document.getElementById('parsed-section').classList.add('hidden');
  document.getElementById('auto-assign-warning')?.remove();
  document.getElementById('import-success').classList.remove('hidden');
  const names = new Set(parsed.map(r => r.name)).size;
  showToast(`${names} team members imported (${parsed.length} break entries)`);
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
let notifiedOverdue = new Set();
function checkPushNotifications() {
  people.filter(p => p.status === 'overdue').forEach(p => {
    if (!notifiedOverdue.has(p.id)) { notifiedOverdue.add(p.id); sendPushNotification('Break overdue!', `${p.name} needs to return — ${ZONE_LABELS[p.zone]}`); }
  });
  notifiedOverdue.forEach(id => { const p = people.find(x => x.id === id); if (!p || !isActive(p)) notifiedOverdue.delete(id); });
}

// ── Init ──────────────────────────────────────────────────────────────
loadState();
requestNotificationPermission();
render();
setInterval(() => { tick(); checkPushNotifications(); }, 15000);
updateClock();
setInterval(updateClock, 10000);
