// ── State ──────────────────────────────────────────────────────────
const ZONE_MAX = { checklanes: 2, sco: 2, service: 1, driveup: 1 };
const ZONE_LABELS = { checklanes: 'Checklanes', sco: 'SCO', service: 'Service Desk', driveup: 'Drive Up' };
const BREAK_DUR = { break: 15, lunch: 30, lunch60: 60 };

let people = [];
let alerts = [];
let alertIdCounter = 0;
let toastTimer = null;
let activeTab = 'board';

// Load from localStorage on start
function loadState() {
  try {
    const saved = localStorage.getItem('bm_people');
    if (saved) people = JSON.parse(saved);
    // Re-hydrate startMs from stored timestamps
    people.forEach(p => {
      if (p.startMs) p.startMs = Number(p.startMs);
    });
  } catch(e) { people = []; }
}

function saveState() {
  try { localStorage.setItem('bm_people', JSON.stringify(people)); } catch(e) {}
}

// ── Helpers ─────────────────────────────────────────────────────────
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

function getDur(p) {
  return BREAK_DUR[p.type] || 15;
}

// Infer a default role/assignment when tasks/role are not provided.
function inferRole(zone, tasks) {
  if (tasks && tasks.length) return tasks;
  switch (zone) {
    case 'sco': return 'SCO / Self-Checkout';
    case 'service': return 'Guest Service / Service Desk';
    case 'driveup': return 'Drive Up / Fulfillment';
    case 'checklanes':
    default:
      return 'Front End / Cashier';
  }
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function uid() {
  return Date.now() + Math.random().toString(36).slice(2, 7);
}

// ── Clock ────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('topbar-time');
  const dateEl = document.getElementById('topbar-date');
  if (timeEl) timeEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dateEl) dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Tick: update overdue status ──────────────────────────────────────
function tick() {
  let changed = false;
  people.forEach(p => {
    if ((p.status === 'break' || p.status === 'lunch') && p.startMs) {
      const elapsed = getElapsedMin(p);
      if (elapsed >= getDur(p)) {
        p.status = 'overdue';
        changed = true;
        pushAlert({ type: 'urgent', msg: `${p.name} is overdue from ${p.type} — ${ZONE_LABELS[p.zone]}`, personId: p.id });
      }
    }
  });
  if (changed) saveState();
  render();
}

// ── Rendering ────────────────────────────────────────────────────────
function render() {
  renderBoard();
  renderStats();
  renderCoverage();
  renderAlerts();
  renderAlertBanner();
  updateClock();
}

