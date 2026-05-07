const $ = (s) => document.querySelector(s);

function getVoterId() {
  let id = localStorage.getItem('cv_voter_id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
         (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    localStorage.setItem('cv_voter_id', id);
  }
  return id;
}

const VOTER_ID = getVoterId();
const CITY_PREFIX = '伊東市';
const STATUS_LABEL = { '参加': '○ 参加', '未定': '未定' };
const STATUS_CLASS = { '参加': 'attend', '未定': 'undecided' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const TAB_HELP = {
  site: '🔒 匿名で集計します。誰が回答したかは表示されず、人数のみ共有されます。',
  event: '👤 名前を入力して記名で回答します。候補日時ごとに参加可否を投票できます。',
};

let currentTab = 'site';
let entries = [];
let editingEntry = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDateTime(dateStr, startTime, endTime) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  const wday = WEEKDAYS[dt.getDay()];
  let s = `${m}/${d}(${wday})`;
  if (startTime) {
    s += ` ${startTime}`;
    if (endTime) s += `〜${endTime}`;
  }
  return s;
}

function buildMapUrl(entry) {
  if (entry.map_url) return entry.map_url;
  if (!entry.title) return '';
  const q = entry.title.includes(CITY_PREFIX) ? entry.title : `${CITY_PREFIX} ${entry.title}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

async function loadEntries() {
  try {
    const res = await fetch(`/api/entries?type=${currentTab}`);
    const data = await res.json();
    entries = data.entries || [];
    render();
  } catch (e) {
    $('#entries-list').innerHTML = '<p class="empty">読み込みに失敗しました</p>';
  }
}

function render() {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === currentTab);
  });
  $('#tab-help').textContent = TAB_HELP[currentTab];
  $('#name-input-section').hidden = currentTab !== 'event';
  $('#add-card-site').hidden = currentTab !== 'site';
  $('#add-card-event').hidden = currentTab !== 'event';

  const list = $('#entries-list');
  if (entries.length === 0) {
    const word = currentTab === 'site' ? '現場' : 'イベント';
    list.innerHTML = `<p class="empty">まだ${word}がありません。下のフォームから追加してください。</p>`;
    return;
  }
  list.innerHTML = entries.map(currentTab === 'site' ? renderSiteCard : renderEventCard).join('');
  bindEntryButtons();
}

function renderSiteCard(entry) {
  const dateStr = formatDateTime(entry.date, entry.start_time, entry.end_time);
  const mapUrl = buildMapUrl(entry);
  const myResponse = entry.responses.find(r => r.voter_id === VOTER_ID);

  const counts = { '参加': 0, '未定': 0 };
  for (const r of entry.responses) {
    if (counts[r.status] !== undefined) counts[r.status]++;
  }

  const mapButton = `<a class="map-link ${entry.map_url ? '' : 'map-link-auto'}" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">🗺 ${entry.map_url ? '地図' : '検索'}</a>`;

  return `
    <article class="entry-card" data-id="${entry.id}">
      <div class="entry-header">
        <div class="entry-date-block">
          <span class="entry-date">${escapeHtml(dateStr)}</span>
        </div>
        <div class="entry-actions">
          ${mapButton}
          <button class="icon-btn" data-edit="${entry.id}" title="編集・削除">✎</button>
        </div>
      </div>
      <h3 class="entry-title">${escapeHtml(entry.title)}</h3>
      ${entry.details ? `<p class="entry-details">${escapeHtml(entry.details)}</p>` : ''}
      <div class="counts">
        <span class="count count-attend">${STATUS_LABEL['参加']} <strong>${counts['参加']}</strong></span>
        <span class="count count-undecided">${STATUS_LABEL['未定']} <strong>${counts['未定']}</strong></span>
      </div>
      <div class="my-vote">
        <span class="my-vote-label">あなたの回答：</span>
        <div class="vote-buttons">
          ${['参加', '未定'].map(st => `
            <button class="vote-btn vote-${STATUS_CLASS[st]} ${myResponse?.status === st ? 'selected' : ''}" data-vote="${st}" data-iid="${entry.id}">${STATUS_LABEL[st]}</button>
          `).join('')}
          ${myResponse ? `<button class="vote-btn vote-clear" data-clear="${entry.id}" title="自分の回答を取り消す">取消</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function renderEventCard(entry) {
  const mapUrl = buildMapUrl(entry);
  const mapButton = `<a class="map-link ${entry.map_url ? '' : 'map-link-auto'}" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">🗺 ${entry.map_url ? '地図' : '検索'}</a>`;

  const slotsHtml = (entry.slots || []).map(slot => {
    const dateStr = formatDateTime(slot.date, slot.start_time, slot.end_time);
    const mine = slot.responses.find(r => r.voter_id === VOTER_ID);
    const byStatus = { '参加': [], '未定': [] };
    for (const r of slot.responses) {
      if (byStatus[r.status]) byStatus[r.status].push(r);
    }
    const chipsHtml = ['参加', '未定']
      .filter(st => byStatus[st].length > 0)
      .map(st => `
        <div class="chip-row">
          <span class="chip-label chip-${STATUS_CLASS[st]}">${STATUS_LABEL[st]} (${byStatus[st].length})</span>
          ${byStatus[st].map(r => `<span class="chip">${escapeHtml(r.voter_name || '匿名')}</span>`).join('')}
        </div>
      `).join('');
    return `
      <div class="slot-row" data-slot-id="${slot.id}">
        <div class="slot-date">${escapeHtml(dateStr)}</div>
        <div class="slot-chips">${chipsHtml || '<p class="no-response">まだ回答がありません</p>'}</div>
        <div class="slot-vote">
          ${['参加', '未定'].map(st => `
            <button class="vote-btn vote-${STATUS_CLASS[st]} ${mine?.status === st ? 'selected' : ''}" data-event-vote="${entry.id}" data-slot="${slot.id}" data-status="${st}">${STATUS_LABEL[st]}</button>
          `).join('')}
          ${mine ? `<button class="vote-btn vote-clear" data-event-clear="${entry.id}" data-slot="${slot.id}">取消</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <article class="entry-card event-card" data-id="${entry.id}">
      <div class="entry-header">
        <div class="entry-date-block">
          <span class="entry-tag">イベント</span>
        </div>
        <div class="entry-actions">
          ${entry.map_url ? mapButton : ''}
          <button class="icon-btn" data-edit="${entry.id}" title="編集・削除">✎</button>
        </div>
      </div>
      <h3 class="entry-title">${escapeHtml(entry.title)}</h3>
      ${entry.details ? `<p class="entry-details">${escapeHtml(entry.details)}</p>` : ''}
      <div class="slots-section">
        <div class="slots-header">📅 候補日時</div>
        ${slotsHtml || '<p class="no-response">候補日時がありません</p>'}
      </div>
    </article>
  `;
}

function bindEntryButtons() {
  document.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', onSiteVote));
  document.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', onClearSiteVote));
  document.querySelectorAll('[data-event-vote]').forEach(b => b.addEventListener('click', onEventVote));
  document.querySelectorAll('[data-event-clear]').forEach(b => b.addEventListener('click', onClearEventVote));
  document.querySelectorAll('[data-edit]').forEach(b => {
    b.addEventListener('click', () => openEdit(parseInt(b.dataset.edit, 10)));
  });
}

async function onSiteVote(e) {
  const btn = e.currentTarget;
  const iid = parseInt(btn.dataset.iid, 10);
  const status = btn.dataset.vote;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/entries/${iid}/response`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ voter_id: VOTER_ID, status }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    await loadEntries();
  } catch (err) {
    alert('保存に失敗しました：' + err.message);
    btn.disabled = false;
  }
}

async function onClearSiteVote(e) {
  const iid = parseInt(e.currentTarget.dataset.clear, 10);
  if (!confirm('あなたの回答を取り消しますか？')) return;
  try {
    const res = await fetch(`/api/entries/${iid}/response`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ voter_id: VOTER_ID }),
    });
    if (!res.ok) throw new Error('failed');
    await loadEntries();
  } catch (err) {
    alert('取消に失敗しました');
  }
}

