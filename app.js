/* 臨床教師認證 — 前端（GitHub Pages）
 * 只做「讀取」：所有資料由 Supabase 的資料列權限 (RLS) 決定看得到的範圍。
 * 本檔與 config.js 內沒有任何機密；anon 金鑰在未登入時讀不到任何資料。 */
const sb = supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.anonKey);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailOf = emp => `${emp.trim().toLowerCase()}@staff.invalid`;
const state = { me: null, role: 'general', view: null, list: null };

const ROLE_LABEL = { general: '一般人員', dept_coordinator: '科部主管', admin: '師培中心管理者', super_admin: '最高管理者' };
const STATE_LABEL = { met: '已達標', in_progress: '進行中', missed: '未達標', future: '尚未開始', exempt: '不檢核', window: '採計期間' };
const BASIC = ['課程設計', '教學技巧', '評估技巧', '教材製作'];
const ADVANCED = ['跨領域團隊合作照護教學', '全人照護教學', '溝通及輔導', '創新教學導入', '教師教學經驗分享'];

// ---------- 登入／開通 ----------
function showAuth(msg, ok) {
  $('appView').hidden = true; $('authView').hidden = false;
  $('authMsg').textContent = msg || ''; $('authMsg').className = 'msg' + (ok ? ' ok' : '');
}
function setTab(activate) {
  $('tabLogin').classList.toggle('is-active', !activate); $('tabActivate').classList.toggle('is-active', activate);
  $('loginForm').hidden = activate; $('activateForm').hidden = !activate; $('authMsg').textContent = '';
}
$('tabLogin').onclick = () => setTab(false);
$('tabActivate').onclick = () => setTab(true);

async function signIn(emp, password) {
  const { error } = await sb.auth.signInWithPassword({ email: emailOf(emp), password });
  if (error) return showAuth('工號或密碼不正確。第一次使用請先以開通碼開通。');
  await boot();
}
$('loginForm').onsubmit = e => { e.preventDefault(); signIn($('loginEmp').value, $('loginPw').value); };

