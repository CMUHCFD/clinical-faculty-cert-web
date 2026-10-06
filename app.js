/* 臨床教師認證 — 前端（GitHub Pages）
 * 讀取：直接查 Supabase，由資料列權限 (RLS) 決定看得到的範圍。
 * 寫入：一律呼叫 Edge Function「api」，由伺服器端檢查身分與角色。
 * 本檔與 config.js 內沒有任何機密；anon 金鑰在未登入時讀不到任何資料。 */
const sb = supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.anonKey);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailOf = emp => `${emp.trim().toLowerCase()}@staff.invalid`;
const state = { me: null, role: 'general', view: null, list: null, regime: 'legacy', rules: null, qrTimer: null };

const ROLE_LABEL = { general: '一般人員', dept_coordinator: '科部主管', admin: '師培中心管理者', super_admin: '最高管理者' };
const STATE_LABEL = { met: '已達標', in_progress: '進行中', missed: '未達標', future: '尚未開始', exempt: '不檢核', window: '採計期間' };
const BASIC = ['課程設計', '教學技巧', '評估技巧', '教材製作'];
const ADVANCED = ['跨領域團隊合作照護教學', '全人照護教學', '溝通及輔導', '創新教學導入', '教師教學經驗分享'];
const isAdmin = () => state.role === 'admin' || state.role === 'super_admin';
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const fmtTime = t => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '');

// ---------- 通知列 ----------
function toast(text, ok = true) {
  let bar = $('toast');
  if (!bar) { bar = document.createElement('div'); bar.id = 'toast'; document.body.appendChild(bar); }
  bar.className = ok ? 'toast ok' : 'toast fail';
  bar.innerHTML = `<span>${esc(text)}</span><button type="button" onclick="this.parentElement.remove()">關閉</button>`;
  clearTimeout(toast.t); if (ok) toast.t = setTimeout(() => bar.remove(), 6000);
}

// ---------- 寫入：Edge Function ----------
async function api(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showAuth('登入已逾時，請重新登入。'); throw new Error('未登入'); }
  const res = await fetch(`${window.APP_CONFIG.url}/functions/v1/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.anonKey, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({ success: false, message: `伺服器回應異常 (HTTP ${res.status})` }));
  if (!data.success) throw new Error(data.message || '操作失敗');
  return data;
}
async function act(action, payload, after) {
  try { const d = await api(action, payload); toast(d.message); if (after) await after(d); return d; }
  catch (err) { toast(err.message, false); }
}

// ---------- 登入／開通 ----------
function showAuth(msg, ok) {
  clearInterval(state.qrTimer);
  $('appView').hidden = true; $('authView').hidden = false;
  $('authMsg').textContent = msg || ''; $('authMsg').className = 'msg' + (ok ? ' ok' : '');
}
// 登入頁兩條路：大按鈕「查詢我的認證進度」（免登入）／下方的登入、開通帳號
function setTab(which) {
  const lookup = which === 'lookup';
  if ($('authMain') && $('lookupPane')) { $('authMain').hidden = lookup; $('lookupPane').hidden = !lookup; }
  if (!lookup) {
    $('tabLogin').classList.toggle('is-active', which === 'login'); $('tabActivate').classList.toggle('is-active', which === 'activate');
    $('loginForm').hidden = which !== 'login'; $('activateForm').hidden = which !== 'activate';
  }
  $('authMsg').textContent = '';
  if (lookup && $('lkEmp')) setTimeout(() => $('lkEmp').focus(), 0);
}
$('tabLogin').onclick = () => setTab('login');
$('tabActivate').onclick = () => setTab('activate');
if ($('goLookup')) $('goLookup').onclick = () => setTab('lookup');
if ($('lkBackLogin')) $('lkBackLogin').onclick = () => setTab('login');

// ---------- 免登入進度查詢：員工編號＋身分證後 4 碼 → 唯讀的個人頁 ----------
if ($('lookupForm')) $('lookupForm').onsubmit = async e => {
  e.preventDefault();
  showAuth('查詢中…', true);
  try {
    const res = await fetch(`${window.APP_CONFIG.url}/functions/v1/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.anonKey, Authorization: `Bearer ${window.APP_CONFIG.anonKey}` },
      body: JSON.stringify({ emp_id: $('lkEmp').value.trim(), last4: $('lkLast4').value.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) return showAuth(data.message || '查詢失敗，請稍後再試。');
    showLookup(data);
  } catch (err) { showAuth('無法連線到查詢服務，請稍後再試。'); }
};
function showLookup(r) {
  $('lookupForm').reset(); $('authMsg').textContent = '';
  $('content').innerHTML = '';                        // 避免與先前登入者的頁面重複
  $('authView').hidden = true; $('appView').hidden = true; $('lookupView').hidden = false;
  $('lkWho').textContent = `${r.emp_id} ${r.name || ''}`;
  $('lkAsOf').textContent = fmtTime(r.row.computed_at);
  const how = r.regime === 'new'
    ? '新制的臨床教師認證由科部主管統一提報，符合資格者不需要自行申請。'
    : '符合資格者請登入系統，在「我的認證」按「申請臨床教師認證」。';
  // 結論放最前面，使用說明放最後
  $('lkContent').innerHTML = lookupHTML(r) +
    `<section class="card lk-note"><b>這是免登入的唯讀查詢。</b>${how}要報名課程或申請，請先登入；還沒有帳號者，請向科部主管或師培中心索取開通碼。
      <br><small>為保護個資，查詢畫面 10 分鐘後會自動關閉；使用公用電腦時，看完請按右上角「結束查詢」。</small></section>`;
  clearTimeout(state.lkTimer); state.lkTimer = setTimeout(endLookup, 10 * 60e3);
  window.scrollTo(0, 0);
}
// 免登入查詢的版面（CTML：結論 → 三個關鍵數字 → 下一步 → 依年度分段的明細）
//   字級放大、顏色只用來表示狀態；明細依年度收合，年度內再分「教學能力提升」與「一般／院內課程」
function lookupHTML(r) {
  const d = r.row[r.regime === 'new' ? 'detail_new' : 'detail'] || r.row.detail;
  const cert = d.activeCertificate;
  const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';
  const plain = s => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '');      // 去掉狀態前面的色點符號，改用色塊表示
  const n = v => Math.round((Number(v) || 0) * 10) / 10;

  // ---- 三個關鍵數字：效期、點數、還差多少
  let validity;
  if (cert) {
    const end = new Date(cert.valid_end), now = new Date(today());
    const months = (end.getFullYear() - now.getFullYear()) * 12 + end.getMonth() - now.getMonth();
    validity = `<div class="lk-big">${esc(cert.valid_start_roc)}<span class="lk-to">至</span>${esc(cert.valid_end_roc)}</div>
      <div class="lk-sub">${months < 0 ? '已屆滿' : months <= 6 ? `<b class="warn">剩 ${months} 個月到期</b>` : `還有 ${months} 個月`}</div>`;
  } else if (certTrack) {
    validity = `<div class="lk-big muted">尚未取得</div><div class="lk-sub">${d.lastCertificate ? `上一張效期至 ${esc(d.lastCertificate.valid_end_roc || d.lastCertificate.valid_end)}` : '目前沒有有效的臨床教師認證'}</div>`;
  } else {
    validity = `<div class="lk-big muted">不適用</div><div class="lk-sub">${esc(d.trackLabel || '適用每年師培時數規範')}</div>`;
  }
  const have = certTrack ? d.teachingHours : d.totalHours, need = d.requiredTotalHours;
  const pct = need ? Math.min(100, (Number(have) || 0) / need * 100) : 100;
  const pointsTile = `<div class="lk-big">${n(have)}<span class="lk-of"> / ${n(need)} 點</span></div>
    <div class="lk-bar"><i style="width:${pct}%" class="${pct >= 100 ? 'ok' : ''}"></i></div>
    <div class="lk-sub">${certTrack ? '教學能力提升' : '年度總點數'}・${esc(d.window?.label || '')}</div>`;

  const gaps = [];
  if ((d.missingBasicItems || []).length) gaps.push(`基礎項目還缺：${d.missingBasicItems.join('、')}`);
  if (d.gapBasicHours > 0) gaps.push(`基礎課程還差 ${n(d.gapBasicHours)} 點`);
  if (d.gapAdvancedHours > 0) gaps.push(`進階課程還差 ${n(d.gapAdvancedHours)} 點`);
  if (!gaps.length && d.gapTotal > 0) gaps.push(`${certTrack ? '教學能力提升' : '總點數'}還差 ${n(d.gapTotal)} 點`);
  if (!certTrack && d.gapTeaching > 0 && d.gapTotal > d.gapTeaching) gaps.push(`其中教學能力提升至少 ${n(d.gapTeaching)} 點`);
  if (certTrack && d.trackType === 'initial' && d.seniorityMet === false) gaps.push(`年資未達 ${d.requiredSeniority} 年（目前 ${d.seniority} 年）`);
  const eligible = certTrack && (d.initialEligible || d.renewalCompliant);
  const pending = (r.apps || []).some(a => a.status === '審核中');
  const gapTile = eligible || pending || !gaps.length
    ? `<div class="lk-big ok">${pending ? '審核中' : eligible ? '可以認證' : '已達標'}</div><div class="lk-sub">${pending ? '師培中心審查中' : eligible ? '已符合資格' : '目前不需要補修'}</div>`
    : `<div class="lk-big warn">${d.gapTotal > 0 ? `${n(d.gapTotal)} 點` : `${gaps.length} 項`}</div><div class="lk-sub">${esc(gaps[0])}</div>`;

  const hero = `<section class="card lk-hero tone-${esc(d.statusCode)}">
      <div class="lk-who">${esc(r.name || '')}<small>${esc(r.emp_id)}｜${esc(r.staff?.dept || '')}｜${esc(r.staff?.profession || '')}</small></div>
      <div class="lk-status">${esc(plain(d.status))}</div>
      <div class="lk-reason">${esc(d.statusReason || '')}</div>
      <span class="tag ${d.regime === 'legacy' ? 'legacy' : ''}">適用：${esc(d.regimeLabel || '')}</span>
    </section>
    <section class="lk-tiles">
      <div class="card lk-tile"><h3>認證效期</h3>${validity}</div>
      <div class="card lk-tile"><h3>目前點數</h3>${pointsTile}</div>
      <div class="card lk-tile"><h3>${eligible || pending || !gaps.length ? '結果' : '還差'}</h3>${gapTile}</div>
    </section>`;

  // ---- 下一步
  let nextBody;
  if (pending) nextBody = '<p>您的認證申請正在審核中，暫時不需要其他動作。</p>';
  else if (eligible) nextBody = `<p><b>您已符合資格。</b>${r.regime === 'new'
    ? '新制的認證由科部主管統一提報，您不需要自行申請；主管送出後，師培中心會協助您完成認證。'
    : '請登入本系統，在「我的認證」按「申請臨床教師認證」，由師培中心審查。'}</p>`;
  else if (!gaps.length) nextBody = `<p>目前不需要補修。${cert ? `請留意效期 ${esc(cert.valid_end_roc)}。` : ''}</p>`;
  else nextBody = `<ul class="lk-gaps">${gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
    <p class="lk-sub">${cert ? `請在 ${esc(cert.valid_end_roc)} 前完成。` : certTrack ? '' : '請在今年 12 月 31 日前完成。'}可報名的課程請登入後到「課程」頁查看。</p>`;
  const next = `<section class="card next lk-next"><h3>下一步</h3>${nextBody}</section>`;

  // ---- 新制試算（目前仍為舊制時）
  const p = r.regime === 'legacy' ? d.newRulePreview : null;
  const preview = !p ? '' : `<section class="card preview ${p.wouldQualify ? 'ok' : ''}"><h3>${p.appliesFrom} 年起改採新制時</h3>
    ${p.wouldQualify ? '<p>以目前的修課紀錄，新制下也符合，不需額外補修。</p>' : `<ul class="lk-gaps">
      ${(p.missingBasicItems || []).length ? `<li>基礎項目還缺：${esc(p.missingBasicItems.join('、'))}</li>` : ''}
      ${p.gapBasicHours > 0 ? `<li>基礎還差 ${n(p.gapBasicHours)} 點</li>` : ''}${p.gapAdvancedHours > 0 ? `<li>進階還差 ${n(p.gapAdvancedHours)} 點</li>` : ''}</ul>`}</section>`;

  // ---- 各年度的課程明細：年度收合 → 教學能力提升／一般課程
  const inWin = inWindowFn({ track_type: d.trackType, rg: d.regime, ve: cert && cert.valid_end, le: d.lastCertificate && d.lastCertificate.valid_end,
    grace: d.renewal && d.renewal.inGrace, wy: d.window && d.window.years });
  const tagOf = cat => /基礎/.test(cat) || BASIC.some(b => cat.includes(b)) ? '基礎' : /進階/.test(cat) || ADVANCED.some(a => cat.includes(a)) ? '進階' : '';
  const byYear = new Map();
  (r.records || []).forEach(x => { const y = x.course_date.slice(0, 4); byYear.set(y, [...(byYear.get(y) || []), x]); });
  const line = (x, teach) => {
    const hit = teach && certTrack ? inWin(x.course_date) : false, tag = teach ? tagOf(x.category || '') : '';
    return `<li class="${hit ? 'hit' : ''}"><span class="lk-date">${Number(x.course_date.slice(5, 7))}/${Number(x.course_date.slice(8, 10))}</span>
      <span class="lk-title">${esc(x.course_title)}${tag ? ` <span class="pill ${tag === '基礎' ? 'eligible' : 'valid'}">${tag}</span>` : ''}${!teach && x.category ? ` <small>${esc(x.category)}</small>` : ''}${hit ? ' <span class="done">計入</span>' : ''}</span>
      <span class="lk-h">${n(teach ? x.teaching_hours : x.general_hours)}</span></li>`;
  };
  const years = [...byYear.keys()].sort().reverse();
  const yearBlocks = years.map((y, i) => {
    const list = byYear.get(y);
    const teach = list.filter(x => Number(x.teaching_hours) > 0), gen = list.filter(x => !(Number(x.teaching_hours) > 0));
    const sumT = n(teach.reduce((a, x) => a + Number(x.teaching_hours), 0)), sumG = n(gen.reduce((a, x) => a + Number(x.general_hours), 0));
    const counted = certTrack && teach.some(x => inWin(x.course_date));
    return `<details class="lk-year" ${i === 0 ? 'open' : ''}>
      <summary><span class="lk-yr">${Number(y) - 1911} 年</span>
        <span class="lk-chips"><span class="lk-chip t">教學能力提升 <b>${sumT}</b> 點</span><span class="lk-chip">一般 <b>${sumG}</b> 點</span><span class="lk-chip">${list.length} 門課</span>${counted ? '<span class="lk-chip in">計入本次採計</span>' : ''}</span></summary>
      ${teach.length ? `<div class="lk-group">教學能力提升（${teach.length} 門，${sumT} 點）</div><ul class="lk-list">${teach.map(x => line(x, true)).join('')}</ul>` : ''}
      ${gen.length ? `<div class="lk-group g">一般醫學／院內課程（${gen.length} 門，${sumG} 點）</div><ul class="lk-list">${gen.map(x => line(x, false)).join('')}</ul>` : ''}
    </details>`;
  }).join('');
  const detail = `<section class="card"><h3>各年度修課明細</h3>
    <p class="lk-sub">點年度可展開或收合。綠底「計入」是算進本次認證點數的課程。線上課程每年最多採認 1 點，所以合計可能略高於系統採計的點數。</p>
    ${yearBlocks || '<div class="empty">沒有修課紀錄</div>'}</section>`;

  const apps = !(r.apps || []).length ? '' : `<section class="card"><h3>認證申請紀錄</h3><ul class="lk-list">
    ${r.apps.map(a => `<li><span class="lk-date">${esc(fmtTime(a.submitted_at).split(' ')[0])}</span><span class="lk-title">${esc(a.app_type)}${a.valid_start ? `<small>核定效期 ${esc(a.valid_start)}～${esc(a.valid_end)}</small>` : ''}</span>
      <span class="pill ${a.status === '已通過' ? 'valid' : a.status === '審核中' ? 'expiring' : 'expired'}">${esc(a.status)}</span></li>`).join('')}</ul></section>`;

  return `<div class="lk">${hero}${reqCard(d, { big: true })}${appraisalCard(d, { big: true })}${next}${detail}${preview}${apps}</div>`;
}
function endLookup() {
  clearTimeout(state.lkTimer);
  $('lkContent').innerHTML = ''; $('lkWho').textContent = '';
  $('lookupView').hidden = true; $('authView').hidden = false; setTab('lookup');
}
if ($('lkEnd')) $('lkEnd').onclick = endLookup;