async function onEventVote(e) {
  const btn = e.currentTarget;
  const iid = parseInt(btn.dataset.eventVote, 10);
  const slotId = parseInt(btn.dataset.slot, 10);
  const status = btn.dataset.status;

  const voter_name = ($('#my-name').value || '').trim();
  if (!voter_name) {
    alert('上の「あなたの名前」を先に入力してください');
    $('#my-name').focus();
    return;
  }
  localStorage.setItem('cv_my_name', voter_name);

  btn.disabled = true;
  try {
    const res = await fetch(`/api/entries/${iid}/slots/${slotId}/response`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ voter_id: VOTER_ID, voter_name, status }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    await loadEntries();
  } catch (err) {
    alert('保存に失敗しました：' + err.message);
    btn.disabled = false;
  }
}

async function onClearEventVote(e) {
  const btn = e.currentTarget;
  const iid = parseInt(btn.dataset.eventClear, 10);
  const slotId = parseInt(btn.dataset.slot, 10);
  if (!confirm('この候補日時の回答を取り消しますか？')) return;
  try {
    const res = await fetch(`/api/entries/${iid}/slots/${slotId}/response`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ voter_id: VOTER_ID }),
    });
    if (!res.ok) throw new Error('failed');
    await loadEntries();
  } catch (err) {
    alert('取消に失敗しました');
  }
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    if (t.dataset.tab === currentTab) return;
    currentTab = t.dataset.tab;
    loadEntries();
  });
});