$('activateForm').onsubmit = async e => {
  e.preventDefault();
  const emp = $('actEmp').value.trim(), pw = $('actPw').value;
  if (pw !== $('actPw2').value) return showAuth('兩次輸入的密碼不一致。');
  showAuth('處理中…', true);
  try {
    const res = await fetch(`${window.APP_CONFIG.url}/functions/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.anonKey, Authorization: `Bearer ${window.APP_CONFIG.anonKey}` },
      body: JSON.stringify({ emp_id: emp, code: $('actCode').value, password: pw })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return showAuth(data.message || '開通失敗，請稍後再試或洽師培中心。');
    $('activateForm').reset();
    await signIn(emp, pw);
  } catch (err) {
    showAuth('無法連線到開通服務，請稍後再試。');
  }
};
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); state.me = null; showAuth(); };

// ---------- 資料 ----------
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const LIST_COLS = 'emp_id,dept,track_type,status_code,status,can_apply,computed_at,' +
  'reason:detail->>statusReason,teach:detail->>teachingHours,basic:detail->>basicHours,adv:detail->>advancedHours,' +
  'need:detail->>requiredTotalHours,expiring:detail->>expiringSoon,valid_end:detail->activeCertificate->>valid_end_roc,' +
  'new_ok:detail->newRulePreview->>wouldQualify,new_reason:detail->newRulePreview->>statusReason,' +
  'staff(title,profession)';

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showAuth();
  state.list = null;   // 換帳號登入時不得沿用上一位的名單
  const { data: profile } = await sb.from('profiles').select('emp_id,role,scope_dept,disabled').eq('user_id', session.user.id).maybeSingle();
  if (!profile || profile.disabled) { await sb.auth.signOut(); return showAuth('此帳號無法使用，請洽師培中心。'); }
  const { data: staff } = await sb.from('staff').select('emp_id,dept,title,profession').eq('emp_id', profile.emp_id).maybeSingle();
  state.me = { ...profile, ...(staff || {}) };
  state.role = profile.role;
  $('authView').hidden = true; $('appView').hidden = false;
  $('whoText').textContent = `${state.me.emp_id}｜${ROLE_LABEL[state.role]}`;

  const views = [['mine', '我的認證']];
  if (state.role === 'dept_coordinator') views.unshift(['dept', '科部總覽']);
  if (state.role === 'admin' || state.role === 'super_admin') views.unshift(['all', '全院總覽'], ['dept', '名單查詢']);
  $('nav').innerHTML = views.map(([v, t]) => `<button type="button" data-view="${v}">${t}</button>`).join('');
  $('nav').querySelectorAll('button').forEach(b => { b.onclick = () => go(b.dataset.view); });
  go(views[0][0]);
}

function go(view, arg) {
  state.view = view;
  $('nav').querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('content').innerHTML = '<div class="card empty">載入中…</div>';
  const run = { mine: () => renderPerson(state.me.emp_id), person: () => renderPerson(arg, true), dept: renderList, all: renderOverview }[view];
  run().catch(err => { $('content').innerHTML = `<div class="card empty">載入失敗：${esc(err.message || err)}</div>`; });
  window.scrollTo(0, 0);
}

// ---------- 個人頁：結論 → 進度 → 依據 → 明細（分段呈現） ----------
function meter(label, value, need, unit = '點') {
  const v = Number(value) || 0, n = Number(need) || 0;
  if (!n) return '';
  const pct = Math.min(100, (v / n) * 100);
  return `<div class="meter ${v >= n ? 'done' : ''}"><div class="top"><span>${label}</span><span class="num">${v} / ${n} ${unit}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div><small>${v >= n ? '已達標' : `還差 ${Math.round((n - v) * 10) / 10} ${unit}`}</small></div>`;
}

async function renderPerson(empId, back) {
  const [{ data: row, error }, { data: staff }, { data: records }] = await Promise.all([
    sb.from('cert_status').select('*').eq('emp_id', empId).maybeSingle(),
    sb.from('staff').select('emp_id,dept,title,profession').eq('emp_id', empId).maybeSingle(),
    sb.from('course_records').select('course_title,course_date,category,teaching_hours,general_hours').eq('emp_id', empId).order('course_date', { ascending: false }).limit(300)
  ]);
  if (error) throw error;
  if (!row) { $('content').innerHTML = '<div class="card empty">尚無此人員的認證資料。</div>'; return; }
  const d = row.detail;
  $('asOf').textContent = new Date(row.computed_at).toLocaleString('zh-TW', { hour12: false });
  const cert = d.activeCertificate;
  const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';

  const hero = `
    <section class="card hero tone-${esc(d.statusCode)}">
      ${back ? '<button class="btn-link" type="button" onclick="go(\'dept\')">← 回名單</button><br>' : ''}
      <span class="tag ${d.regime === 'legacy' ? 'legacy' : ''}">目前適用：${esc(d.regimeLabel)}</span>
      <div class="status">${esc(d.status)}</div>
      <div class="rule">${esc(d.trackLabel)}</div>
      <div class="rule">工號 ${esc(empId)}｜${esc(staff?.dept || '')}｜${esc(staff?.title || '')}｜${esc(staff?.profession || '')}${cert ? `｜認證效期 ${esc(cert.valid_start_roc)}–${esc(cert.valid_end_roc)}` : ''}</div>
      <div class="reason">${esc(d.statusReason)}</div>
      ${(d.recommendations || []).length ? `<ul class="recs">${d.recommendations.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </section>`;

  const meters = `
    <section class="card"><h3>進度（${esc(d.window?.label || '')}）</h3><div class="meters">
      ${meter(certTrack ? '教學能力提升' : '年度總點數', certTrack ? d.teachingHours : d.totalHours, d.requiredTotalHours)}
      ${certTrack ? '' : meter('其中教學能力提升', d.teachingHours, d.requiredTeachingHours)}
      ${meter('基礎課程', d.basicHours, d.requiredBasicHours)}
      ${meter('進階課程', d.advancedHours, d.requiredAdvancedHours)}
      ${d.trackType === 'initial' ? meter('教學醫院年資', d.seniority, d.requiredSeniority, '年') : ''}
    </div>
    ${d.unclassifiedHours > 0 ? `<div class="note">有 ${d.unclassifiedHours} 點教學能力提升課程尚未歸類到九大項目${d.regime === 'legacy' ? '（舊制不分項目，仍計入總點數）' : '，暫不計入基礎／進階'}。</div>` : ''}
    </section>`;

  const years = (d.yearly || []).length ? `
    <section class="card"><h3>逐年點數</h3><div class="years">
      ${d.yearly.map(y => `<div class="year ${esc(y.state)}"><b>${y.roc} 年</b> <small>${STATE_LABEL[y.state] || ''}</small><br>
        教學 <b class="num">${y.teach}</b>　基礎 <b class="num">${y.basic}</b>　進階 <b class="num">${y.adv}</b></div>`).join('')}
    </div></section>` : '';

  const p = d.newRulePreview;
  const preview = !p ? '' : `
    <section class="card preview ${p.wouldQualify ? 'ok' : ''}">
      <h3>${p.appliesFrom} 年起改採新制時的試算</h3>
      <div class="rule">${esc(p.trackLabel)}</div>
      <div><b>${esc(p.status)}</b></div>
      ${p.wouldQualify ? '<div class="note">以目前的修課紀錄，新制下也符合，不需額外補修。</div>' : `<ul>
        ${(p.missingBasicItems || []).length ? `<li>基礎項目尚缺：<b>${esc(p.missingBasicItems.join('、'))}</b></li>` : ''}
        ${p.gapBasicHours > 0 ? `<li>基礎還差 <b>${p.gapBasicHours}</b> 點（${p.basicHours} / ${p.requiredBasicHours}）</li>` : ''}
        ${p.gapAdvancedHours > 0 ? `<li>進階還差 <b>${p.gapAdvancedHours}</b> 點（${p.advancedHours} / ${p.requiredAdvancedHours}）</li>` : ''}
      </ul>`}
    </section>`;

  const eq = d.itemsEquipped || {};
  const itemRow = list => list.map(i => `<div class="item ${eq[i]?.hours > 0 ? 'on' : ''}"><span>${i}</span><span class="h num">${eq[i]?.hours || 0}</span></div>`).join('');
  const items = !certTrack ? '' : `
    <section class="card"><h3>九大教學能力項目（採計期間內的點數）</h3>
      <div class="group-label">基礎課程</div><div class="items">${itemRow(BASIC)}</div>
      <div class="group-label">進階課程</div><div class="items">${itemRow(ADVANCED)}</div>
    </section>`;

  const recs = `
    <section class="card"><h3>修課紀錄（最近 ${records?.length || 0} 筆）</h3>
      ${(records || []).length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>課程</th><th>類別</th><th>教學</th><th>一般</th></tr></thead><tbody>
        ${records.map(r => `<tr><td>${esc(r.course_date)}</td><td style="white-space:normal;min-width:220px;">${esc(r.course_title)}</td><td>${esc(r.category)}</td><td class="num">${Number(r.teaching_hours) || ''}</td><td class="num">${Number(r.general_hours) || ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">沒有修課紀錄</div>'}
    </section>`;

  $('content').innerHTML = hero + meters + preview + years + items + recs;
}

// ---------- 名單（科部主管：所屬科部；管理者：可篩選） ----------
async function loadList() {
  if (!state.list) state.list = await fetchAll(() => sb.from('cert_status').select(LIST_COLS).order('emp_id'));
  if (state.list[0]) $('asOf').textContent = new Date(state.list[0].computed_at).toLocaleString('zh-TW', { hour12: false });
  return state.list;
}
const ORDER = { expiring: 0, remedy: 1, eligible: 2, expired: 3, deficient: 4, valid: 5 };

function distRows(list) {
  const by = {};
  list.forEach(r => {
    const k = r.staff?.profession || '其他';
    by[k] = by[k] || { total: 0, valid: 0, eligible: 0, other: 0 };
    by[k].total++; by[k][r.status_code === 'valid' ? 'valid' : r.status_code === 'eligible' ? 'eligible' : 'other']++;
  });
  return Object.entries(by).sort((a, b) => b[1].total - a[1].total).map(([name, v]) => `
    <div class="dist"><div><b>${esc(name)}</b> <small>${v.total} 人</small></div>
      <div class="bar"><i style="width:${v.valid / v.total * 100}%;background:var(--success)"></i><i style="width:${v.eligible / v.total * 100}%;background:var(--secondary)"></i><i style="width:${v.other / v.total * 100}%;background:var(--mist)"></i></div>
      <div class="num">有效 <b>${v.valid}</b>・可提報 <b>${v.eligible}</b>・其他 <b>${v.other}</b></div></div>`).join('');
}
const LEGEND = '<div class="legend"><span><i style="background:var(--success)"></i>有效／達標</span><span><i style="background:var(--secondary)"></i>可提報</span><span><i style="background:var(--mist)"></i>其他</span></div>';

async function renderList() {
  const list = await loadList();
  const admin = state.role === 'admin' || state.role === 'super_admin';
  const count = c => list.filter(r => r.status_code === c).length;
  const kpis = admin ? '' : `
    <section class="kpis">
      <div class="kpi"><b class="num">${list.length}</b><span>所屬人員</span></div>
      <div class="kpi" style="--tone:var(--success)"><b class="num">${count('valid')}</b><span>認證有效／年度達標</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${list.filter(r => r.can_apply).length}</b><span>可提報認證</span></div>
      <div class="kpi" style="--tone:var(--warning)"><b class="num">${count('expiring') + count('remedy')}</b><span>今年到期尚未符合</span></div>
    </section>
    <section class="card"><h3>各職類認證分佈</h3>${LEGEND}${distRows(list)}</section>`;
  $('content').innerHTML = kpis + `
    <section class="card"><h3>人員名單</h3>
      <div class="filters">
        <input id="fQ" type="search" placeholder="工號或單位">
        <select id="fS"><option value="">所有狀態</option><option value="can">可提報認證</option><option value="expiring">今年到期尚未符合</option><option value="valid">有效／達標</option><option value="deficient">尚未符合</option><option value="newgap">新制試算不符合</option></select>
        <span id="fN" class="hint" style="align-self:center;margin:0"></span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>工號</th><th>單位</th><th>職稱</th><th>職類</th><th>教學點數</th><th>狀態</th><th>說明</th><th>新制試算</th></tr></thead><tbody id="tb"></tbody></table></div>
    </section>`;
  const draw = () => {
    const q = $('fQ').value.trim().toLowerCase(), s = $('fS').value;
    let rows = list.filter(r => !q || r.emp_id.toLowerCase().includes(q) || (r.dept || '').toLowerCase().includes(q));
    if (s === 'can') rows = rows.filter(r => r.can_apply);
    else if (s === 'expiring') rows = rows.filter(r => ['expiring', 'remedy'].includes(r.status_code));
    else if (s === 'valid') rows = rows.filter(r => r.status_code === 'valid');
    else if (s === 'deficient') rows = rows.filter(r => ['deficient', 'expired'].includes(r.status_code));
    else if (s === 'newgap') rows = rows.filter(r => r.new_ok === 'false');
    rows = [...rows].sort((a, b) => (ORDER[a.status_code] ?? 9) - (ORDER[b.status_code] ?? 9));
    $('fN').textContent = `${rows.length} / ${list.length} 人${rows.length > 300 ? '（顯示前 300 筆，請用搜尋縮小範圍）' : ''}`;
    $('tb').innerHTML = rows.slice(0, 300).map(r => `<tr>
      <td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${esc(r.emp_id)}</button></td>
      <td>${esc(r.dept)}</td><td>${esc(r.staff?.title || '')}</td><td>${esc(r.staff?.profession || '')}</td>
      <td class="num">${esc(r.teach)} / ${esc(r.need)}</td>
      <td><span class="pill ${esc(r.status_code)}">${esc(r.status)}</span>${r.valid_end ? `<br><small>至 ${esc(r.valid_end)}</small>` : ''}</td>
      <td class="reason">${esc(r.reason)}</td>
      <td>${r.new_ok === 'true' ? '<span class="pill valid">符合</span>' : r.new_ok === 'false' ? `<span class="pill expiring" title="${esc(r.new_reason)}">尚未符合</span>` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">查無符合條件的人員</td></tr>';
  };
  $('fQ').oninput = draw; $('fS').onchange = draw; draw();
}

// ---------- 全院總覽（管理者） ----------
async function renderOverview() {
  const list = await loadList();
  const cert = list.filter(r => r.track_type === 'initial' || r.track_type === 'renewal');
  const expiring = list.filter(r => r.track_type === 'renewal' && r.expiring === 'true');
  const renewable = expiring.filter(r => r.can_apply);
  const initial = list.filter(r => r.track_type === 'initial' && r.can_apply);
  const legacy = list.some(r => r.new_ok !== null);
  $('content').innerHTML = `
    <section class="kpis">
      <div class="kpi"><b class="num">${list.length.toLocaleString()}</b><span>全院人員</span></div>
      <div class="kpi" style="--tone:var(--success)"><b class="num">${list.filter(r => r.track_type === 'renewal' && r.valid_end).length.toLocaleString()}</b><span>持有效臨床教師認證</span></div>
      <div class="kpi" style="--tone:var(--warning)"><b class="num">${expiring.length}</b><span>今年底到期</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${renewable.length}</b><span>其中已符合展延</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${initial.length}</b><span>符合初次認證</span></div>
    </section>
    ${legacy ? `<section class="card preview"><h3>若改採新制</h3>
      <div>今年到期者符合展延：<b class="num">${expiring.filter(r => r.new_ok === 'true').length}</b> 人（目前 ${renewable.length} 人）；
      符合初次認證：<b class="num">${list.filter(r => r.track_type === 'initial' && r.new_ok === 'true').length}</b> 人（目前 ${initial.length} 人）。</div>
      <div class="note">到「名單查詢」選「新制試算不符合」可列出需要提前補修的人員。</div></section>` : ''}
    <section class="card"><h3>醫事職類認證分佈</h3>${LEGEND}${distRows(cert)}</section>`;
}

sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') showAuth(); });
boot();