async function signIn(emp, password) {
  const { error } = await sb.auth.signInWithPassword({ email: emailOf(emp), password });
  if (error) return showAuth('員工編號或密碼不正確。第一次使用請先以開通碼開通。');
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
  } catch (err) { showAuth('無法連線到開通服務，請稍後再試。'); }
};
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); state.me = null; state.roster = null; $('content').innerHTML = ''; showAuth(); };
if ($('pwBtn')) $('pwBtn').onclick = () => {   // 頁面快取尚未更新時可能還沒有這顆按鈕
  let dlg = $('pwDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'pwDlg'; dlg.className = 'small-dlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form id="pwForm" class="dlg-body"><h3>變更密碼</h3>
    <label>新密碼（至少 8 個字元）<input id="pw1" type="password" minlength="8" autocomplete="new-password" required></label>
    <label>再輸入一次<input id="pw2" type="password" minlength="8" autocomplete="new-password" required></label>
    <p id="pwMsg" class="msg"></p>
    <div style="display:flex;gap:8px"><button class="btn btn-primary" style="width:auto" type="submit">儲存</button><button class="btn btn-ghost" type="button" onclick="$('pwDlg').close()">取消</button></div></form>`;
  dlg.showModal();
  $('pwForm').onsubmit = async e => {
    e.preventDefault();
    if ($('pw1').value !== $('pw2').value) { $('pwMsg').textContent = '兩次輸入的密碼不一致。'; return; }
    const { error } = await sb.auth.updateUser({ password: $('pw1').value });
    if (error) { $('pwMsg').textContent = '變更失敗：' + error.message; return; }
    dlg.close(); toast('密碼已變更');
  };
};

// ---------- 共用資料 ----------
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
function regimeOf(rules) {
  const cfg = (rules && rules.regime) || {};
  const forced = Number(today().slice(0, 4)) >= (cfg.new_from_year || 2027);
  return { active: forced || cfg.transition_mode === 'new' ? 'new' : 'legacy', forced, newFromYear: cfg.new_from_year || 2027 };
}
const D = () => (state.regime === 'new' ? 'detail_new' : 'detail');   // 依目前適用制度讀對應的計算結果
const colsFor = d => `emp_id,dept,computed_at,status_code:${d}->>statusCode,status:${d}->>status,track_type:${d}->>trackType,` +
  `ie:${d}->>initialEligible,rc:${d}->>renewalCompliant,reason:${d}->>statusReason,teach:${d}->>teachingHours,` +
  `need:${d}->>requiredTotalHours,expiring:${d}->>expiringSoon,valid_end:${d}->activeCertificate->>valid_end_roc,on_plan,` +
  `ve:${d}->activeCertificate->>valid_end,basic:${d}->>basicHours,adv:${d}->>advancedHours,gap_t:${d}->>gapTotal,` +
  `gap_b:${d}->>gapBasicHours,gap_a:${d}->>gapAdvancedHours,cp:${d}->>compliant,grace:${d}->renewal->>inGrace,` +
  `rg:${d}->>regime,wy:${d}->window->years,wl:${d}->window->>label,le:${d}->lastCertificate->>valid_end,` +
  `new_ok:detail->newRulePreview->>wouldQualify,new_reason:detail->newRulePreview->>statusReason,cat:${d}->>categoryName,` +
  `tot:${d}->>totalHours,score:${d}->appraisal->>score,sbase:${d}->appraisal->>base,staff(title,profession)`;
// 名單上的「點數」：醫師等每年規範看總點數（一般醫學＋教學能力提升），認證教師看教學能力提升
const hoursOf = r => (r.track_type === 'physician' || r.track_type === 'annual' ? r.tot : r.teach);
const scorePill = r => r.score == null ? '' : ` <span class="pill ${Number(r.sbase) >= 10 ? 'valid' : Number(r.sbase) >= 5 ? 'eligible' : Number(r.sbase) >= 0 ? 'expiring' : 'expired'}" title="主治醫師年度考核分數">考核 ${esc(r.score)} 分</span>`;
const listCols = () => colsFor(D());
// ---------- 修課時數下鑽：點時數 → 看是哪些課（日期、課程名稱、時數），並標出哪些計入本次採計 ----------
// info = { track_type, rg(制度), ve(有效認證迄日), le(已屆滿的上一張迄日), grace, wy(採計年度), wl(採計期間說明) }
function inWindowFn(info, ref) {
  const idx = d => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  const now = idx(ref || today());
  if (info.rg === 'legacy' && info.track_type === 'renewal') {
    const end = idx(info.ve || info.le || (ref || today()));
    const to = info.grace === 'true' || info.grace === true ? now : end;      // 保留期內：屆滿後補修的也算
    return d => idx(d) >= end - 23 && idx(d) <= to;
  }
  if (info.rg === 'legacy' && info.track_type === 'initial') return d => idx(d) >= now - 23 && idx(d) <= now;
  const years = (info.wy || []).map(Number);
  return d => years.includes(Number(d.slice(0, 4)));
}
function recordsTable(records, info, ref) {
  const inWin = inWindowFn(info, ref);
  const cert = info.track_type === 'initial' || info.track_type === 'renewal';
  const rows = (records || []).filter(r => (ref ? r.course_date <= ref : true));
  const counted = rows.filter(r => inWin(r.course_date) && (Number(r.teaching_hours) > 0 || (!cert && Number(r.general_hours) > 0)));
  const sumT = Math.round(counted.reduce((a, r) => a + Number(r.teaching_hours), 0) * 10) / 10;
  const sumG = Math.round(counted.reduce((a, r) => a + Number(r.general_hours), 0) * 10) / 10;
  const line = r => { const hit = counted.includes(r); return `<tr class="${hit ? 'row-hit' : 'row-off'}">
    <td>${esc(r.course_date)}</td><td style="white-space:normal;min-width:200px;">${esc(r.course_title)}</td><td>${esc(r.category)}</td>
    <td class="num">${Number(r.teaching_hours) || ''}</td><td class="num">${Number(r.general_hours) || ''}</td><td>${hit ? '<span class="done">計入</span>' : ''}</td></tr>`; };
  return `
    <div class="rec-sum">採計期間：<b>${esc(info.wl || '')}</b>　｜　期間內 <b>${counted.length}</b> 門課，教學能力提升 <b class="num">${sumT}</b> 點${cert ? '' : `、一般醫學 <b class="num">${sumG}</b> 點`}</div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>課程名稱</th><th>類別</th><th>教學點數</th><th>一般點數</th><th>本次採計</th></tr></thead><tbody>
      ${counted.map(line).join('')}${rows.filter(r => !counted.includes(r)).map(line).join('')}</tbody></table></div>` : '<div class="empty">沒有修課紀錄</div>'}
    <div class="note">綠底為計入本次採計的課程，排在最前面；灰字為期間外或不屬於教學能力提升的課程。線上課程每年至多採認 1 點，所以這裡的合計可能略高於系統採計的點數。</div>`;
}
async function showRecords(empId) {
  const lists = [state.viewList, state.list, ...Object.values(state.alts || {})].filter(Boolean);
  const info = lists.map(l => l.find(r => r.emp_id === empId)).find(Boolean);
  if (!info) return;
  let dlg = $('recDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'recDlg'; document.body.appendChild(dlg); dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); }
  dlg.innerHTML = '<div class="dlg-body"><div class="empty">載入中…</div></div>';
  dlg.showModal();
  const { data, error } = await sb.from('course_records').select('course_title,course_date,category,teaching_hours,general_hours').eq('emp_id', empId).order('course_date', { ascending: false }).limit(500);
  dlg.innerHTML = `<div class="dlg-body">
    <div class="dlg-head"><h3>修課紀錄｜員工編號 ${empLabel(empId)}　<small>${esc(info.dept || '')}・${esc(profGroup(info))}</small></h3><button class="btn btn-ghost" type="button" onclick="$('recDlg').close()">關閉</button></div>
    <div class="rule">${esc(info.status || '')}　系統採計教學點數 <b class="num">${esc(info.teach)}</b> / ${esc(info.need)}</div>
    ${error ? `<div class="empty">載入失敗：${esc(error.message)}</div>` : recordsTable(data, info, state.viewRef)}
    <div style="margin-top:10px"><button class="btn btn-ghost" type="button" onclick="$('recDlg').close();go('person','${esc(empId)}')">開啟這位同仁的完整頁面</button></div></div>`;
}

const pecEx = emp => (state.pecEx || {})[emp];
const pecTag = emp => pecEx(emp) ? ` <span class="pill expired" title="${esc(pecEx(emp).reason)}">醫策會不受理</span>` : '';
async function togglePec(emp, remove) {
  const reason = remove ? '' : ($('pecReason') ? $('pecReason').value : '執業登記不在本院');
  const d = await act('admin.pecFlag', { emp_id: emp, reason, remove });
  if (!d) return;
  const { data } = await sb.from('settings').select('value').eq('key', 'pec_exclusions').maybeSingle();
  state.pecEx = (data && data.value) || {};
  renderPerson(emp, state.view === 'person');
}
const nameOf = emp => (state.roster && state.roster.get(String(emp).toLowerCase()) || {}).name || '';
const empLabel = emp => `${esc(emp)}${nameOf(emp) ? ` <span class="nm">${esc(nameOf(emp))}</span>` : ''}`;
const nameBtn = () => (isAdmin() || state.role === 'dept_coordinator')
  ? `<button class="btn btn-ghost" type="button" onclick="showNames()" title="姓名不存放在雲端；選擇您電腦上的員工名冊後，只在這個瀏覽器分頁內對照顯示">${state.roster ? '已顯示姓名' : '顯示姓名'}</button>` : '';
async function showNames() {
  if (state.roster) return;
  try { await pickRoster(); go(state.view, state.arg); } catch (err) { toast(err.message, false); }
}

// 職類分組：醫師依 ED-026 第四條身分（住院醫師年級、研究醫師、主治醫師）；護理依所屬單位再分為「護理部」與「非護理部」
const profGroup = r => {
  const p = r.staff?.profession || '其他';
  if (p === '醫師' || ['西醫師', '中醫師', '牙醫師'].includes(p)) return r.cat ? `醫師｜${r.cat}` : '醫師';
  return p === '護理' ? ((r.dept || '').startsWith('護理部') ? '護理（護理部）' : '護理（非護理部）') : p;
};
const PEC_NAME = { '藥師': '藥事', '檢驗': '醫事檢驗', '放射師(放射診斷、放射腫瘤、核子醫學)': '醫事放射' };
function download(name, rows) {
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
}
async function loadList(force) {
  if (force || !state.list) {
    const rows = await fetchAll(() => sb.from('cert_status').select(listCols()).order('emp_id'));
    rows.forEach(r => { r.can_apply = r.ie === 'true' || r.rc === 'true'; if (state.regime === 'new') r.new_ok = null; });
    state.list = rows;
  }
  if (state.list[0]) $('asOf').textContent = fmtTime(state.list[0].computed_at);
  return state.list;
}

// 另一份計算結果的名單（新制試算 detail_new、批次基準日 detail->batch）；只供「到期與提報」使用
async function loadAltList(col) {
  const base = await loadList();
  if (state.altFor !== base) { state.alts = {}; state.altFor = base; }
  if (!state.alts[col]) {
    const rows = await fetchAll(() => sb.from('cert_status').select(colsFor(col)).not(col, 'is', null).order('emp_id'));
    rows.forEach(r => { r.can_apply = r.ie === 'true' || r.rc === 'true'; r.new_ok = null; });
    state.alts[col] = rows;
  }
  return state.alts[col];
}
const loadNewRegimeList = () => loadAltList('detail_new');

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { if (location.hash === '#lookup') setTab('lookup'); return showAuth(); }
  state.list = null;   // 換帳號登入時不得沿用上一位的名單
  const { data: profile } = await sb.from('profiles').select('emp_id,role,scope_dept,disabled').eq('user_id', session.user.id).maybeSingle();
  if (!profile || profile.disabled) { await sb.auth.signOut(); return showAuth('此帳號無法使用，請洽師培中心。'); }
  const [{ data: staff }, { data: setting }] = await Promise.all([
    sb.from('staff').select('emp_id,dept,title,profession').eq('emp_id', profile.emp_id).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'rules').maybeSingle()
  ]);
  const { data: exRow } = await sb.from('settings').select('value').eq('key', 'pec_exclusions').maybeSingle();
  state.pecEx = (exRow && exRow.value) || {};
  state.me = { ...profile, ...(staff || {}) };
  state.role = profile.role;
  state.rules = setting ? setting.value : {};
  state.regime = regimeOf(state.rules).active;
  $('authView').hidden = true; $('appView').hidden = false;
  $('whoText').textContent = `${state.me.emp_id}｜${ROLE_LABEL[state.role]}`;

  const views = [];
  if (isAdmin()) views.push(['all', '全院總覽'], ['expiry', '到期與提報'], ['dept', '名單查詢']);
  if (state.role === 'dept_coordinator') views.push(['dept', '科部總覽'], ['expiry', '到期與提報']);
  views.push(['mine', '我的認證'], ['courses', '課程'], ['rules', '認證規範']);
  if (isAdmin()) views.push(['review', '審查']);
  if (isAdmin() || state.role === 'dept_coordinator') views.push(['roster', '追蹤名單']);
  if (state.role === 'super_admin') views.push(['admin', '管理']);
  $('nav').innerHTML = views.map(([v, t]) => `<button type="button" data-view="${v}">${t}</button>`).join('');
  $('nav').querySelectorAll('button').forEach(b => { b.onclick = () => go(b.dataset.view); });

  // 掃描簽到 QR 進來的連結：登入後直接完成簽到
  const params = new URLSearchParams(location.search);
  if (params.get('checkin') && params.get('t')) {
    history.replaceState(null, '', location.pathname);
    const d = await act('course.checkin', { course_id: params.get('checkin'), token: params.get('t') });
    if (d) toast(`${d.message}｜${d.course.title}（${d.course.hours} 點）`);
    return go('mine');
  }
  go(views[0][0]);
}