function renderBoard() {
  const zones = ['checklanes', 'sco', 'service', 'driveup'];
  let anyPeople = people.length > 0;

  const emptyEl = document.getElementById('board-empty');
  if (emptyEl) emptyEl.classList.toggle('hidden', anyPeople);

  zones.forEach(zone => {
    const list = document.getElementById('list-' + zone);
    const group = document.getElementById('zone-' + zone + '-group');
    const pill = document.getElementById('pill-' + zone);
    if (!list) return;

    const zonePeople = people.filter(p => p.zone === zone);
    const onBreak = zonePeople.filter(p => isActive(p)).length;
    const max = ZONE_MAX[zone];

    // Zone pill
    if (pill) {
      if (onBreak > max) {
        pill.textContent = `${onBreak}/${max} — over limit`;
        pill.className = 'zone-pill pill-danger';
      } else if (onBreak === max) {
        pill.textContent = `${onBreak}/${max} — at limit`;
        pill.className = 'zone-pill pill-warn';
      } else {
        pill.textContent = `${onBreak}/${max} on break`;
        pill.className = 'zone-pill pill-ok';
      }
    }

    list.innerHTML = '';
    if (zonePeople.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty-small';
      em.textContent = 'No team members in this zone.';
      list.appendChild(em);
      return;
    }

    // Sort: overdue first, then on break, then upcoming by time
    const sorted = [...zonePeople].sort((a, b) => {
      const order = { overdue: 0, break: 1, lunch: 2, available: 3 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

    sorted.forEach(p => {
      const card = document.createElement('div');
      const elapsed = getElapsedMin(p);
      const dur = getDur(p);
      const remaining = dur - elapsed;

      let avClass = 'av-available', sbClass = 'sb-available', sbLabel = 'Available';
      let timerText = p.scheduledTime ? `Break at ${p.scheduledTime}` : '';

      if (p.status === 'break') {
        avClass = 'av-break'; sbClass = 'sb-break'; sbLabel = '15-min break';
        timerText = remaining > 0 ? `${remaining} min left` : 'time up';
      } else if (p.status === 'lunch') {
        avClass = 'av-lunch'; sbClass = 'sb-lunch'; sbLabel = `${dur}-min lunch`;
        timerText = remaining > 0 ? `${remaining} min left` : 'time up';
      } else if (p.status === 'overdue') {
        avClass = 'av-overdue'; sbClass = 'sb-overdue'; sbLabel = 'Overdue!';
        timerText = `+${Math.abs(remaining)} min overdue`;
      }

      card.className = 'person-card' + (p.status === 'overdue' ? ' overdue' : '');
      card.innerHTML = `
        <div class="avatar ${avClass}">${initials(p.name)}</div>
        <div class="person-info">
          <div class="person-name">${p.name}</div>
          <div class="person-timer${p.status === 'overdue' ? ' overdue' : ''}">${timerText}</div>
        </div>
        <span class="status-badge ${sbClass}">${sbLabel}</span>
      `;
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
    else if (p.status === 'available') {
      avail++;
      if (p.scheduledMs && (p.scheduledMs - now) < soon && (p.scheduledMs - now) > 0) upcoming++;
    }
  });
  const s = n => document.getElementById(n);
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
  if (bar)   { bar.style.width = Math.min(pct, 100) + '%'; bar.className = 'bar-fill ' + bfill; }
  if (pctLbl) pctLbl.textContent = `${pct}% — ${label}`;

  // Zone tiles
  Object.keys(ZONE_MAX).forEach(zone => {
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    const tile = document.getElementById('ztile-' + zone);
    const cntEl = document.getElementById('zcnt-' + zone);
    if (cntEl) cntEl.textContent = cnt;
    if (tile) tile.className = 'zone-tile' + (cnt > ZONE_MAX[zone] ? ' over' : '');
  });

  // Upcoming list
  const now = Date.now();
  const soon = 20 * 60000;
  const upcoming = people.filter(p => p.status === 'available' && p.scheduledMs && (p.scheduledMs - now) < soon && (p.scheduledMs - now) > 0)
    .sort((a, b) => a.scheduledMs - b.scheduledMs);

  const upEl = document.getElementById('upcoming-list');
  if (upEl) {
    upEl.innerHTML = '';
    if (upcoming.length === 0) {
      upEl.innerHTML = '<div class="empty-small">No upcoming breaks in the next 20 minutes.</div>';
    } else {
      upcoming.forEach(p => {
        const card = document.createElement('div');
        card.className = 'upcoming-card';
        const minsUntil = Math.round((p.scheduledMs - now) / 60000);
        card.innerHTML = `
          <div class="avatar av-break">${initials(p.name)}</div>
          <div class="person-info">
            <div class="person-name">${p.name}</div>
            <div class="person-detail">${ZONE_LABELS[p.zone]} — ${p.type === 'break' ? '15-min break' : 'lunch'}</div>
          </div>
          <span class="status-badge sb-upcoming">in ${minsUntil}m</span>
        `;
        upEl.appendChild(card);
      });
    }
  }
}

function renderAlerts() {
  const el = document.getElementById('alerts-inner');
  const emptyEl = document.getElementById('alerts-empty');
  if (!el) return;

  // Remove stale auto-alerts older than 60 min
  alerts = alerts.filter(a => Date.now() - a.ts < 60 * 60000);

  // Build current alerts from state
  const liveAlerts = [];

  // Overdue
  people.filter(p => p.status === 'overdue').forEach(p => {
    const elapsed = getElapsedMin(p);
    const dur = getDur(p);
    liveAlerts.push({
      id: 'overdue-' + p.id,
      type: 'urgent',
      msg: `${p.name} is ${elapsed - dur} min overdue from ${p.type} — ${ZONE_LABELS[p.zone]}`,
      actions: [
        { label: 'Mark returned', fn: `markReturned('${p.id}')` },
      ]
    });
  });

  // Zone over limit
  Object.keys(ZONE_MAX).forEach(zone => {
    const cnt = people.filter(p => p.zone === zone && isActive(p)).length;
    if (cnt > ZONE_MAX[zone]) {
      liveAlerts.push({
        id: 'zone-' + zone,
        type: 'urgent',
        msg: `${cnt} people on break in ${ZONE_LABELS[zone]} — max is ${ZONE_MAX[zone]}`,
        actions: [{ label: 'View coverage', fn: "switchTab('coverage')" }]
      });
    }
  });

  // Upcoming in 15 min
  const now = Date.now();
  people.filter(p => p.status === 'available' && p.scheduledMs && (p.scheduledMs - now) < 15 * 60000 && (p.scheduledMs - now) > 0)
    .forEach(p => {
      const minsUntil = Math.round((p.scheduledMs - now) / 60000);
      liveAlerts.push({
        id: 'upcoming-' + p.id,
        type: 'info',
        msg: `${p.name}'s ${p.type === 'break' ? 'break' : 'lunch'} is due in ${minsUntil} min — ${ZONE_LABELS[p.zone]} (${p.scheduledTime})`,
      });
    });

  // Completed (from stored alerts)
  const completed = alerts.filter(a => a.type === 'ok');
  liveAlerts.push(...completed.map(a => ({ ...a, type: 'ok' })));

  // Badge
  const urgentCount = liveAlerts.filter(a => a.type === 'urgent').length;
  const badge = document.getElementById('alert-count');
  if (badge) {
    badge.textContent = urgentCount;
    badge.classList.toggle('hidden', urgentCount === 0);
  }

  // Render
  el.innerHTML = '';
  if (liveAlerts.length === 0) {
    el.innerHTML = '<div class="empty-small">No active alerts. All good!</div>';
    return;
  }

  liveAlerts.forEach(a => {
    const item = document.createElement('div');
    item.className = `alert-item ${a.type}`;
    const ts = a.ts ? fmtTime(a.ts) : '';
    const actionsHtml = (a.actions || []).map(act =>
      `<button class="btn-tiny" onclick="${act.fn}">${act.label}</button>`
    ).join('');
    item.innerHTML = `
      <div class="alert-dot2 ad-${a.type}"></div>
      <div class="alert-body">
        <div class="alert-msg">${a.msg}</div>
        ${ts ? `<div class="alert-ts">${ts}</div>` : ''}
        ${actionsHtml ? `<div class="alert-actions">${actionsHtml}</div>` : ''}
      </div>
    `;
    el.appendChild(item);
  });
}

function renderAlertBanner() {
  const overdue = people.filter(p => p.status === 'overdue');
  const zoneOver = Object.keys(ZONE_MAX).some(zone =>
    people.filter(p => p.zone === zone && isActive(p)).length > ZONE_MAX[zone]
  );

  const banner = document.getElementById('alert-banner');
  const text = document.getElementById('alert-text');
  if (!banner) return;

  if (overdue.length > 0) {
    banner.classList.remove('hidden');
    text.textContent = `${overdue[0].name} is overdue from ${overdue[0].type} — tap for details`;
  } else if (zoneOver) {
    banner.classList.remove('hidden');
    text.textContent = 'Coverage alert: too many on break in a zone';
  } else {
    banner.classList.add('hidden');
  }
}

// ── Tab switching ────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ['board', 'coverage', 'upload', 'alerts'].forEach(t => {
    document.getElementById('view-' + t)?.classList.toggle('active', t === tab);
    document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
  });
  render();
}

// ── Person modal ─────────────────────────────────────────────────────
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
  sub.textContent = ZONE_LABELS[p.zone] + ' · ' + (p.type === 'break' ? '15-min break' : p.type === 'lunch' ? '30-min lunch' : '60-min lunch');

  // Info rows
  const elapsed = getElapsedMin(p);
  const dur = getDur(p);
  const remaining = dur - elapsed;

  let actionsHtml = '';
  if (p.status === 'available') {
    actionsHtml = `
      <div class="modal-action-row">
        <button class="modal-btn start-break" onclick="startBreak('${p.id}', 'break'); closeModal()">Start 15-min break</button>
        <button class="modal-btn start-lunch" onclick="startBreak('${p.id}', 'lunch'); closeModal()">Start 30-min lunch</button>
      </div>
      <div class="modal-action-row">
        <button class="modal-btn start-lunch" onclick="startBreak('${p.id}', 'lunch60'); closeModal()">Start 60-min lunch</button>
        <button class="modal-btn remove" onclick="removePerson('${p.id}'); closeModal()">Remove</button>
      </div>
    `;
  } else {
    actionsHtml = `
      <div class="modal-action-row">
        <button class="modal-btn mark-back" onclick="markReturned('${p.id}'); closeModal()">Mark returned</button>
        <button class="modal-btn remove" onclick="removePerson('${p.id}'); closeModal()">Remove</button>
      </div>
    `;
  }

  body.innerHTML = `
    ${actionsHtml}
    <div class="modal-info-row"><span class="modal-info-label">Status</span><span class="modal-info-value">${p.status.charAt(0).toUpperCase() + p.status.slice(1)}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Scheduled</span><span class="modal-info-value">${p.scheduledTime || '—'}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Break started</span><span class="modal-info-value">${p.startMs ? fmtTime(p.startMs) : '—'}</span></div>
    <div class="modal-info-row"><span class="modal-info-label">Time remaining</span><span class="modal-info-value">${isActive(p) ? (remaining > 0 ? remaining + ' min' : 'Overdue by ' + Math.abs(remaining) + ' min') : '—'}</span></div>
  `;

  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

// ── Actions ──────────────────────────────────────────────────────────
function startBreak(personId, type) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  p.status = type === 'lunch60' ? 'lunch' : type;
  p.type = type;
  p.startMs = Date.now();
  saveState();
  showToast(`${p.name} — ${type === 'break' ? '15-min break' : type === 'lunch' ? '30-min lunch' : '60-min lunch'} started`);
  render();
}

function markReturned(personId) {
  const p = people.find(x => x.id === personId);
  if (!p) return;
  pushAlert({ type: 'ok', msg: `${p.name} returned from ${p.type} on time` });
  p.status = 'available';
  p.startMs = null;
  saveState();
  showToast(`${p.name} marked as returned`);
  render();
}

function removePerson(personId) {
  people = people.filter(x => x.id !== personId);
  saveState();
  showToast('Team member removed');
  render();
}

function addManual() {
  const name = document.getElementById('manual-name')?.value.trim();
  if (!name) { showToast('Please enter a name'); return; }
  const timeVal = document.getElementById('manual-time')?.value;
  const type = document.getElementById('manual-type')?.value || 'break';
  const zone = document.getElementById('manual-zone')?.value || 'checklanes';

  let scheduledTime = '';
  let scheduledMs = null;
  if (timeVal) {
    const [h, m] = timeVal.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    scheduledMs = d.getTime();
    scheduledTime = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  people.push({ id: uid(), name, zone, type, status: 'available', startMs: null, scheduledTime, scheduledMs });
  saveState();
  if (document.getElementById('manual-name')) document.getElementById('manual-name').value = '';
  showToast(`${name} added to ${ZONE_LABELS[zone]}`);
  switchTab('board');
}

function confirmReset() {
  if (confirm('Clear all team members and start a fresh shift?')) {
    people = [];
    alerts = [];
    saveState();
    showToast('Shift reset — ready for a new day');
    render();
  }
}

// ── AI Schedule Scanner ───────────────────────────────────────────────
async function handleFileUpload(input) {
  const file = input.files[0];
  if (!file) return;

  // Show loading
  document.getElementById('upload-box').classList.add('hidden');
  document.getElementById('scan-loading').classList.remove('hidden');

  try {
    // Convert image to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const mediaType = file.type || 'image/jpeg';

    // Call Claude API with vision
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: `You are reading a Target store break schedule. Extract every team member's break or lunch assignment.

Return ONLY a JSON array, no other text, no markdown. Each item:
{
  "name": "First Last",
  "time": "2:30 PM",
  "type": "break" | "lunch" | "lunch60",
  "zone": "checklanes" | "sco" | "service" | "driveup"
}

Rules:
- "break" = 15-minute break
- "lunch" = 30-minute lunch  
- "lunch60" = 60-minute lunch
- Zones: map "front end" or "lanes" to "checklanes", "self checkout" to "sco", "guest service" or "service desk" to "service", "OPU" or "drive up" or "fulfillment" to "driveup"
- If zone is unclear, default to "checklanes"
- If time is unclear, omit the time field

Return only the JSON array.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';

    let parsed = [];
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      throw new Error('Could not read schedule from image. Try a clearer photo.');
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('No schedule data found in image. Try a clearer photo.');
    }

    showParsedResults(parsed);

  } catch (err) {
    document.getElementById('scan-loading').classList.add('hidden');
    document.getElementById('upload-box').classList.remove('hidden');
    showToast(err.message || 'Error reading image. Please try again.');
    console.error(err);
  }

  // Reset file input
  input.value = '';
}

function showParsedResults(parsed) {
  document.getElementById('scan-loading').classList.add('hidden');

  const list = document.getElementById('parsed-list');
  const countEl = document.getElementById('parsed-count');
  list.innerHTML = '';

  if (countEl) countEl.textContent = `${parsed.length} people found`;

  // Store for import
  // Attach inferred roles for rows that lack `tasks` or `role`.
  parsed.forEach(row => {
    // Normalize zone to default if missing
    row.zone = row.zone || 'checklanes';
    if (!row.tasks && !row.role) {
      row.assignedRole = inferRole(row.zone, row.tasks || '');
    } else {
      row.assignedRole = row.role || (row.tasks ? row.tasks : '');
    }
  });
  window._parsedSchedule = parsed;

  // Build assignment warning list
  const assignListEl = document.getElementById('parsed-assign-list');
  const assignWarningEl = document.getElementById('parsed-assign-warning');
  const autoAssigned = parsed.filter(r => r.assignedRole && (!r.role && !r.tasks));
  if (assignListEl) {
    if (autoAssigned.length === 0) {
      assignWarningEl?.classList.add('hidden');
    } else {
      assignWarningEl?.classList.remove('hidden');
      assignListEl.innerHTML = autoAssigned.map(r => `<div style="padding:6px 0; border-bottom:1px solid var(--gray-100)"><strong>${r.name}</strong> → ${r.assignedRole}</div>`).join('');
    }
  }

  parsed.forEach(row => {
    const div = document.createElement('div');
    div.className = 'parsed-row';
    const typeLabel = row.type === 'break' ? '15-min break' : row.type === 'lunch60' ? '60-min lunch' : '30-min lunch';
    const typeCls = row.type === 'break' ? 'pt-break' : 'pt-lunch';
    div.innerHTML = `
      <span class="parsed-name">${row.name}</span>
      <span class="parsed-meta">${ZONE_LABELS[row.zone] || row.zone}${row.time ? ' · ' + row.time : ''}</span>
      <span class="parsed-type ${typeCls}">${typeLabel}</span>
    `;
    list.appendChild(div);
  });

  document.getElementById('parsed-section').classList.remove('hidden');
}

function importSchedule() {
  const parsed = window._parsedSchedule || [];
  parsed.forEach(row => {
    let scheduledMs = null;
    let scheduledTime = row.time || '';
    if (row.time) {
      // Parse time like "2:30 PM"
      const match = row.time.match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (match) {
        let h = parseInt(match[1]);
        const m = parseInt(match[2]);
        const ampm = match[3]?.toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        const d = new Date(); d.setHours(h, m, 0, 0);
        scheduledMs = d.getTime();
        scheduledTime = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
    }
    const zone = row.zone || 'checklanes';
    // Use assignedRole (inferred) if present, otherwise any provided role/tasks
    const role = row.assignedRole || row.role || (row.tasks ? row.tasks : '');
    people.push({
      id: uid(),
      name: row.name,
      zone,
      type: row.type || 'break',
      role: role,
      status: 'available',
      startMs: null,
      scheduledTime,
      scheduledMs
    });
  });

  saveState();
  document.getElementById('parsed-section').classList.add('hidden');
  document.getElementById('import-success').classList.remove('hidden');
  showToast(`${parsed.length} team members imported`);
}

function resetUpload() {
  document.getElementById('parsed-section').classList.add('hidden');
  document.getElementById('import-success').classList.add('hidden');
  document.getElementById('upload-box').classList.remove('hidden');
  window._parsedSchedule = [];
}

// ── Alert helpers ────────────────────────────────────────────────────
function pushAlert(alert) {
  alert.id = alert.id || ('alert-' + alertIdCounter++);
  alert.ts = Date.now();
  // Dedupe
  if (!alerts.find(a => a.id === alert.id && a.type === alert.type)) {
    alerts.unshift(alert);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

// ── PWA Service Worker ────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Push notifications (browser) ──────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendPushNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
  }
}

// Watch for overdue and send push
let notifiedOverdue = new Set();
function checkPushNotifications() {
  people.filter(p => p.status === 'overdue').forEach(p => {
    if (!notifiedOverdue.has(p.id)) {
      notifiedOverdue.add(p.id);
      sendPushNotification('Break overdue', `${p.name} needs to return from ${p.type} — ${ZONE_LABELS[p.zone]}`);
    }
  });
  // Clear from set if they return
  notifiedOverdue.forEach(id => {
    const p = people.find(x => x.id === id);
    if (!p || !isActive(p)) notifiedOverdue.delete(id);
  });
}

// ── Init ─────────────────────────────────────────────────────────────
loadState();
requestNotificationPermission();
render();
setInterval(() => { tick(); checkPushNotifications(); }, 15000);
updateClock();
setInterval(updateClock, 10000);
