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
const STATUS_LABEL = { '参加': '○ 参加', '不参加': '× 不参加', '未定': '未定' };
const STATUS_CLASS = { '参加': 'attend', '不参加': 'absent', '未定': 'undecided' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const TAB_HELP = {
  site: '🔒 匿名で集計します。誰が回答したかは表示されず、人数のみ共有されます。',
  event: '👤 名前を入力して記名で回答します。誰が参加するかが共有されます。',
};

let currentTab = 'site';
let entries = [];
let editingId = null;

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
  $('#add-title').textContent = currentTab === 'site' ? '+ 現場を追加' : '+ イベントを追加';
  $('#title-label').firstChild.textContent = currentTab === 'site' ? '現場名 ' : 'イベント名 ';
  $('#new-title').placeholder = currentTab === 'site' ? '例：大室山' : '例：定例ミーティング';
  $('#edit-title-label').textContent = currentTab === 'site' ? '現場名' : 'イベント名';

  const list = $('#entries-list');
  if (entries.length === 0) {
    const word = currentTab === 'site' ? '現場' : 'イベント';
    list.innerHTML = `<p class="empty">まだ${word}がありません。下のフォームから追加してください。</p>`;
    return;
  }
  list.innerHTML = entries.map(renderEntryCard).join('');
  bindEntryButtons();
}

function renderEntryCard(entry) {
  const dateStr = formatDateTime(entry.date, entry.start_time, entry.end_time);
  const mapUrl = buildMapUrl(entry);
  const myResponse = entry.responses.find(r => r.voter_id === VOTER_ID);

  const byStatus = { '参加': [], '不参加': [], '未定': [] };
  for (const r of entry.responses) byStatus[r.status]?.push(r);

  let responseHtml;
  if (entry.type === 'site') {
    responseHtml = `
      <div class="counts">
        <span class="count count-attend">${STATUS_LABEL['参加']} <strong>${byStatus['参加'].length}</strong></span>
        <span class="count count-absent">${STATUS_LABEL['不参加']} <strong>${byStatus['不参加'].length}</strong></span>
        <span class="count count-undecided">${STATUS_LABEL['未定']} <strong>${byStatus['未定'].length}</strong></span>
      </div>
    `;
  } else {
    const sections = ['参加', '不参加', '未定']
      .filter(st => byStatus[st].length > 0)
      .map(st => `
        <div class="chip-row">
          <span class="chip-label chip-${STATUS_CLASS[st]}">${STATUS_LABEL[st]} (${byStatus[st].length})</span>
          ${byStatus[st].map(r => `<span class="chip">${escapeHtml(r.voter_name || '匿名')}</span>`).join('')}
        </div>
      `).join('');
    responseHtml = `<div class="chips-section">${sections || '<p class="no-response">まだ回答がありません</p>'}</div>`;
  }

  const mapButton = `<a class="map-link ${entry.map_url ? '' : 'map-link-auto'}" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer" title="${entry.map_url ? '指定URL' : '名前から自動検索'}">🗺 ${entry.map_url ? '地図' : '検索'}</a>`;

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
      ${responseHtml}
      <div class="my-vote">
        <span class="my-vote-label">あなたの回答：</span>
        <div class="vote-buttons">
          ${['参加', '不参加', '未定'].map(st => `
            <button class="vote-btn vote-${STATUS_CLASS[st]} ${myResponse?.status === st ? 'selected' : ''}" data-vote="${st}" data-iid="${entry.id}">${STATUS_LABEL[st]}</button>
          `).join('')}
          ${myResponse ? `<button class="vote-btn vote-clear" data-clear="${entry.id}" title="自分の回答を取り消す">取消</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function bindEntryButtons() {
  document.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', onVote));
  document.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', onClearVote));
  document.querySelectorAll('[data-edit]').forEach(b => {
    b.addEventListener('click', () => openEdit(parseInt(b.dataset.edit, 10)));
  });
}

async function onVote(e) {
  const btn = e.currentTarget;
  const iid = parseInt(btn.dataset.iid, 10);
  const status = btn.dataset.vote;

  let voter_name = '';
  if (currentTab === 'event') {
    voter_name = ($('#my-name').value || '').trim();
    if (!voter_name) {
      alert('上の「あなたの名前」を先に入力してください');
      $('#my-name').focus();
      return;
    }
    localStorage.setItem('cv_my_name', voter_name);
  }

  btn.disabled = true;
  try {
    const res = await fetch(`/api/entries/${iid}/response`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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

async function onClearVote(e) {
  const iid = parseInt(e.currentTarget.dataset.clear, 10);
  if (!confirm('あなたの回答を取り消しますか？')) return;
  try {
    const res = await fetch(`/api/entries/${iid}/response`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
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

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#new-title').value.trim();
  const date = $('#new-date').value;
  const start_time = $('#new-start').value;
  const end_time = $('#new-end').value;
  const details = $('#new-details').value.trim();
  const map_url = $('#new-map').value.trim();
  if (!title || !date || !start_time) return;

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: currentTab, title, date, start_time, end_time, details, map_url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    $('#new-title').value = '';
    $('#new-date').value = '';
    $('#new-start').value = currentTab === 'site' ? '09:00' : '19:00';
    $('#new-end').value = '';
    $('#new-details').value = '';
    $('#new-map').value = '';
    $('#new-title').focus();
    await loadEntries();
  } catch (err) {
    alert('追加に失敗しました：' + err.message);
  } finally {
    btn.disabled = false;
  }
});

function openEdit(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  editingId = id;
  $('#edit-title-input').value = entry.title;
  $('#edit-date').value = entry.date;
  $('#edit-start').value = entry.start_time;
  $('#edit-end').value = entry.end_time || '';
  $('#edit-details').value = entry.details || '';
  $('#edit-map').value = entry.map_url || '';
  $('#edit-dialog').showModal();
}

$('#edit-cancel').addEventListener('click', () => {
  editingId = null;
  $('#edit-dialog').close();
});

$('#edit-save').addEventListener('click', async () => {
  if (!editingId) return;
  const title = $('#edit-title-input').value.trim();
  const date = $('#edit-date').value;
  const start_time = $('#edit-start').value;
  const end_time = $('#edit-end').value;
  const details = $('#edit-details').value.trim();
  const map_url = $('#edit-map').value.trim();
  if (!title || !date || !start_time) {
    alert('タイトル・日付・開始時刻は必須です');
    return;
  }
  try {
    const res = await fetch(`/api/entries/${editingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: currentTab, title, date, start_time, end_time, details, map_url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    editingId = null;
    $('#edit-dialog').close();
    await loadEntries();
  } catch (err) {
    alert('保存に失敗しました：' + err.message);
  }
});

$('#edit-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('この行を削除します。よろしいですか？\n（紐づく回答もすべて削除されます）')) return;
  try {
    const res = await fetch(`/api/entries/${editingId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('failed');
    editingId = null;
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