function go(view, arg) {
  clearInterval(state.qrTimer);
  if (view === 'person' && state.view !== 'person') state.backTo = state.view;
  state.view = view;
  $('nav').querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('content').innerHTML = '<div class="card empty">載入中…</div>';
  const run = { mine: () => renderPerson(state.me.emp_id), person: () => renderPerson(arg, true), dept: renderList, all: renderOverview,
    courses: renderCourses, rules: renderRules, review: renderReview, roster: renderRoster, admin: renderAdmin, expiry: renderExpiry }[view];
  // 連續快速切換頁面時，較早的頁面可能較晚才載完而蓋掉畫面：發現過期就重畫目前頁面
  const token = state.nav = (state.nav || 0) + 1;
  state.arg = arg;
  run().catch(err => { $('content').innerHTML = `<div class="card empty">載入失敗：${esc(err.message || err)}</div>`; })
    .then(() => { if (token !== state.nav && !state.redraw) { state.redraw = true; go(state.view, state.arg); state.redraw = false; } });
  window.scrollTo(0, 0);
}

// ---------- 個人頁：結論 → 進度 → 試算 → 依據 → 明細 ----------
function meter(label, value, need, unit = '點') {
  const v = Number(value) || 0, n = Number(need) || 0;
  if (!n) return '';
  return `<div class="meter ${v >= n ? 'done' : ''}"><div class="top"><span>${label}</span><span class="num">${v} / ${n} ${unit}</span></div>
    <div class="bar"><i style="width:${Math.min(100, (v / n) * 100)}%"></i></div><small>${v >= n ? '已達標' : `還差 ${Math.round((n - v) * 10) / 10} ${unit}`}</small></div>`;
}

// 「身分與應完成項目」：依計算結果的 identity／requirements 呈現，醫師、醫事人員、其他人員共用同一張卡片
//   舊版計算結果（尚未重算前）沒有 requirements 時，退回原本的進度條
function reqCard(d, o = {}) {
  const id = d.identity || {};
  const reqs = d.requirements;
  const link = o.link ? `　<button class="btn-link" type="button" onclick="$('recSection').scrollIntoView({behavior:'smooth'})">看是哪些課 ↓</button>` : '';
  const head = id.name ? `<div class="id-line"><span class="id-group">${esc(id.group)}</span><b>${esc(id.name)}</b><span class="id-stage">${esc(id.stage || '')}</span></div>
    <div class="rule">${esc(d.trackLabel || '')}<br><small>依據：${esc(id.rule || d.ruleName || '')}</small></div>` : '';
  let body;
  if (Array.isArray(reqs)) {
    body = !reqs.length ? `<p class="hint">${esc(d.statusReason || '此身分沒有應完成的師培時數。')}</p>`
      : `<ul class="req-list">${reqs.map(q => {
          const pct = q.need ? Math.min(100, q.have / q.need * 100) : 100;
          return `<li class="${q.met ? 'met' : ''}"><div class="req-top"><span class="req-mark">${q.met ? '✓' : '○'}</span><span class="req-label">${esc(q.label)}</span>
            <span class="req-num num">${q.have} / ${q.need} ${esc(q.unit)}</span></div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <small>${q.met ? '已完成' : `還差 ${Math.round((q.need - q.have) * 10) / 10} ${esc(q.unit)}`}</small></li>`;
        }).join('')}</ul>`;
  } else {
    const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';
    body = `<div class="meters">${meter(certTrack ? '教學能力提升' : '年度總點數', certTrack ? d.teachingHours : d.totalHours, d.requiredTotalHours)}
      ${certTrack ? '' : meter('其中教學能力提升', d.teachingHours, d.requiredTeachingHours)}
      ${meter('基礎課程', d.basicHours, d.requiredBasicHours)}${meter('進階課程', d.advancedHours, d.requiredAdvancedHours)}
      ${d.trackType === 'initial' ? meter('教學醫院年資', d.seniority, d.requiredSeniority, '年') : ''}</div>`;
  }
  return `<section class="card req-card ${o.big ? 'big' : ''}"><h3>${o.who || '您'}的身分與應完成項目${link}</h3>${head}${body}
    ${d.unclassifiedHours > 0 && (d.trackType === 'initial' || d.trackType === 'renewal') ? `<div class="note">有 ${d.unclassifiedHours} 點教學能力提升課程尚未歸類到九大項目${d.regime === 'legacy' ? '（舊制不分項目，仍計入總點數）' : '，暫不計入基礎／進階'}。</div>` : ''}
    ${o.rulesLink ? '<div class="note">各身分的完整規定請見上方選單「認證規範」。</div>' : ''}</section>`;
}

// 主治醫師年度考核分數：上課時數 → 基本分（級距中標出目前所在級）＋核心教師認證課程加分
function appraisalCard(d, o = {}) {
  const a = d.appraisal;
  if (!a) return '';
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const sign = v => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');
  const tone = a.base >= 10 ? 'ok' : a.base >= 5 ? 'mid' : a.base >= 0 ? 'low' : 'neg';
  let nextTip = '基本分已達最高級。';
  if (a.next) {
    const { needHours: h, needTeaching: t, score } = a.next;
    const what = h > 0 && t > 0 ? `${h} 小時師培課程（其中教學能力提升 ${t} 小時）` : h > 0 ? `${h} 小時師培課程` : `教學能力提升 ${t} 小時`;
    nextTip = `再完成 ${what}，基本分可達 ${score} 分。`;
  }
  return `<section class="card appr ${o.big ? 'big' : ''}">
    <h3>${a.roc} 年度主治醫師考核分數</h3>
    <div class="appr-top">
      <div class="appr-score tone-${tone}"><b class="num">${n(a.score)}</b><span>分</span><small>滿分 ${a.maxScore}</small></div>
      <div class="appr-calc">
        <div><span>上課時數</span><b class="num">${n(a.hours)} 小時</b><small>其中教學能力提升 ${n(a.teaching)} 小時</small></div>
        <div><span>基本分</span><b class="num">${sign(a.base)} 分</b><small>${esc(a.baseLabel)}</small></div>
        <div><span>核心教師認證加分</span><b class="num">${sign(a.bonus)} 分</b><small>${n(a.coreHours)} 小時，1 小時 1 分，上限 ${a.bonusCap} 分</small></div>
      </div>
    </div>
    <p class="appr-next">${esc(nextTip)}</p>
    <div class="tiers">${a.tiers.map(t => `<span class="tier ${t.score === a.base ? 'on' : ''}"><b>${sign(t.score)}</b> ${esc(t.label)}</span>`).join('')}</div>
    ${(a.coreCourses || []).length ? `<div class="group-label">列入加分的核心教師認證課程</div><ul class="lk-list">
      ${a.coreCourses.map(c => `<li><span class="lk-date">${Number(c.date.slice(5, 7))}/${Number(c.date.slice(8, 10))}</span><span class="lk-title">${esc(c.title)}<small>${esc(c.item)}</small></span><span class="lk-h">${n(c.hours)}</span></li>`).join('')}</ul>`
      : '<p class="hint">今年度尚無核心教師認證課程（如 SDM 醫病共享決策、EPA 可信賴專業活動、ACGME 臨床教練）。</p>'}
  </section>`;
}

async function renderPerson(empId, back) {
  const own = empId === state.me.emp_id;
  const [{ data: row, error }, { data: staff }, { data: records }, { data: apps }, { data: upcoming }, { data: myRegs }] = await Promise.all([
    sb.from('cert_status').select('*').eq('emp_id', empId).maybeSingle(),
    sb.from('staff').select('emp_id,dept,title,profession').eq('emp_id', empId).maybeSingle(),
    sb.from('course_records').select('course_title,course_date,category,teaching_hours,general_hours').eq('emp_id', empId).order('course_date', { ascending: false }).limit(500),
    sb.from('applications').select('*').eq('emp_id', empId).order('submitted_at', { ascending: false }).limit(10),
    sb.from('courses').select('id,title,course_date,start_time,hours,main_category,sub_categories,location_detail').gte('course_date', today()).order('course_date').limit(20),
    own ? sb.from('registrations').select('course_id').eq('emp_id', empId) : Promise.resolve({ data: [] })
  ]);
  if (error) throw error;
  if (!row) { $('content').innerHTML = '<div class="card empty">尚無此人員的認證資料。</div>'; return; }
  $('asOf').textContent = fmtTime(row.computed_at);
  $('content').innerHTML = personHTML({ empId, back, own, row, staff, records, apps, upcoming, myRegs,
    regime: state.regime, role: state.role, admin: isAdmin(), canAct: own || isAdmin() || state.role === 'dept_coordinator' });
  if ($('applyForm')) $('applyForm').onsubmit = e => {
    e.preventDefault();
    act('cert.apply', { emp_id: empId, service_years: $('apYears').value, external_hours: $('apExt').value, memo: $('apMemo').value },
      () => { state.list = null; renderPerson(empId, back); });
  };
}