const savedName = localStorage.getItem('cv_my_name');
if (savedName) $('#my-name').value = savedName;
$('#my-name').addEventListener('change', () => {
  localStorage.setItem('cv_my_name', $('#my-name').value.trim());
});

// ========== ADD SITE ==========
$('#add-form-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#new-site-title').value.trim();
  const date = $('#new-site-date').value;
  const start_time = $('#new-site-start').value;
  const end_time = $('#new-site-end').value;
  const details = $('#new-site-details').value.trim();
  const map_url = $('#new-site-map').value.trim();
  if (!title || !date || !start_time) return;

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'site', title, date, start_time, end_time, details, map_url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    $('#new-site-title').value = '';
    $('#new-site-date').value = '';
    $('#new-site-start').value = '06:30';
    $('#new-site-end').value = '';
    $('#new-site-details').value = '';
    $('#new-site-map').value = '';
    $('#new-site-title').focus();
    await loadEntries();
  } catch (err) {
    alert('追加に失敗しました：' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ========== ADD EVENT (multi-slot) ==========
function makeSlotRow(date = '', start_time = '19:00', end_time = '') {
  const div = document.createElement('div');
  div.className = 'slot-input-row';
  div.innerHTML = `
    <input type="date" class="slot-date-input" value="${escapeHtml(date)}" required>
    <input type="time" class="slot-start-input" value="${escapeHtml(start_time)}" step="300" required>
    <input type="time" class="slot-end-input" value="${escapeHtml(end_time)}" step="300" placeholder="終了(任意)">
    <button type="button" class="slot-remove-btn" title="削除">×</button>
  `;
  div.querySelector('.slot-remove-btn').addEventListener('click', () => div.remove());
  return div;
}

function collectSlots(containerSel) {
  const rows = document.querySelectorAll(`${containerSel} .slot-input-row`);
  const slots = [];
  for (const row of rows) {
    const date = row.querySelector('.slot-date-input').value;
    const start_time = row.querySelector('.slot-start-input').value;
    const end_time = row.querySelector('.slot-end-input').value;
    if (date && start_time) slots.push({ date, start_time, end_time });
  }
  return slots;
}

$('#add-slot-btn').addEventListener('click', () => {
  $('#new-slots').appendChild(makeSlotRow());
});

// Start with one slot row
$('#new-slots').appendChild(makeSlotRow());

$('#add-form-event').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#new-event-title').value.trim();
  const details = $('#new-event-details').value.trim();
  const map_url = $('#new-event-map').value.trim();
  const slots = collectSlots('#new-slots');
  if (!title) { alert('イベント名を入力してください'); return; }
  if (slots.length === 0) { alert('候補日時を1つ以上追加してください'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'event', title, details, map_url, slots }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    $('#new-event-title').value = '';
    $('#new-event-details').value = '';
    $('#new-event-map').value = '';
    $('#new-slots').innerHTML = '';
    $('#new-slots').appendChild(makeSlotRow());
    await loadEntries();
  } catch (err) {
    alert('作成に失敗しました：' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ========== EDIT ==========
function openEdit(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  editingEntry = entry;

  $('#edit-dialog-title').textContent = entry.type === 'site' ? '現場を編集' : 'イベントを編集';
  $('#edit-title-label').textContent = entry.type === 'site' ? '現場名' : 'イベント名';
  $('#edit-title-input').value = entry.title;
  $('#edit-details').value = entry.details || '';
  $('#edit-map').value = entry.map_url || '';

  $('#edit-site-fields').hidden = entry.type !== 'site';
  $('#edit-event-fields').hidden = entry.type !== 'event';

  if (entry.type === 'site') {
    $('#edit-date').value = entry.date;
    $('#edit-start').value = entry.start_time;
    $('#edit-end').value = entry.end_time || '';
  } else {
    const slotsContainer = $('#edit-slots');
    slotsContainer.innerHTML = '';
    for (const s of (entry.slots || [])) {
      slotsContainer.appendChild(makeSlotRow(s.date, s.start_time, s.end_time || ''));
    }
    if ((entry.slots || []).length === 0) {
      slotsContainer.appendChild(makeSlotRow());
    }
  }

  $('#edit-dialog').showModal();
}

$('#edit-add-slot-btn').addEventListener('click', () => {
  $('#edit-slots').appendChild(makeSlotRow());
});

$('#edit-cancel').addEventListener('click', () => {
  editingEntry = null;
  $('#edit-dialog').close();
});

$('#edit-save').addEventListener('click', async () => {
  if (!editingEntry) return;
  const id = editingEntry.id;
  const type = editingEntry.type;
  const title = $('#edit-title-input').value.trim();
  const details = $('#edit-details').value.trim();
  const map_url = $('#edit-map').value.trim();
  const body = { type, title, details, map_url };

  if (type === 'site') {
    body.date = $('#edit-date').value;
    body.start_time = $('#edit-start').value;
    body.end_time = $('#edit-end').value;
    if (!title || !body.date || !body.start_time) {
      alert('現場名・日付・開始時刻は必須です');
      return;
    }
  } else {
    body.slots = collectSlots('#edit-slots');
    if (!title || body.slots.length === 0) {
      alert('イベント名と候補日時（1つ以上）は必須です');
      return;
    }
  }

  try {
    const res = await fetch(`/api/entries/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    editingEntry = null;
    $('#edit-dialog').close();
    await loadEntries();
  } catch (err) {
    alert('保存に失敗しました：' + err.message);
  }
});

$('#edit-delete').addEventListener('click', async () => {
  if (!editingEntry) return;
  if (!confirm('この行を削除します。よろしいですか？\n（紐づく回答もすべて削除されます）')) return;
  try {
    const res = await fetch(`/api/entries/${editingEntry.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('failed');
    editingEntry = null;
    $('#edit-dialog').close();
    await loadEntries();
  } catch (err) {
    alert('削除に失敗しました');
  }
});

loadEntries();
setInterval(() => {
  if (!$('#edit-dialog').open) loadEntries();
}, 15000);