// 個人頁內容：登入後的「我的認證／人員頁」與免登入的「進度查詢」共用（o.lookup = 免登入、唯讀）
function personHTML(o) {
  const { empId, back, own, row, staff, records, apps, upcoming, myRegs, canAct } = o;
  const d = row[o.regime === 'new' ? 'detail_new' : 'detail'] || row.detail;
  const cert = d.activeCertificate;
  const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';
  const pending = (apps || []).some(a => a.status === '審核中');

  const hero = `
    <section class="card hero tone-${esc(d.statusCode)}">
      ${back ? `<button class="btn-link" type="button" onclick="go('${state.backTo || 'dept'}')">← 返回</button><br>` : ''}
      <span class="tag ${d.regime === 'legacy' ? 'legacy' : ''}">目前適用：${esc(d.regimeLabel)}</span>
      <div class="status">${esc(d.status)}</div>
      <div class="rule">${esc(d.trackLabel)}</div>
      <div class="rule">員工編號 ${o.lookup ? `${esc(empId)} <span class="nm">${esc(o.name || '')}</span>` : empLabel(empId)}｜${esc(staff?.dept || '')}｜${esc(staff?.title || '')}｜${esc(staff?.profession || '')}${cert ? `｜認證效期 ${esc(cert.valid_start_roc)}–${esc(cert.valid_end_roc)}` : ''}</div>
      <div class="reason">${esc(d.statusReason)}</div>
      ${(d.recommendations || []).length ? `<ul class="recs">${d.recommendations.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${certTrack && canAct && !pending && (o.regime === 'legacy' || o.role !== 'general') ? `<details class="apply"><summary class="btn ${d.initialEligible || d.renewalCompliant ? 'btn-primary' : 'btn-ghost'}" style="width:auto">${
          d.initialEligible || d.renewalCompliant
            ? `${own ? '申請' : '代為提報'}臨床教師認證（${d.trackType === 'renewal' ? '展延' : '新增'}）`
            : '點數尚未達標；若另有院外修課時數，可按此提出申請'}</summary>
        <form id="applyForm" class="inline-form">
          <label>教學醫院服務年資（展延免填）<input id="apYears" type="number" step="0.1" min="0" value="${d.trackType === 'renewal' ? '' : esc(d.seniority)}"></label>
          <label>院外師資培育課程時數（選填：課名、主辦單位、日期、時數）<input id="apExt" type="text"></label>
          <label>備註（選填）<input id="apMemo" type="text"></label>
          <button class="btn btn-primary" type="submit" style="width:auto">送出申請</button>
        </form></details>` : ''}
      ${pending ? '<div class="note">已有一筆審核中的申請。</div>' : ''}
      ${pecEx(empId) ? `<div class="attention">醫策會不受理本院提報：${esc(pecEx(empId).reason)}（${esc(pecEx(empId).at)} 標記）。${own ? '如資料有誤，請洽師培中心。' : ''}</div>` : ''}
      ${o.admin && certTrack ? (pecEx(empId)
        ? `<button class="btn btn-ghost" type="button" onclick="togglePec('${esc(empId)}', true)">取消標記，恢復列入醫策會提報</button>`
        : `<details class="apply"><summary class="btn btn-ghost" style="width:auto">標記為醫策會不受理（不列入提報）</summary>
            <div class="inline-form"><label>原因<select id="pecReason"><option>執業登記不在本院</option><option>年資不符醫策會規定</option><option>醫策會退件（其他原因）</option></select></label>
            <button class="btn btn-primary" style="width:auto" type="button" onclick="togglePec('${esc(empId)}', false)">確認標記</button></div></details>`) : ''}
    </section>`;

  // 下一步：把「現在該做什麼」放在結論之後、細節之前
  const eligible = certTrack && (d.initialEligible || d.renewalCompliant);
  const gaps = [];
  if ((d.missingBasicItems || []).length) gaps.push(`基礎項目尚缺：${d.missingBasicItems.join('、')}`);
  if (d.gapBasicHours > 0) gaps.push(`基礎課程還差 ${d.gapBasicHours} 點`);
  if (d.gapAdvancedHours > 0) gaps.push(`進階課程還差 ${d.gapAdvancedHours} 點`);
  if (!gaps.length && d.gapTotal > 0) gaps.push(`教學能力提升還差 ${d.gapTotal} 點`);
  if (!certTrack && d.gapTeaching > 0 && d.gapTotal > d.gapTeaching) gaps.push(`其中教學能力提升至少還要 ${d.gapTeaching} 點`);
  if (certTrack && d.trackType === 'initial' && !d.seniorityMet) gaps.push(`年資未達 ${d.requiredSeniority} 年（目前 ${d.seniority} 年），可先修課`);
  const regd = new Set((myRegs || []).map(r => r.course_id));
  const useful = (upcoming || []).filter(c => ['基礎課程', '進階課程', '教學能力提升'].includes(c.main_category)).slice(0, 3);
  const deadline = cert ? `請在認證效期 ${cert.valid_end_roc} 前完成。` : (certTrack ? '' : '請在今年 12 月 31 日前完成。');
  const who = own ? '您' : '這位同仁';
  let nextBody;
  if (pending) nextBody = `<p>${who}的認證申請正在審核中，暫時不需要其他動作。</p>`;
  else if (eligible && o.lookup) nextBody = `<p><b>您已符合資格。</b>${o.regime === 'new'
      ? '新制的認證由科部主管統一提報，您不需要自行申請；主管送出後，師培中心會協助您完成認證。'
      : '請登入本系統，在「我的認證」按「申請臨床教師認證」，由師培中心審查。'}</p>`;
  else if (eligible) nextBody = `<p><b>${who}已符合資格。</b>${
      o.regime === 'new'
        ? (own && o.role === 'general' ? '新制的認證由科部主管統一提報，您不需要自行申請；主管送出後，師培中心會協助您完成認證。' : '請在上方按「代為提報」，名單會送到師培中心。')
        : (own ? '可以直接在上方按「申請臨床教師認證」，由師培中心審查。' : '可以在上方按「代為提報」，或請同仁自行申請。')}</p>`;
  else if (!gaps.length) nextBody = `<p>目前不需要補修。${cert ? `認證效期至 ${esc(cert.valid_end_roc)}。` : ''}</p>`;
  else nextBody = `<ul class="recs">${gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul><p>${deadline}</p>
    ${useful.length ? `<div class="group-label">近期可報名、會計入教學能力提升的課程</div>
      ${useful.map(c => `<div class="next-course"><div><b>${esc(c.title)}</b><br><small>${esc(c.course_date)} ${esc((c.start_time || '').slice(0, 5))}｜${Number(c.hours)} 點${(c.sub_categories || []).length ? '｜' + esc(c.sub_categories.join('、')) : ''}</small></div>
        ${own && !o.lookup ? (regd.has(c.id) ? '<span class="pill expiring">已報名</span>' : `<button class="btn btn-primary" style="width:auto" type="button" onclick="act('course.register',{course_id:'${esc(c.id)}'},()=>renderPerson('${esc(empId)}'))">報名</button>`) : ''}</div>`).join('')}`
      : `<p class="hint">目前沒有開放報名的教學能力提升課程；有新課程時會出現在${o.lookup ? '登入後的' : ''}「課程」頁。</p>`}`;
  const next = `<section class="card next"><h3>下一步</h3>${nextBody}</section>`;

  const meters = reqCard(d, { who: own ? '您' : '這位同仁', link: true, rulesLink: own && !o.lookup });

  const p = o.regime === 'legacy' ? d.newRulePreview : null;
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

  const years = (d.yearly || []).length ? `
    <section class="card"><h3>逐年點數</h3><div class="years">
      ${d.yearly.map(y => `<div class="year ${esc(y.state)}"><b>${y.roc} 年</b> <small>${STATE_LABEL[y.state] || ''}</small><br>
        教學 <b class="num">${y.teach}</b>　基礎 <b class="num">${y.basic}</b>　進階 <b class="num">${y.adv}</b></div>`).join('')}
    </div></section>` : '';

  const eq = d.itemsEquipped || {};
  const itemRow = list => list.map(i => `<div class="item ${eq[i]?.hours > 0 ? 'on' : ''}"><span>${i}</span><span class="h num">${eq[i]?.hours || 0}</span></div>`).join('');
  const items = !certTrack ? '' : `
    <section class="card"><h3>九大教學能力項目（採計期間內的點數）</h3>
      <div class="group-label">基礎課程</div><div class="items">${itemRow(BASIC)}</div>
      <div class="group-label">進階課程</div><div class="items">${itemRow(ADVANCED)}</div>
    </section>`;

  const appList = !(apps || []).length ? '' : `
    <section class="card"><h3>認證申請紀錄</h3><div class="table-wrap"><table><thead><tr><th>送出時間</th><th>申請別</th><th>狀態</th><th>核定效期</th><th>審查意見</th></tr></thead><tbody>
      ${apps.map(a => `<tr><td>${esc(fmtTime(a.submitted_at))}</td><td>${esc(a.app_type)}</td><td><span class="pill ${a.status === '已通過' ? 'valid' : a.status === '審核中' ? 'expiring' : 'expired'}">${esc(a.status)}</span></td>
        <td>${a.valid_start ? `${esc(a.valid_start)} ～ ${esc(a.valid_end)}` : '—'}</td><td class="reason">${esc(a.review_comment || '')}</td></tr>`).join('')}
    </tbody></table></div></section>`;

  const info = { track_type: d.trackType, rg: d.regime, ve: cert && cert.valid_end, le: d.lastCertificate && d.lastCertificate.valid_end,
    grace: d.renewal && d.renewal.inGrace, wy: d.window && d.window.years, wl: d.window && d.window.label };
  const recs = `<section class="card" id="recSection"><h3>修課紀錄（日期、課程名稱、時數）</h3>${recordsTable(records, info)}</section>`;

  return hero + meters + appraisalCard(d) + next + preview + years + items + appList + recs;   // 結論 → 我的身分要完成什麼 → 下一步 → 細節
}

// 認證規範頁：主治醫師年度考核分數的計分方式
function apprRules(A, mine) {
  if (!A) return '';
  const sign = v => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');
  const rows = [...(A.tiers || [])].sort((a, b) => b.score - a.score).map(t => [t.label, t.score]).concat([[A.below_label || '未達 1 小時', A.below_score ?? -5]]);
  return `<h4 style="margin:16px 0 6px">主治醫師年度考核分數</h4>
    <div class="table-wrap"><table class="rules-t${mine ? ' mine-t' : ''}"><thead><tr><th>當年度師培時數（一般醫學＋教學能力提升）</th><th>基本分</th></tr></thead><tbody>
      ${rows.map(([l, s]) => `<tr><td>${esc(l)}</td><td class="num"><b>${sign(s)}</b> 分</td></tr>`).join('')}
      <tr><td>加分：${esc((A.bonus || {}).label || '核心教師認證課程，1 小時 1 分')}</td><td class="num">最多 +${(A.bonus || {}).cap ?? 20} 分</td></tr>
    </tbody></table></div>`;
}

// ---------- 認證規範：依身分整理 ED-026 第四條，並標出登入者自己的身分 ----------
async function renderRules() {
  const R = state.rules || {};
  const { data: mine } = await sb.from('cert_status').select('detail,detail_new').eq('emp_id', state.me.emp_id).maybeSingle();
  const md = mine ? (mine[D()] || mine.detail) : null;
  const myId = md && md.identity;
  const myCat = md && md.categoryId;
  const ph = R.physician || {};
  const L = R.legacy || {}, ini = R.initial_certification || {}, rc = R.renewal_certification || {};
  const nm = R.non_mohw_allied_health || {};
  const isNew = state.regime === 'new';
  const myProf = myId && myId.group === '醫事人員' ? myId.name : '';
  const here = on => on ? ' class="mine"' : '';

  const you = myId ? `<section class="card req-you"><h3>您的身分</h3>
      <div class="id-line"><span class="id-group">${esc(myId.group)}</span><b>${esc(myId.name)}</b><span class="id-stage">${esc(myId.stage || '')}</span></div>
      <div class="rule">${esc(md.trackLabel || '')}</div>
      <button class="btn btn-primary" style="width:auto;margin-top:8px" type="button" onclick="go('mine')">看我的進度</button></section>` : '';

  const doctors = `<section class="card"><h3>一、醫師（依執登職類：西醫師、中醫師、牙醫師執照）｜每年完成</h3>
    <p class="hint">「一般醫學基本能力」與「教學能力提升」課程都可計入總點數，其中教學能力提升要達到下表下限。每年 1/1–12/31 分年計算，不得跨年抵充。</p>
    <div class="table-wrap"><table class="rules-t"><thead><tr><th>身分（依職稱）</th><th>每年應完成</th></tr></thead><tbody>
    ${(ph.categories || []).map(c => `<tr${here(myCat === c.id)}><td><b>${esc(c.name)}</b></td>
      <td>總點數 <b class="num">${c.annual_total_hours}</b> 點，其中教學能力提升至少 <b class="num">${c.annual_teaching_skill_hours}</b> 點${c.annual_irb_hours ? `；另人體試驗相關訓練至少 <b class="num">${c.annual_irb_hours}</b> 點` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="note">先依「執登職類」判定是否為醫師（持西醫師、中醫師或牙醫師執照者一律歸為醫師），再依職稱分身分：
      第一、二年住院醫師 → 住院醫師（第一、二年）；第三年以上住院醫師、總醫師 → 住院醫師（第三年以上）；研究醫師、完訓醫師 → 研究醫師／完訓醫師；主治醫師、主任等 → 主治醫師。
      PGY 醫師不在第四條所列身分，不列管；沒有本院執登資料者（兼任、代訓醫師等）依執登職類不屬醫師，也不列管。
      符合當年度時數規範者，即為當年度臨床教師。</div>
    ${apprRules(ph.vs_appraisal, myCat === 'vs')}</section>`;

  const seniorityRows = (R.professions || []).map(p => `<tr${here(myProf && (p.name === myProf))}><td>${esc(p.name)}</td><td class="num">${p.seniority_years} 年</td><td class="num">${p.training_eligibility_years} 年</td></tr>`).join('');
  const allied = `<section class="card"><h3>二、醫事人員｜衛福部臨床醫事人員培訓計畫之臨床教師</h3>
    <div class="cmp">
      <div class="cmp-col ${isNew ? '' : 'now'}"><h4>舊制（現行 114.04 版）${isNew ? '' : '<span class="pill valid">目前適用</span>'}</h4>
        <dl><dt>初次認證</dt><dd>申請當月前 ${(L.initial_window_months || 24) / 12} 年內完成「教學能力提升」${L.initial_total_hours || 10} 點（不分基礎／進階）</dd>
          <dt>效期</dt><dd>${L.cert_validity_years || 2} 年</dd>
          <dt>展延</dt><dd>效期屆滿前 ${(L.renewal_window_months || 24) / 12} 年內完成 ${L.renewal_total || 8} 點（平均每年 4 點）</dd>
          <dt>保留期</dt><dd>屆滿後 ${L.grace_months || 10} 個月內補足可重新取得資格；保留期間不具教師資格</dd></dl></div>
      <div class="cmp-col ${isNew ? 'now' : ''}"><h4>新制（${(R.regime || {}).new_from_year ? (R.regime.new_from_year - 1911) + ' 年起' : '修訂草案'}）${isNew ? '<span class="pill valid">目前適用</span>' : ''}</h4>
        <dl><dt>初次認證</dt><dd>認證前 ${ini.timeframe_years || 2} 年內完成 ${ini.required_total_hours || 10} 點：基礎四項（課程設計、教學技巧、評估技巧、教材製作）各 1 點，加上進階 ${(ini.advanced_courses || {}).required_total_hours || 6} 點</dd>
          <dt>效期</dt><dd>${rc.validity_years || 4} 年（次年 1/1 起至第 ${rc.validity_years || 4} 年 12/31）</dd>
          <dt>展延</dt><dd>效期內每年 ${rc.annual_required_hours || 4} 點（基礎 ${rc.annual_basic_required_hours ?? 2}＋進階 ${rc.annual_advanced_required_hours ?? 2}），不得跨年抵充</dd>
          <dt>補救</dt><dd>${esc(rc.remedy_rule || '')}</dd>
          <dt>提報</dt><dd>由科部主管統一提報，師培中心審查</dd></dl></div>
    </div>
    <h4 style="margin-top:14px">教學醫院執業年資門檻</h4>
    <div class="table-wrap"><table><thead><tr><th>職類</th><th>取得教師資格</th><th>可開始修課採計</th></tr></thead><tbody>${seniorityRows}</tbody></table></div>
    <div class="note">醫策會教師認證資料中「教學年資」標示為「不符合」的認證，本系統不採計為有效認證。</div></section>`;

  const others = `<section class="card"><h3>三、其他對象</h3>
    <p>非擔任衛福部培訓計畫之醫事人員臨床教師：每年「一般醫學基本能力」或「教學能力提升」至少 <b>${nm.annual_total_hours || 4}</b> 點，其中「教學能力提升」至少 <b>${nm.annual_teaching_skill_hours || 2}</b> 點。</p>
    <p${here(myId && myId.stage === '不列管')}>行政及其他人員、PGY、代訓醫師等不在本辦法所列對象，不列入檢核；修課紀錄仍會保留，可隨時查詢。</p></section>`;

  const common = `<section class="card"><h3>四、共同規定</h3><ul class="recs">
    <li>線上教學能力提升課程每年至多採認 ${(R.general || {}).online_teaching_cap_per_year || 1} 點。</li>
    <li>院外或科部自辦師資培育課程，可依「師資培育中心設置暨運作管理辦法」第八條提出申請採計。</li>
    <li>當年度報名師資培育課程連續 2 場或累計 5 場未出席，取消當年度線上報名資格。</li>
    <li>申請新聘或升等教職：申請前一年度完成至少 4 點；臨床醫師另需申請前 3 年內完成教學能力提升 10 點以上。</li></ul>
    <div class="note">依據：臨床教學師資培育暨獎勵辦法（ED-026）第二條、第四條。本頁內容由系統規則設定產生，與計算結果使用同一份規則。</div></section>`;

  $('content').innerHTML = you + doctors + allied + others + common;
}

// ---------- 名單 ----------
const ORDER = { expiring: 0, remedy: 1, eligible: 2, expired: 3, deficient: 4, valid: 5 };
function distRows(list, keyOf = profGroup) {
  const by = {};
  list.forEach(r => {
    const k = keyOf(r);
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
  state.viewList = list; state.viewRef = undefined;
  const count = c => list.filter(r => r.status_code === c).length;
  const kpis = isAdmin() ? '' : `
    <section class="kpis">
      <button type="button" class="kpi" onclick="pickStatus('')"><b class="num">${list.length}</b><span>所屬人員</span></button>
      <button type="button" class="kpi" style="--tone:var(--success)" onclick="pickStatus('valid')"><b class="num">${count('valid')}</b><span>認證有效／年度達標</span></button>
      <button type="button" class="kpi" style="--tone:var(--secondary)" onclick="pickStatus('can')"><b class="num">${list.filter(r => r.can_apply).length}</b><span>可提報認證 ›</span></button>
      <button type="button" class="kpi" style="--tone:var(--warning)" onclick="pickStatus('expiring')"><b class="num">${count('expiring') + count('remedy')}</b><span>即將到期、點數尚缺 ›</span></button>
    </section>
    <section class="card"><h3>各職類認證分佈</h3>${LEGEND}${distRows(list)}</section>`;
  $('content').innerHTML = kpis + `
    <section class="card"><h3>人員名單</h3>
      <div class="filters">
        <input id="fQ" type="search" placeholder="員工編號或單位">
        <select id="fS"><option value="">所有狀態</option><option value="can">可提報認證</option><option value="expiring">今年到期尚未符合</option><option value="valid">有效／達標</option><option value="deficient">尚未符合</option>${state.regime === 'legacy' ? '<option value="newgap">新制試算不符合</option>' : ''}</select>
        ${nameBtn()}
        <span id="fN" class="hint" style="align-self:center;margin:0"></span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>員工編號</th><th>單位</th><th>職稱</th><th>職類</th><th title="醫師：年度總點數；醫事人員：教學能力提升點數">點數</th><th>狀態</th><th>說明</th><th>${state.regime === 'legacy' ? '新制試算' : ''}</th></tr></thead><tbody id="tb"></tbody></table></div>
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
      <td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${empLabel(r.emp_id)}</button>${pecTag(r.emp_id)}${r.on_plan ? ' <span class="pill eligible" title="列入本年度追蹤名單">追蹤</span>' : ''}</td>
      <td>${esc(r.dept)}</td><td>${esc(r.staff?.title || '')}</td><td>${esc(profGroup(r))}</td>
      <td class="num"><button class="btn-link" type="button" title="查看修課紀錄" onclick="showRecords('${esc(r.emp_id)}')">${esc(hoursOf(r))}</button> / ${esc(r.need)}</td>
      <td><span class="pill ${esc(r.status_code)}">${esc(r.status)}</span>${scorePill(r)}${r.valid_end ? `<br><small>至 ${esc(r.valid_end)}</small>` : ''}</td>
      <td class="reason">${esc(r.reason)}</td>
      <td>${r.new_ok === 'true' ? '<span class="pill valid">符合</span>' : r.new_ok === 'false' ? `<span class="pill expiring" title="${esc(r.new_reason)}">尚未符合</span>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">查無符合條件的人員</td></tr>';
  };
  $('fQ').oninput = draw; $('fS').onchange = draw; draw();
}

function pickStatus(v) { $('fS').value = v; $('fS').onchange(); $('fS').scrollIntoView({ behavior: 'smooth', block: 'center' }); }

async function renderOverview() {
  const list = await loadList();
  const cert = list.filter(r => r.track_type === 'initial' || r.track_type === 'renewal');
  const expiring = list.filter(r => r.track_type === 'renewal' && r.expiring === 'true');
  const renewable = expiring.filter(r => r.can_apply);
  const initial = list.filter(r => r.track_type === 'initial' && r.can_apply);
  const { count: pendingApps } = await sb.from('applications').select('*', { count: 'exact', head: true }).eq('status', '審核中');
  $('content').innerHTML = `
    <section class="kpis">
      <div class="kpi"><b class="num">${list.length.toLocaleString()}</b><span>全院人員</span></div>
      <div class="kpi" style="--tone:var(--success)"><b class="num">${list.filter(r => r.track_type === 'renewal' && r.valid_end).length.toLocaleString()}</b><span>持有效臨床教師認證</span></div>
      <div class="kpi" style="--tone:var(--warning)"><b class="num">${expiring.length}</b><span>今年底到期</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${renewable.length}</b><span>其中已符合展延</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${initial.length}</b><span>符合初次認證</span></div>
      <div class="kpi" style="--tone:var(--crimson)"><b class="num">${pendingApps || 0}</b><span>申請待審</span></div>
    </section>
    ${state.regime === 'legacy' ? `<section class="card preview"><h3>若改採新制</h3>
      <div>今年到期者符合展延：<b class="num">${expiring.filter(r => r.new_ok === 'true').length}</b> 人（目前 ${renewable.length} 人）；
      符合初次認證：<b class="num">${list.filter(r => r.track_type === 'initial' && r.new_ok === 'true').length}</b> 人（目前 ${initial.length} 人）。</div>
      <div class="note">到「名單查詢」選「新制試算不符合」可列出需要提前補修的人員。</div></section>` : ''}
    <section class="card"><h3>醫事職類認證分佈</h3>${LEGEND}${distRows(cert)}</section>
    ${annualCard(list)}`;
}

// 醫師與其他「每年師培時數」對象：依身分看今年度達標情形（不列管的身分另計）
function annualCard(list) {
  const annual = list.filter(r => r.track_type === 'physician' || r.track_type === 'annual');
  const exempt = list.filter(r => r.track_type === 'exempt').length;
  if (!annual.length) return '';
  const met = annual.filter(r => r.status_code === 'valid').length;
  // 主治醫師年度考核分數分佈
  const vs = annual.filter(r => r.score != null);
  const tierN = b => vs.filter(r => Number(r.sbase) === b).length;
  const avg = vs.length ? Math.round(vs.reduce((a, r) => a + Number(r.score), 0) / vs.length * 10) / 10 : 0;
  const scoreBlock = !vs.length ? '' : `<h4 style="margin:16px 0 6px">主治醫師年度考核分數（${vs.length} 人，平均 <span class="num">${avg}</span> 分）</h4>
    <div class="score-dist">
      ${[[10, '10 分', '達 4 小時含教學 2 小時', 'valid'], [5, '5 分', '達 2–3 小時', 'eligible'], [0, '0 分', '達 1 小時', 'expiring'], [-5, '−5 分', '未達 1 小時', 'expired']]
        .map(([b, t, d, c]) => `<div class="sd ${c}"><b class="num">${tierN(b)}</b><span>${t}</span><small>${d}</small></div>`).join('')}
      <div class="sd bonus"><b class="num">${vs.filter(r => Number(r.score) > Number(r.sbase)).length}</b><span>有加分</span><small>核心教師認證課程</small></div>
    </div>
    <div class="note">基本分依當年度師培時數；另以師培中心核心教師認證課程（SDM、EPA、ACGME 臨床教練等）時數加分，1 小時 1 分，上限 20 分。</div>`;
  return `<section class="card"><h3>醫師與其他人員：今年度師培時數（ED-026 第四條）</h3>
    <div class="rule">今年度已達標 <b class="num">${met}</b> / ${annual.length} 人（${Math.round(met / annual.length * 100)}%）${exempt ? `；不列管 ${exempt} 人（行政及其他人員、PGY、代訓醫師等）` : ''}</div>
    <div class="legend"><span><i style="background:var(--success)"></i>已達標</span><span><i style="background:var(--mist)"></i>未達標</span></div>
    ${distRows(annual, r => r.track_type === 'physician' ? `醫師｜${r.cat || ''}` : (r.cat || '其他人員'))}${scoreBlock}</section>`;
}

// ---------- 到期與提報：① 選時間 → ② 選職類 → ③ 名單與匯出（分段下鑽） ----------
// 下一段認證效期（與伺服器核准時的算法相同；回傳民國日期，供醫策會提報檔使用）
function certPeriod(r, ref) {
  const t = ref || today(), roc = d => `${Number(d.slice(0, 4)) - 1911}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const renewing = r.ve && r.ve >= t;
  let start, end;
  if (state.regime === 'legacy') {
    // 次月 1 日起整兩年，迄日為期滿月份的最後一天（與醫策會既有核予方式一致）
    const years = (state.rules.legacy || {}).cert_validity_years || 2;
    const from = renewing ? r.ve : t;
    const idx = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7));
    const ym = i => [Math.floor(i / 12), (i % 12) + 1], pad = n => String(n).padStart(2, '0');
    const [sy, sm] = ym(idx), [ey, em] = ym(idx + years * 12 - 1);
    start = `${sy}-${pad(sm)}-01`; end = `${ey}-${pad(em)}-${pad(new Date(ey, em, 0).getDate())}`;
  } else {
    const years = (state.rules.general || {}).cert_validity_years || 4;
    const sy = (renewing ? Number(r.ve.slice(0, 4)) : Number(t.slice(0, 4))) + 1;
    start = `${sy}-01-01`; end = `${sy + years - 1}-12-31`;
  }
  return { start: roc(start), end: roc(end) };
}

// ---------- 在瀏覽器內讀取本機名冊（不上傳），用來產生含姓名與身分證字號的醫策會上傳檔 ----------
function loadScript(src) {
  return new Promise((ok, bad) => { if (window.XLSX) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('無法載入試算表元件')); document.head.appendChild(s); });
}
async function pickRoster() {
  if (state.roster) return state.roster;
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const file = await new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.xlsx,.xls';
    input.onchange = () => resolve(input.files[0] || null); input.click();
  });
  if (!file) throw new Error('未選擇名冊檔');
  const wb = XLSX.read(await file.arrayBuffer());
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const H = rows[0].map(h => String(h).trim()), col = p => H.findIndex(h => h.startsWith(p));
  const c = { emp: col('帳號'), name: col('中文姓名'), id: col('身分證'), dept: H.indexOf('單位'), title: col('職稱') };
  if (c.emp === -1 || c.name === -1 || c.id === -1) throw new Error('這不是員工名冊：找不到「帳號／中文姓名／身分證」欄位');
  state.roster = new Map(rows.slice(1).filter(r => r[c.emp]).map(r => [String(r[c.emp]).trim().toLowerCase(),
    { name: String(r[c.name]).split(':')[0].trim(), id: String(r[c.id]).trim(), dept: String(r[c.dept] || '').trim(), title: String(r[c.title] || '').replace(/:\d+$/, '').trim() }]));
  toast(`已讀取名冊 ${state.roster.size} 人（只在這個瀏覽器分頁內使用，不會上傳；關閉分頁即清除）`);
  return state.roster;
}
async function downloadPec(rows, ref, label, kindOf) {
  try {
    const roster = await pickRoster();
    const general = state.rules.general || {};
    const upload = [], review = [], missing = [];
    rows.forEach(r => {
      const who = roster.get(r.emp_id.toLowerCase()), p = r.period || certPeriod(r, ref), prof = PEC_NAME[r.staff?.profession] || r.staff?.profession;
      if (!who || !/^[A-Z][0-9A-Z]\d{8}$/.test(who.id)) return missing.push(r.emp_id);
      upload.push({ '姓名': who.name, '身分證字號': who.id, '職類': prof, '教師認證效期起日': p.start, '教師認證效期迄日': p.end, '取得認證機構代碼': general.pec_org_code || '157', '取得認證機構名稱': general.pec_org_name || '中國醫藥大學附設醫院' });
      review.push({ '員工編號': r.emp_id, '姓名': who.name, '單位': r.dept, '職稱': r.staff?.title || '', '職類': prof, '申請別': kindOf(r), '教學能力提升點數': r.teach, '應達點數': r.need, '原效期迄日': r.valid_end || '', '提報效期起日': p.start, '提報效期迄日': p.end });
    });
    if (!upload.length) throw new Error('名冊中找不到這些人員的資料');
    const stamp = today().replace(/-/g, '');
    const a = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(a, XLSX.utils.json_to_sheet(upload), '工作表1');
    XLSX.writeFile(a, `PEC上傳檔_${label}_${stamp}.xls`, { bookType: 'biff8' });
    const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.json_to_sheet(review), '核對清冊');
    XLSX.writeFile(b, `PEC核對清冊_${label}_${stamp}.xlsx`);
    toast(`已下載上傳檔與核對清冊，共 ${upload.length} 人${missing.length ? `；另有 ${missing.length} 人不在名冊或證號格式不符，未納入（${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}）` : ''}`, !missing.length);
  } catch (err) { toast(err.message, false); }
}

async function renderExpiry() {
  const canCompare = state.regime === 'legacy';     // 全院已採新制時，兩套結果相同，不需比較
  const cutoff = state.rules.batch_cutoff || null;  // 批次基準日（例如 9/30）
  const rocDate = d => `${Number(d.slice(0, 4)) - 1911}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  let mode = (state.exp && state.exp.mode) || (canCompare ? 'legacy' : 'actual');
  if (mode === 'cutoff' && (!cutoff || !isAdmin())) mode = canCompare ? 'legacy' : 'actual';
  if (!canCompare && mode !== 'cutoff') mode = 'actual';
  const base = await loadList();
  const alt = mode === 'new' || mode === 'both' ? await loadNewRegimeList() : null;
  const list = mode === 'cutoff' ? await loadAltList('detail->batch') : mode === 'new' ? alt : base;
  const refDate = mode === 'cutoff' ? cutoff : undefined;
  state.viewList = list; state.viewRef = refDate;
  const other = mode === 'both' ? new Map(alt.map(r => [r.emp_id, r])) : null;
  const ready = r => !!r && (r.can_apply || r.cp === 'true');
  const buckets = new Map();
  const put = (key, label, hint, r) => { if (!buckets.has(key)) buckets.set(key, { key, label, hint, rows: [] }); buckets.get(key).rows.push(r); };
  list.forEach(r => {
    if (r.track_type === 'renewal' && r.ve) put(r.ve.slice(0, 7), `${Number(r.ve.slice(0, 4)) - 1911} 年 ${Number(r.ve.slice(5, 7))} 月屆滿`, '效期內教師', r);
    else if (r.grace === 'true') put('~grace', '展延保留期內', '效期已屆滿，尚可補足', r);
    else if (r.track_type === 'initial' && r.can_apply) put('~initial', '初次認證可提報', '尚無認證、已符合資格', r);
  });
  const keys = [...buckets.keys()].sort();
  const modes = [...(canCompare ? [['legacy', '舊制（目前適用）'], ['new', '新制試算'], ['both', '新舊並排比較']] : [['actual', '目前']]),
    ...(cutoff && isAdmin() ? [['cutoff', `基準日 ${rocDate(cutoff)} 批次`]] : [])];
  const modeNote = {
    both: '每一列上方的長條是舊制、下方是新制；名單會標出「舊制已達標、新制尚未符合」的人，這些人需要在改制前補修。',
    new: '以同一份修課紀錄改用新制計算的結果，僅供試算，不影響目前實際適用的制度；提報名單請回到「舊制」或「基準日批次」檢視匯出。',
    cutoff: cutoff ? `只採計 ${rocDate(cutoff)}（含）以前完成的課程，並以這一天判定到期與保留期。已認證教師：效期屆滿前 2 年內滿 8 點；新增：${rocDate(cutoff)} 往前 2 年內滿 10 點。` : '',
    legacy: '目前實際適用的制度，採計到最新一次資料更新為止的課程。', actual: '採計到最新一次資料更新為止的課程。'
  }[mode];
  const modeBar = modes.length < 2 ? '' : `
    <section class="card"><h3>檢視方式</h3><div class="seg" role="tablist">
      ${modes.map(([m, t]) => `<button type="button" role="tab" class="${mode === m ? 'is-active' : ''}" onclick="state.exp={mode:'${m}',bucket:state.exp&&state.exp.bucket,group:'',picked:new Set()};renderExpiry()">${t}</button>`).join('')}
    </div><div class="note">${modeNote}</div></section>`;
  // 月底批次：當月屆滿可展延＋保留期內已補足＋新增可提報
  const batchOn = isAdmin() && mode !== 'new' && mode !== 'both';
  const refMonth = (refDate || today()).slice(0, 7);
  const monthKeys = [...new Set([refMonth, ...keys.filter(k => !k.startsWith('~'))])].sort();
  const bm = state.batchMonth && monthKeys.includes(state.batchMonth) ? state.batchMonth : refMonth;
  const kindOf = r => r.track_type === 'initial' ? '新增' : (r.grace === 'true' ? '展延（保留期內補足）' : '展延');
  const batchAll = !batchOn ? [] : list.filter(r => r.can_apply && (r.track_type === 'initial' || r.grace === 'true' || (r.ve && r.ve.slice(0, 7) === bm)));
  const batchRows = batchAll.filter(r => !pecEx(r.emp_id));
  const batchSkipped = batchAll.filter(r => pecEx(r.emp_id));
  const bc = k => batchRows.filter(r => kindOf(r) === k).length;
  const monthName = k => `${Number(k.slice(0, 4)) - 1911} 年 ${Number(k.slice(5, 7))} 月`;
  const batchRef = `${bm}-28`;   // 效期自這個月的次月 1 日起算
  const batchPeriod = batchRows.length ? certPeriod(batchRows.find(r => r.track_type === 'initial') || batchRows[0], batchRef) : null;
  state.batch = { rows: batchRows, ref: batchRef, label: `${bm.replace('-', '')}月底批次`, kindOf };
  const batchCard = !batchOn ? '' : `
    <section class="card batch"><h3>月底批次：可上傳醫策會的名單</h3>
      <div class="filters" style="align-items:center">
        <label style="margin:0;font-weight:700">月份 <select id="bMonth" style="display:inline-block;width:auto;margin:0 0 0 6px">${monthKeys.map(k => `<option value="${k}" ${k === bm ? 'selected' : ''}>${monthName(k)}</option>`).join('')}</select></label>
        <span class="num">共 <b>${batchRows.length}</b> 人：當月屆滿可展延 <b>${bc('展延')}</b>・保留期內已補足 <b>${bc('展延（保留期內補足）')}</b>・新增 <b>${bc('新增')}</b></span>
      </div>
      ${batchSkipped.length ? `<div class="attention">已排除醫策會不受理 ${batchSkipped.length} 人：${batchSkipped.map(r => `${esc(r.emp_id)}（${esc(pecEx(r.emp_id).reason)}）`).join('、')}</div>` : ''}
      ${batchPeriod ? `<div class="note">提報效期：${batchPeriod.start}–${batchPeriod.end}（次月 1 日起整兩年）。已認證教師須在效期屆滿前 2 年內滿 8 點；新增須在 2 年內滿 10 點且年資達標。</div>` : ''}
      <div class="filters">
        <button class="btn btn-primary" style="width:auto" type="button" id="bPec" ${batchRows.length ? '' : 'disabled'}>下載醫策會上傳檔與核對清冊</button>
        <button class="btn btn-ghost" type="button" id="bCsv" ${batchRows.length ? '' : 'disabled'}>下載名單（僅員工編號）</button>
      </div>
      <div class="note">上傳檔需要姓名與身分證字號：按下後請選擇您電腦上的員工名冊（user….xlsx）。名冊只在這個瀏覽器分頁內讀取，不會上傳到任何地方。</div>
    </section>`;
  const wireBatch = () => {
    if (!batchOn) return;
    $('bMonth').onchange = e => { state.batchMonth = e.target.value; renderExpiry(); };
    $('bPec').onclick = () => downloadPec(state.batch.rows, state.batch.ref, state.batch.label, state.batch.kindOf);
    $('bCsv').onclick = () => download(`${state.batch.label}_名單_${today().replace(/-/g, '')}.csv`, [['員工編號', '單位', '職稱', '職類', '申請別', '教學點數', '應達點數', '原效期迄日', '提報效期起日', '提報效期迄日'],
      ...state.batch.rows.map(r => { const p = certPeriod(r, state.batch.ref); return [r.emp_id, r.dept, r.staff?.title, profGroup(r), kindOf(r), r.teach, r.need, r.valid_end, p.start, p.end]; })]);
  };
  if (!keys.length) { $('content').innerHTML = modeBar + batchCard; wireBatch(); if (!batchCard) $('content').innerHTML += '<div class="card empty">目前沒有即將到期或可提報的人員。</div>'; return; }
  const prev = state.exp || {};
  const ex = state.exp = { mode, bucket: buckets.has(prev.bucket) ? prev.bucket : keys[0], group: prev.group || '', picked: prev.picked || new Set() };
  const max = Math.max(...keys.map(k => buckets.get(k).rows.length));
  const okNew = rows => rows.filter(r => ready(other.get(r.emp_id))).length;
  const bar = (n, ok, cls = '') => `<span class="bar ${cls}" style="width:${Math.max(6, n / max * 100)}%"><i style="width:${ok / n * 100}%;background:var(--success)"></i><i style="width:${(n - ok) / n * 100}%;background:var(--warning)"></i></span>`;

  const timeRows = keys.map(k => {
    const b = buckets.get(k), n = b.rows.length, ok = b.rows.filter(ready).length;
    return `<button type="button" class="drill ${ex.bucket === k ? 'is-active' : ''}" onclick="state.exp.bucket='${k}';state.exp.group='';state.exp.picked=new Set();renderExpiry()">
      <span class="drill-label"><b>${esc(b.label)}</b><small>${esc(b.hint)}</small></span>
      <span class="bars">${bar(n, ok)}${other ? bar(n, okNew(b.rows), 'thin') : ''}</span>
      <span class="drill-num num"><b>${n}</b> 人・${other ? `舊制達標 <b>${ok}</b>・新制達標 <b>${okNew(b.rows)}</b>` : `已達標 <b>${ok}</b>・尚缺 <b>${n - ok}</b>`}</span></button>`;
  }).join('');

  const cur = buckets.get(ex.bucket);
  const groups = {};
  cur.rows.forEach(r => { const g = profGroup(r); groups[g] = groups[g] || []; groups[g].push(r); });
  const chips = [['', '全部職類', cur.rows], ...Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([g, v]) => [g, g, v])]
    .map(([g, label, v]) => { const n = v.length, ok = v.filter(ready).length; return `<button type="button" class="chip ${ex.group === g ? 'is-active' : ''}" onclick="state.exp.group='${esc(g)}';state.exp.picked=new Set();renderExpiry()">
      <b>${esc(label)}</b><span class="num">${other ? `舊 ${ok}・新 ${okNew(v)}／${n} 人` : `${ok} / ${n} 已達標`}</span>
      <span class="bar"><i style="width:${n ? ok / n * 100 : 0}%;background:var(--success)"></i></span>
      ${other ? `<span class="bar"><i style="width:${n ? okNew(v) / n * 100 : 0}%;background:var(--secondary)"></i></span>` : ''}</button>`; }).join('');

  const drop = r => other && ready(r) && !ready(other.get(r.emp_id));      // 舊制達標、新制不符
  const rows = cur.rows.filter(r => !ex.group || profGroup(r) === ex.group)
    .sort((a, b) => Number(drop(b)) - Number(drop(a)) || Number(ready(a)) - Number(ready(b)) || a.emp_id.localeCompare(b.emp_id));
  const exportable = isAdmin() && mode !== 'new';
  const submittable = state.role === 'dept_coordinator' && mode !== 'new' && mode !== 'both';
  const canPick = exportable || submittable ? rows.filter(r => r.can_apply && !pecEx(r.emp_id)) : [];
  const gap = r => {
    if (!r) return '—';
    const p = [];
    if (Number(r.gap_t) > 0) p.push(`總點數 −${r.gap_t}`);
    if (Number(r.gap_b) > 0) p.push(`基礎 −${r.gap_b}`);
    if (Number(r.gap_a) > 0) p.push(`進階 −${r.gap_a}`);
    return p.length ? `<span class="gap" title="${esc(r.reason)}">${p.join('・')}</span>` : '<span class="done">已達標</span>';
  };
  const dropCount = other ? rows.filter(drop).length : 0;
  $('content').innerHTML = modeBar + batchCard + `
    <section class="card"><h3><span class="step">1</span> 選擇時間　<small class="hint" style="display:inline">長條越長人數越多；綠色為已達標，黃色為尚缺點數</small></h3><div class="drills">${timeRows}</div></section>
    <section class="card"><h3><span class="step">2</span> ${esc(cur.label)}：選擇職類</h3><div class="chips">${chips}</div></section>
    <section class="card"><h3><span class="step">3</span> 名單（${rows.length} 人${ex.group ? '｜' + esc(ex.group) : ''}）</h3>
      ${other ? `<div class="attention">其中 <b>${dropCount}</b> 人在舊制已達標、改採新制後尚未符合，已排在最前面。</div>` : ''}
      <div class="filters">
        ${canPick.length ? `<button class="btn btn-ghost" type="button" id="pickAll">全選可提報（${canPick.length}）</button>
          ${exportable ? '<button class="btn btn-primary" style="width:auto" type="button" id="pecBtn">下載勾選者的醫策會上傳檔</button>'
            : '<button class="btn btn-primary" style="width:auto" type="button" id="sendBtn">送師培中心審查（勾選者）</button>'}` : ''}
        <button class="btn btn-ghost" type="button" id="listBtn">匯出此名單</button>
        ${nameBtn()}
        <span class="hint" id="pickN" style="align-self:center;margin:0"></span>
      </div>

      <div class="table-wrap"><table><thead><tr><th></th><th>員工編號</th><th>單位</th><th>職稱</th><th>職類</th><th>效期迄日</th>
        ${other ? '<th>舊制點數</th><th>舊制</th><th>新制（基礎／進階）</th><th>新制</th>' : `<th>教學點數</th><th>缺口</th><th>狀態</th>${exportable ? '<th>提報效期</th>' : ''}`}</tr></thead><tbody>
      ${rows.slice(0, 500).map(r => { const o = other && other.get(r.emp_id); return `<tr class="${drop(r) ? 'row-drop' : ''}">
        <td>${canPick.length && r.can_apply ? `<input type="checkbox" class="pick" value="${esc(r.emp_id)}" ${ex.picked.has(r.emp_id) ? 'checked' : ''} aria-label="選取 ${esc(r.emp_id)}">` : ''}</td>
        <td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${empLabel(r.emp_id)}</button>${pecTag(r.emp_id)}</td>
        <td>${esc(r.dept)}</td><td>${esc(r.staff?.title || '')}</td><td>${esc(profGroup(r))}</td><td>${esc(r.valid_end || '—')}</td>
        ${other ? `<td class="num"><button class="btn-link" type="button" title="查看修課紀錄" onclick="showRecords('${esc(r.emp_id)}')">${esc(r.teach)}</button> / ${esc(r.need)}</td><td>${gap(r)}</td>
            <td class="num">${o ? `<b>${esc(o.basic)}</b>／<b>${esc(o.adv)}</b>` : '—'}</td><td>${gap(o)}</td>`
          : `<td class="num"><button class="btn-link" type="button" title="查看修課紀錄" onclick="showRecords('${esc(r.emp_id)}')">${esc(r.teach)}</button> / ${esc(r.need)}</td><td>${gap(r)}</td>
            <td><span class="pill ${esc(r.status_code)}">${esc(r.status)}</span></td>
            ${exportable ? `<td class="num">${r.can_apply ? (p => `${p.start}–${p.end}`)(certPeriod(r, refDate)) : ''}</td>` : ''}`}
      </tr>`; }).join('')}</tbody></table></div>
      ${rows.length > 500 ? '<div class="note">畫面只列前 500 人，請先選職類縮小範圍；匯出則包含全部。</div>' : ''}
    </section>`;

  wireBatch();
  const sync = () => { $('pickN').textContent = ex.picked.size ? `已選 ${ex.picked.size} 人` : ''; };
  document.querySelectorAll('.pick').forEach(c => { c.onchange = () => { c.checked ? ex.picked.add(c.value) : ex.picked.delete(c.value); sync(); }; });
  if ($('pickAll')) $('pickAll').onclick = () => { canPick.forEach(r => ex.picked.add(r.emp_id)); renderExpiry(); };
  if ($('sendBtn')) $('sendBtn').onclick = async () => {
    const sel = canPick.filter(r => ex.picked.has(r.emp_id));
    if (!sel.length) return toast('請先勾選要提報的同仁（只有已符合資格者可以勾選）', false);
    $('sendBtn').disabled = true;
    let ok = 0; const failed = [];
    for (const r of sel) {
      try { await api('cert.apply', { emp_id: r.emp_id, memo: '科部主管提報' }); ok++; }
      catch (err) { failed.push(`${r.emp_id}（${err.message}）`); }
    }
    ex.picked = new Set(); state.list = null; state.alts = {};
    toast(`已送出 ${ok} 人${failed.length ? `；${failed.length} 人未送出：${failed.slice(0, 3).join('、')}` : ''}`, !failed.length);
    renderExpiry();
  };
  if ($('pecBtn')) $('pecBtn').onclick = () => {
    const sel = canPick.filter(r => ex.picked.has(r.emp_id));
    if (!sel.length) return toast('請先勾選要提報的人員（只有已符合資格者可以勾選）', false);
    downloadPec(sel, refDate, '自選名單', kindOf);
  };
  $('listBtn').onclick = () => download(`${cur.label}_${mode === 'both' ? '新舊比較' : mode === 'new' ? '新制試算' : mode === 'cutoff' ? '基準日' + cutoff.replace(/-/g, '') : '名單'}_${today().replace(/-/g, '')}.csv`,
    other ? [['員工編號', '單位', '職稱', '職類', '效期迄日', '舊制教學點數', '舊制應達', '舊制狀態', '新制基礎', '新制進階', '新制狀態', '新制說明', '舊制達標但新制不符'],
        ...rows.map(r => { const o = other.get(r.emp_id) || {}; return [r.emp_id, r.dept, r.staff?.title, profGroup(r), r.valid_end, r.teach, r.need, r.status, o.basic, o.adv, o.status, o.reason, drop(r) ? '是' : '']; })]
      : [['員工編號', '單位', '職稱', '職類', '效期迄日', '教學點數', '應達點數', '尚缺', '狀態', '說明'],
        ...rows.map(r => [r.emp_id, r.dept, r.staff?.title, profGroup(r), r.valid_end, r.teach, r.need, r.gap_t, r.status, r.reason])]);
  sync();
}

// ---------- 課程：開課、報名、QR 簽到 ----------
async function renderCourses() {
  const [{ data: courses, error }, { data: myRegs }] = await Promise.all([
    sb.from('courses').select('*').order('course_date', { ascending: false }).limit(200),
    sb.from('registrations').select('course_id,checked_in_at').eq('emp_id', state.me.emp_id)
  ]);
  if (error) throw error;
  const mine = new Map((myRegs || []).map(r => [r.course_id, r]));
  const upcoming = courses.filter(c => c.course_date >= today());
  const counts = {};
  await Promise.all(upcoming.map(async c => { const { data } = await sb.rpc('course_registered_count', { cid: c.id }); counts[c.id] = data ?? 0; }));
  state.courses = courses;

  const card = c => {
    const reg = mine.get(c.id), open = c.course_date >= today();
    const full = c.max_capacity > 0 && (counts[c.id] || 0) >= c.max_capacity;
    return `<article class="course">
      <div class="course-top"><span class="pill ${c.main_category === '基礎課程' ? 'valid' : c.main_category === '進階課程' ? 'eligible' : ''}">${esc(c.main_category)}</span>
        ${reg?.checked_in_at ? '<span class="pill valid">已簽到</span>' : reg ? '<span class="pill expiring">已報名</span>' : ''}</div>
      <h3>${esc(c.title)}</h3>
      <div class="course-meta">${esc(c.course_date)} ${esc((c.start_time || '').slice(0, 5))}${c.end_time ? '–' + esc(c.end_time.slice(0, 5)) : ''}｜<b>${Number(c.hours)}</b> 點${c.instructor ? `｜講師 ${esc(c.instructor)}` : ''}</div>
      <div class="course-meta">${esc([c.location_type, c.location_detail].filter(Boolean).join('　'))}</div>
      ${(c.sub_categories || []).length ? `<div class="course-tags">${c.sub_categories.map(s => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
      ${open ? `<div class="course-meta">已報名 ${counts[c.id] ?? 0}${c.max_capacity ? ` / ${c.max_capacity}` : ''} 人</div>` : ''}
      <div class="course-actions">
        ${open && !reg ? `<button class="btn btn-primary" style="width:auto" type="button" ${full ? 'disabled' : ''} onclick="act('course.register',{course_id:'${esc(c.id)}'},renderCourses)">${full ? '已額滿' : '報名'}</button>` : ''}
        ${open && reg && !reg.checked_in_at ? `<button class="btn btn-ghost" type="button" onclick="act('course.cancel',{course_id:'${esc(c.id)}'},renderCourses)">取消報名</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-ghost" type="button" onclick="showQr('${esc(c.id)}')">簽到 QR</button>
          <button class="btn btn-ghost" type="button" onclick="editCourse('${esc(c.id)}')">編輯</button>
          <button class="btn btn-ghost" type="button" onclick="act('course.delete',{id:'${esc(c.id)}'},renderCourses)">刪除</button>` : ''}
      </div></article>`;
  };
  const past = courses.filter(c => c.course_date < today());
  $('content').innerHTML = `
    ${isAdmin() ? '<section class="card" id="courseFormCard"></section>' : ''}
    <section class="card" id="qrCard" hidden></section>
    <section><h2 class="section-title">即將舉辦</h2><div class="course-grid">${upcoming.reverse().map(card).join('') || '<div class="card empty">目前沒有開放報名的課程</div>'}</div></section>
    ${past.length ? `<section><h2 class="section-title">已結束</h2><div class="course-grid">${past.slice(0, 30).map(card).join('')}</div></section>` : ''}`;
  if (isAdmin()) drawCourseForm();
}

function drawCourseForm(c = {}) {
  const sel = new Set(c.sub_categories || []);
  $('courseFormCard').innerHTML = `
    <details ${c.id ? 'open' : ''}><summary><h3 style="display:inline">${c.id ? '編輯課程' : '開立新課程'}</h3></summary>
    <form id="courseForm" class="grid-form">
      <label class="wide">課程名稱<input id="cTitle" required value="${esc(c.title || '')}"></label>
      <label>日期<input id="cDate" type="date" required value="${esc(c.course_date || '')}"></label>
      <label>開始<input id="cStart" type="time" value="${esc((c.start_time || '').slice(0, 5))}"></label>
      <label>結束<input id="cEnd" type="time" value="${esc((c.end_time || '').slice(0, 5))}"></label>
      <label>時數（點）<input id="cHours" type="number" step="0.5" min="0.5" required value="${esc(c.hours || '')}"></label>
      <label>類別<select id="cCat">${['基礎課程', '進階課程', '一般醫學'].map(k => `<option ${c.main_category === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>名額（0＝不限）<input id="cCap" type="number" min="0" value="${esc(c.max_capacity || 0)}"></label>
      <label>形式<select id="cType">${['實體課程', '線上同步', '混成'].map(k => `<option ${c.location_type === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>地點<input id="cLoc" value="${esc(c.location_detail || '')}"></label>
      <label>講師<input id="cIns" value="${esc(c.instructor || '')}"></label>
      <fieldset class="wide"><legend>對應的教學能力項目（決定點數計入哪一項；可複選，時數平均分配）</legend>
        <div class="checks">${[...BASIC, ...ADVANCED].map(i => `<label><input type="checkbox" name="cItem" value="${i}" ${sel.has(i) ? 'checked' : ''}> ${BASIC.includes(i) ? '基礎' : '進階'}｜${i}</label>`).join('')}</div></fieldset>
      <div class="wide"><button class="btn btn-primary" style="width:auto" type="submit">${c.id ? '儲存修改' : '開課'}</button>
        ${c.id ? '<button class="btn btn-ghost" type="button" onclick="drawCourseForm()">取消</button>' : ''}</div>
    </form></details>`;
  $('courseForm').onsubmit = e => {
    e.preventDefault();
    act('course.save', { course: {
      id: c.id, title: $('cTitle').value, course_date: $('cDate').value, start_time: $('cStart').value || null, end_time: $('cEnd').value || null,
      hours: $('cHours').value, main_category: $('cCat').value, max_capacity: $('cCap').value, location_type: $('cType').value,
      location_detail: $('cLoc').value, instructor: $('cIns').value,
      sub_categories: [...document.querySelectorAll('input[name=cItem]:checked')].map(i => i.value)
    } }, renderCourses);
  };
}
function editCourse(id) { drawCourseForm(state.courses.find(c => c.id === id)); $('courseFormCard').scrollIntoView(); }

async function showQr(id) {
  clearInterval(state.qrTimer);
  const c = state.courses.find(x => x.id === id);
  const card = $('qrCard'); card.hidden = false;
  card.innerHTML = `<h3>簽到 QR｜${esc(c.title)}</h3>
    <div class="qr-wrap"><div id="qrBox"></div>
      <div><div class="status" id="qrCount">—</div><div class="rule">已簽到人數</div>
      <div class="note">請學員用手機相機掃描。QR 每 12 秒更新，截圖無效。<br>尚未登入的學員會先看到登入畫面，登入後自動完成簽到。</div>
      <button class="btn btn-ghost" type="button" onclick="clearInterval(state.qrTimer);$('qrCard').hidden=true">結束簽到</button></div></div>`;
  card.scrollIntoView();
  let last = '';
  const tick = async () => {
    try {
      const d = await api('course.qr', { course_id: id });
      if (d.token !== last) {
        last = d.token; $('qrBox').innerHTML = '';
        new QRCode($('qrBox'), { text: `${location.origin}${location.pathname}?checkin=${encodeURIComponent(id)}&t=${encodeURIComponent(d.token)}`, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
      }
      const { count } = await sb.from('registrations').select('*', { count: 'exact', head: true }).eq('course_id', id).not('checked_in_at', 'is', null);
      $('qrCount').textContent = `${count ?? 0} 人`;
    } catch (err) { clearInterval(state.qrTimer); toast(err.message, false); }
  };
  await tick();
  state.qrTimer = setInterval(tick, 4000);
}

// ---------- 審查（管理者） ----------
async function renderReview() {
  const { data: apps, error } = await sb.from('applications').select('*, staff!applications_emp_id_fkey(dept,title,profession)').order('submitted_at', { ascending: false }).limit(200);
  if (error) throw error;
  const row = a => `<tr>
    <td><button class="btn-link" type="button" onclick="go('person','${esc(a.emp_id)}')">${empLabel(a.emp_id)}</button><br><small>${esc(a.staff?.dept || '')}</small></td>
    <td>${esc(a.app_type)}<br><small>${esc(fmtTime(a.submitted_at))}${a.submitted_by && a.submitted_by !== a.emp_id ? `<br>由 ${esc(a.submitted_by)} 提報` : ''}</small></td>
    <td class="reason"><span class="pill ${a.auto_check?.eligible ? 'valid' : 'expired'}">系統檢核${a.auto_check?.eligible ? '符合' : '未符合'}</span>
      ${esc(a.auto_check?.reason || '')}<br>教學 ${esc(a.auto_check?.teaching)}・基礎 ${esc(a.auto_check?.basic)}・進階 ${esc(a.auto_check?.advanced)}（${esc(a.auto_check?.window || '')}）
      ${a.external_hours ? `<br>院外時數：${esc(a.external_hours)}` : ''}${a.memo ? `<br>備註：${esc(a.memo)}` : ''}</td>
    <td>${a.status === '審核中' ? `<input id="cm-${esc(a.id)}" placeholder="審查意見（選填）" style="width:150px"><br>
        <button class="btn btn-primary" style="width:auto;padding:6px 12px" type="button" onclick="review('${esc(a.id)}',true)">核准</button>
        <button class="btn btn-ghost" type="button" onclick="review('${esc(a.id)}',false)">退回</button>`
      : `<span class="pill ${a.status === '已通過' ? 'valid' : 'expired'}">${esc(a.status)}</span><br><small>${a.valid_start ? `${esc(a.valid_start)}～${esc(a.valid_end)}` : esc(a.review_comment || '')}</small>`}</td></tr>`;
  // 已核准、待上傳醫策會：依核准月份整理，一鍵產生上傳檔（效期用核准時寫入的效期）
  const approved = apps.filter(a => a.status === '已通過' && a.valid_start);
  const months = [...new Set(approved.map(a => String(a.reviewed_at).slice(0, 7)))].sort().reverse();
  const am = state.approvedMonth && months.includes(state.approvedMonth) ? state.approvedMonth : months[0];
  const rocD = d => `${Number(d.slice(0, 4)) - 1911}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const amRows = approved.filter(a => String(a.reviewed_at).slice(0, 7) === am && !pecEx(a.emp_id)).map(a => ({
    emp_id: a.emp_id, dept: a.staff?.dept, staff: a.staff, teach: a.auto_check?.teaching, need: '', valid_end: '', app_type: a.app_type,
    period: { start: rocD(a.valid_start), end: rocD(a.valid_end) } }));
  state.approvedRows = amRows;
  const approvedCard = !months.length ? '' : `<section class="card batch"><h3>已核准、待上傳醫策會</h3>
    <div class="filters" style="align-items:center"><label style="margin:0;font-weight:700">核准月份 <select id="amSel" style="display:inline-block;width:auto;margin-left:6px">${months.map(m => `<option value="${m}" ${m === am ? 'selected' : ''}>${Number(m.slice(0, 4)) - 1911} 年 ${Number(m.slice(5, 7))} 月</option>`).join('')}</select></label>
      <span class="num">共 <b>${amRows.length}</b> 人</span>
      <button class="btn btn-primary" style="width:auto" type="button" onclick="downloadPec(state.approvedRows, undefined, '核准名單', r => r.app_type)" ${amRows.length ? '' : 'disabled'}>下載醫策會上傳檔與核對清冊</button></div>
    <div class="note">新制由科部主管提報、您審查核准；核准後在這裡整理成醫策會上傳檔。按下後請選擇您電腦上的員工名冊（只在瀏覽器內讀取，不會上傳）。</div></section>`;
  $('content').innerHTML = approvedCard + `<section class="card"><h3>認證申請（${apps.filter(a => a.status === '審核中').length} 件待審）</h3>
    <div class="note">核准後系統會寫入認證效期並重新計算該員狀態；提報醫策會 PEC 平台仍需在您的電腦上產生提報檔（雲端沒有身分證字號）。</div>
    <div class="table-wrap"><table><thead><tr><th>員工編號</th><th>申請</th><th>系統檢核</th><th>審查</th></tr></thead><tbody>
    ${apps.map(row).join('') || '<tr><td colspan="4" class="empty">目前沒有申請</td></tr>'}</tbody></table></div></section>`;
  if ($('amSel')) $('amSel').onchange = e => { state.approvedMonth = e.target.value; renderReview(); };
}
function review(id, approve) { act('cert.review', { id, approve, comment: $(`cm-${id}`).value }, () => { state.list = null; renderReview(); }); }

// ---------- 年度追蹤名單 ----------
async function renderRoster() {
  const year = Number(today().slice(0, 4)) - 1911;
  const [{ data: rows, error }, list] = await Promise.all([
    sb.from('tracking_roster').select('*, staff!tracking_roster_emp_id_fkey(dept,title,profession)').eq('academic_year', year).order('emp_id'),
    loadList()
  ]);
  if (error) throw error;
  const st = new Map(list.map(r => [r.emp_id, r]));
  const active = rows.filter(r => r.status === '在職列管');
  const certified = active.filter(r => st.get(r.emp_id)?.track_type === 'renewal' && st.get(r.emp_id)?.valid_end);
  $('content').innerHTML = `
    <section class="kpis">
      <div class="kpi"><b class="num">${active.length ? Math.round(certified.length / active.length * 1000) / 10 : 0}%</b><span>${year} 年度臨床教師認證率</span></div>
      <div class="kpi" style="--tone:var(--success)"><b class="num">${certified.length} / ${active.length}</b><span>已具認證／統計分母（在職列管）</span></div>
      <div class="kpi" style="--tone:var(--mist)"><b class="num">${rows.length - active.length}</b><span>不列入分母（離職、留停、異動）</span></div>
    </section>
    <section class="card"><h3>提報 ${year} 年度應完成臨床教師訓練的人員</h3>
      <form id="rosterForm" class="inline-form">
        <label>員工編號<input id="rEmp" required></label>
        <label>類別<select id="rType"><option>初次認證培訓</option><option>效期展延列管</option></select></label>
        <label>狀態<select id="rStatus"><option>在職列管</option><option>離職</option><option>留職停薪</option><option>職務異動</option></select></label>
        <label>備註<input id="rNotes"></label>
        <button class="btn btn-primary" style="width:auto" type="submit">加入／更新</button>
      </form>
      <div class="note">認證率的分母以各職類年度訓練計畫所列人員為準；離職、留停、職務異動者改狀態即可，不必刪除，會另行列示。</div></section>
    <section class="card"><h3>${year} 年度追蹤名單（${rows.length} 人）</h3><div class="table-wrap"><table>
      <thead><tr><th>員工編號</th><th>單位</th><th>職類</th><th>類別</th><th>列管狀態</th><th>目前認證狀態</th><th>備註</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${empLabel(r.emp_id)}</button></td>
        <td>${esc(r.staff?.dept || '')}</td><td>${esc(r.staff?.profession || '')}</td><td>${esc(r.monitor_type || '')}</td>
        <td><span class="pill ${r.status === '在職列管' ? 'valid' : ''}">${esc(r.status)}</span></td>
        <td class="reason">${esc(st.get(r.emp_id)?.status || '')}</td><td class="reason">${esc(r.notes || '')}</td>
        <td><button class="btn btn-ghost" type="button" onclick="act('roster.remove',{id:${Number(r.id)}},()=>{state.list=null;renderRoster()})">移出</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">尚未提報</td></tr>'}
      </tbody></table></div></section>`;
  $('rosterForm').onsubmit = e => {
    e.preventDefault();
    act('roster.save', { emp_id: $('rEmp').value, monitor_type: $('rType').value, status: $('rStatus').value, notes: $('rNotes').value }, () => { state.list = null; renderRoster(); });
  };
}

// ---------- 管理（最高管理者） ----------
async function renderAdmin() {
  const { data: accounts, error } = await sb.from('profiles').select('emp_id,role,scope_dept,disabled,created_at').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const rg = regimeOf(state.rules);
  const year = Number(today().slice(0, 4)) - 1911;
  const opt = (mode, title, desc) => `<button type="button" class="regime ${rg.active === mode ? 'is-active' : ''}" ${rg.forced ? 'disabled' : `onclick="setRegime('${mode}')"`}><b>${title}</b><span>${desc}</span></button>`;
  $('content').innerHTML = `
    <section class="card"><h3>${year} 年度適用制度</h3><div class="regimes">
      ${opt('legacy', '舊制（現行 114.04 版）', '初次：申請前 2 年內教學能力提升 10 點。效期 2 年；展延：效期內平均每年 4 點，可保留至次年 10/31。')}
      ${opt('new', '新制（修訂草案）', '初次：基礎四項各 1 點＋進階 6 點。效期 4 年；每年基礎 2＋進階 2，不得跨年抵充。')}</div>
      <div class="note">${rg.forced ? `${rg.newFromYear - 1911} 年起已全面適用新制。` : `${rg.newFromYear - 1911} 年 1 月 1 日起自動全面改採新制；在那之前可隨時切換，切換後所有人的畫面立即改用對應的計算結果。`}</div></section>

    <section class="card"><h3>發開通碼</h3>
      <form id="codeForm" class="inline-form">
        <label>員工編號（可多個，以空白或逗號分隔）<input id="kIds" placeholder="例如 104343 M21742"></label>
        <label>或：單位名稱開頭<input id="kDept" placeholder="例如 藥劑部"></label>
        <label class="check"><input id="kRe" type="checkbox"> 已開通者也重發（重設密碼用）</label>
        <button class="btn btn-primary" style="width:auto" type="submit">產生</button>
      </form>
      <div id="codeOut"></div>
      <div class="note">開通碼只顯示這一次，雲端只保存雜湊。14 天內有效，連續輸錯 5 次失效。本站沒有姓名，請依員工編號發放。</div></section>

    <section class="card"><h3>授權角色</h3>
      <form id="roleForm" class="inline-form">
        <label>員工編號<input id="gEmp" required></label>
        <label>角色<select id="gRole"><option value="general">一般人員</option><option value="dept_coordinator">科部主管</option><option value="admin">師培中心管理者</option><option value="super_admin">最高管理者</option></select></label>
        <label>科部主管的授權範圍（單位名稱開頭；留空＝本人所屬單位）<input id="gScope"></label>
        <label class="check"><input id="gOff" type="checkbox"> 停用此帳號</label>
        <button class="btn btn-primary" style="width:auto" type="submit">套用</button>
      </form></section>

    <section class="card"><h3>已開通帳號（${accounts.length}）</h3><div class="table-wrap"><table>
      <thead><tr><th>員工編號</th><th>角色</th><th>授權範圍</th><th>狀態</th><th>開通時間</th></tr></thead><tbody>
      ${accounts.map(a => `<tr><td>${esc(a.emp_id)}</td><td>${esc(ROLE_LABEL[a.role])}</td><td>${esc(a.scope_dept || '—')}</td><td>${a.disabled ? '<span class="pill expired">停用</span>' : '<span class="pill valid">使用中</span>'}</td><td>${esc(fmtTime(a.created_at))}</td></tr>`).join('')}
      </tbody></table></div></section>`;

  $('codeForm').onsubmit = async e => {
    e.preventDefault();
    const d = await act('admin.issueCodes', { emp_ids: $('kIds').value.split(/[\s,，、]+/).filter(Boolean), dept: $('kDept').value.trim(), reissue: $('kRe').checked });
    if (!d) return;
    const csv = '﻿員工編號,單位,開通碼,類型,有效至\n' + d.codes.map(c => [c.emp_id, c.dept, c.code, c.kind, d.expires.slice(0, 10)].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    $('codeOut').innerHTML = `<p><a class="btn btn-ghost" href="${url}" download="開通碼_${today()}.csv">下載 CSV（${d.codes.length} 筆）</a></p>
      <div class="table-wrap"><table><thead><tr><th>員工編號</th><th>單位</th><th>開通碼</th><th>類型</th></tr></thead><tbody>
      ${d.codes.slice(0, 50).map(c => `<tr><td>${esc(c.emp_id)}</td><td>${esc(c.dept)}</td><td><code>${esc(c.code)}</code></td><td>${esc(c.kind)}</td></tr>`).join('')}</tbody></table></div>
      ${d.codes.length > 50 ? '<div class="note">畫面只列前 50 筆，完整清單請下載 CSV。</div>' : ''}`;
  };
  $('roleForm').onsubmit = e => {
    e.preventDefault();
    act('admin.setRole', { emp_id: $('gEmp').value, role: $('gRole').value, scope_dept: $('gScope').value.trim(), disabled: $('gOff').checked }, renderAdmin);
  };
}
async function setRegime(mode) {
  const d = await act('admin.setRegime', { mode });
  if (!d) return;
  const { data } = await sb.from('settings').select('value').eq('key', 'rules').maybeSingle();
  state.rules = data.value; state.regime = regimeOf(state.rules).active; state.list = null;
  renderAdmin();
}

sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') showAuth(); });
boot();
