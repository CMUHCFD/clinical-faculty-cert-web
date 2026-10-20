/* 臨床教師認證 — 前端（GitHub Pages）
 * 讀取：直接查 Supabase，由資料列權限 (RLS) 決定看得到的範圍。
 * 寫入：一律呼叫 Edge Function「api」，由伺服器端檢查身分與角色。
 * 本檔與 config.js 內沒有任何機密；anon 金鑰在未登入時讀不到任何資料。 */
const sb = supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.anonKey);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailOf = emp => `${emp.trim().toLowerCase()}@staff.invalid`;
const state = { me: null, role: 'general', view: null, list: null, regime: 'legacy', rules: null, qrTimer: null };

const ROLE_LABEL = { general: '一般人員', dept_coordinator: '科部主管', cfd_staff: '師培中心承辦人員', admin: '師培中心管理者', super_admin: '最高管理者' };
// 師培中心人員（管理者＋承辦人員）：可查詢全院、記錄來電；審查、授權等仍只限管理者（isAdmin）
const isCfd = () => isAdmin() || state.role === 'cfd_staff';
const STATE_LABEL = { met: '已達標', in_progress: '進行中', missed: '未達標（暫停資格）', made_up: '已補足', future: '尚未開始', exempt: '不另計（生效當年度或過渡）', window: '採計期間', counsel: '未達標（輔導年，不暫停）' };
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
// 使用紀錄：登入、查看個人頁、員工編號查詢（背景送出、不影響畫面；同一對象 5 分鐘內只記一次）
const _logged = new Map();
function logView(kind, target = '') {
  const key = `${kind}|${String(target).toLowerCase()}`, now = Date.now();
  if (_logged.has(key) && now - _logged.get(key) < 5 * 60e3) return;
  if (kind === 'login') {
    try { if (sessionStorage.getItem('cfdLoginLogged') === (state.me && state.me.emp_id)) return; sessionStorage.setItem('cfdLoginLogged', state.me.emp_id); } catch (e) { /* 無法使用時照常記錄 */ }
  }
  _logged.set(key, now);
  api('log.view', { kind, target }).catch(() => {});
}
async function act(action, payload, after) {
  try { const d = await api(action, payload); toast(d.message); if (after) await after(d); return d; }
  catch (err) { toast(err.message, false); }
}

// ---------- 登入／開通 ----------
function showAuth(msg, ok) {
  clearInterval(state.qrTimer);
  setFab(null);
  $('appView').hidden = true; $('authView').hidden = false;
  $('authMsg').textContent = msg || ''; $('authMsg').className = 'msg' + (ok ? ' ok' : '');
  authMode();
}
// 護理部專屬入口（…/#nursing）：登入頁改為護理部標題，只留登入與開通；一般同仁查詢進度的入口改成小連結
function authMode() {
  const nursing = location.hash === '#nursing';
  const card = document.querySelector('.auth-card'); if (!card) return;
  card.classList.toggle('auth-nursing', nursing);
  const h1 = card.querySelector('h1');
  if (!h1.dataset.orig) h1.dataset.orig = h1.textContent;
  h1.innerHTML = nursing ? '護理部｜臨床教師認證概況<small>護理長、督導專用</small>' : esc(h1.dataset.orig);
  document.title = nursing ? '護理部認證概況' : '臨床教師認證';
  if ($('goLookup')) $('goLookup').hidden = nursing;
  const or = card.querySelector('.or'); if (or) or.hidden = nursing;
  let hint = $('nurHint');
  if (nursing && !hint) {
    hint = document.createElement('div'); hint.id = 'nurHint'; hint.className = 'nur-hint';
    hint.innerHTML = '<p>請用<b>員工編號＋密碼</b>登入，登入後直接看到<b>您負責單位</b>的護理人員認證情形。</p><p>第一次使用：點上方「開通帳號」，輸入師培中心發給您的<b>開通碼</b>並自訂密碼。</p>';
    $('authMain').insertBefore(hint, $('authMain').querySelector('.tabs'));
    const back = document.createElement('p'); back.id = 'nurBack'; back.className = 'nur-back';
    back.innerHTML = '<button class="btn-link" type="button">一般同仁：查詢自己的認證進度 →</button>';
    back.querySelector('button').onclick = () => { history.replaceState(null, '', location.pathname); authMode(); setTab('lookup'); };
    $('authMain').appendChild(back);
  }
  if (hint) hint.hidden = !nursing;
  if ($('nurBack')) $('nurBack').hidden = !nursing;
}
window.addEventListener('hashchange', () => { if (!$('authView').hidden) authMode(); });
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
    // 送出問題反映時需要再次驗證：只暫存在記憶體，結束查詢或 10 分鐘後清除
    state.lkAuth = { emp: data.emp_id, last4: $('lkLast4').value.trim(), name: data.name };
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
  $('lkContent').innerHTML = lookupHTML(r) + feedbackCard('lookup') +
    `<section class="card lk-note"><b>這是免登入的唯讀查詢。</b>${how}要報名課程或申請，請先登入；還沒有帳號者，請向科部主管或師培中心索取開通碼。
      <br><small>為保護個資，查詢畫面 10 分鐘後會自動關閉；使用公用電腦時，看完請按右上角「結束查詢」。</small></section>`;
  clearTimeout(state.lkTimer); state.lkTimer = setTimeout(endLookup, 10 * 60e3);
  setFab('lookup');
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
      <div class="lk-sub">${months < 0 ? '已屆滿' : months <= 6 ? `<b class="warn">剩 ${months} 個月到期</b>` : `還有 ${months} 個月`}${cert.extended_from ? `<br><small>原至 ${esc(cert.extended_from_roc)}，依過渡規定延至年底</small>` : ''}</div>`;
  } else if (certTrack) {
    validity = `<div class="lk-big muted">尚未取得</div><div class="lk-sub">${d.lastCertificate ? `上一張效期至 ${esc(d.lastCertificate.valid_end_roc || d.lastCertificate.valid_end)}` : '目前沒有有效的臨床教師認證'}</div>`;
  }
  // 醫師沒有認證效期：主治醫師改顯示年度考核（CFD 構面），住院／研究醫師顯示是否為本年度臨床教師
  let firstTile;
  if (certTrack) firstTile = `<h3>認證效期</h3>${validity}`;
  else if (d.appraisal) {
    const a = d.appraisal;
    firstTile = `<h3>${a.roc} 年度考核｜CFD 構面</h3><div class="lk-big ${a.base >= 10 ? 'ok' : a.base < 0 ? 'warn' : ''}">${n(a.score)}<span class="lk-of"> 分</span></div>
      <div class="lk-sub">基本分 ${a.base > 0 ? '+' : ''}${a.base}・核心教師加分 +${n(a.bonus)}（滿分 ${a.maxScore}）</div>`;
  } else if (d.trackType === 'physician') {
    firstTile = `<h3>${Number(String(d.asOf || today()).slice(0, 4)) - 1911} 年度臨床教師</h3><div class="lk-big ${d.compliant ? 'ok' : 'warn'}">${d.compliant ? '是' : '尚未'}</div>
      <div class="lk-sub">${d.compliant ? '本年度時數已達標' : '完成本年度時數即具臨床教師資格'}</div>`;
  } else {
    firstTile = `<h3>適用規範</h3><div class="lk-big muted">不列管</div><div class="lk-sub">${esc(d.trackLabel || '')}</div>`;
  }
  const have = certTrack ? d.teachingHours : d.totalHours, need = d.requiredTotalHours;
  const pct = need ? Math.min(100, (Number(have) || 0) / need * 100) : 100;
  const pointsTile = `<div class="lk-big">${n(have)}<span class="lk-of"> / ${n(need)} 點</span></div>
    <div class="lk-bar"><i style="width:${pct}%" class="${pct >= 100 ? 'ok' : ''}"></i></div>
    <div class="lk-sub">${certTrack ? '教學能力提升' : '年度總點數'}・${esc(d.window?.label || '')}</div>`;

  const gaps = [];
  if (d.gapBasicItemsCount > 0) gaps.push(basicItemsGap(d));
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
      ${certTrack ? `<span class="tag ${d.regime === 'legacy' ? 'legacy' : ''}">適用：${esc(d.regimeLabel || '')}</span>` : ''}
    </section>
    <section class="lk-tiles">
      <div class="card lk-tile">${firstTile}</div>
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
      ${p.gapBasicItemsCount > 0 ? `<li>${esc(basicItemsGap(p))}</li>` : ''}${p.gapTotal > 0 ? `<li>合計還差 ${n(p.gapTotal)} 點</li>` : ''}
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

  const dn = r.regime === 'new' ? d : r.row.detail_new;
  const grid = certTrack ? newGrid(dn, { big: true, title: r.regime === 'new' ? '新制認證進度' : `${(d.newRulePreview && d.newRulePreview.appliesFrom) || 116} 年起改採新制：進度試算` }) : '';
  // 預設「簡單版」：一眼看懂狀態、還差什麼、下一步；完整內容收在「看詳細資料」
  return `<div class="lk">${simpleView(d, { records: r.records, apps: r.apps, regime: r.regime, lookup: true, name: r.name })}
    <div class="lk-more" ${simpleMode() ? 'hidden' : ''}>${hero}${roleBar(d)}
    ${block('teacher', d.trackType === 'exempt' ? '' : journeyCard(d) + reqCard(d, { big: true })
      + (certTrack && !d.transferredFrom ? '<section class="card lk-note">由其他教學醫院轉任者：您的他院認證可以採認，視為展延教師。請登入後在「我的認證」上傳原認證證書申請查證。</section>' : '')
      + grid + next + (grid ? '' : preview))}
    ${block('cfd', appraisalCard(d, { big: true }))}
    ${block('core', coreCard(d))}
    ${block('faculty', facultyCard(d, { big: true }), '新聘／升等')}
    ${block('lecturer', lecturerCard(d), '擔任教學能力提升課程講師')}
    ${block('pref', prefCard(r.records), '依修課紀錄分析')}
    ${block('records', detail + apps)}</div></div>`;
}

// ---------- 簡單版（以國中生讀得懂為目標）：一句話狀態 → 還要做什麼 → 走到哪裡 → 我的學習路線 ----------
// 原則：一張卡一件事；句子短、用「你」；不用「舊制、採計期間、展延」等術語；數字放大；細節收進「看詳細資料」
const simpleMode = () => { try { return localStorage.getItem('cfdView') !== 'full'; } catch (e) { return true; } };
function toggleView(btn) {
  const more = btn.closest('.lk, #content').querySelector('.lk-more');
  const show = more.hidden;
  more.hidden = !show;
  btn.textContent = show ? '收起詳細資料 ▲' : '看詳細資料 ▼';
  try { localStorage.setItem('cfdView', show ? 'full' : 'simple'); } catch (e) { /* 無法記住也沒關係 */ }
  if (show) more.scrollIntoView({ behavior: 'smooth' });
}
function simpleView(d, o = {}) {
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const roc = s => s ? `${Number(s.slice(0, 4)) - 1911} 年 ${Number(s.slice(5, 7))} 月 ${Number(s.slice(8, 10))} 日` : '';
  const cy = Number(String(d.asOf || today()).slice(0, 4));
  const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';
  const cert = d.activeCertificate;
  const pending = (o.apps || []).some(a => a.status === '審核中');
  const eligible = certTrack && (d.initialEligible || d.renewalCompliant);
  // ① 一句話狀態（顏色＋大字）
  let tone = 'ok', big, sub = '';
  const code = d.statusCode;
  if (d.trackType === 'exempt') { tone = 'muted'; big = '你不需要上師培課程'; sub = '你的職務不在臨床教師規定的範圍內。'; }
  else if (pending) { tone = 'info'; big = '你的申請正在審核中'; sub = '師培中心審核完會更新，你不用做任何事。'; }
  else if (d.trackType === 'physician' || d.trackType === 'annual') {
    tone = d.compliant ? 'ok' : 'warn';
    big = d.compliant ? `${cy - 1911} 年的時數已經完成` : `${cy - 1911} 年的時數還沒完成`;
    sub = d.trackType === 'physician' ? (d.compliant ? '你是今年的臨床教師。' : '完成今年的時數，就是今年的臨床教師。') : '';
  } else if (code === 'suspended') { tone = 'bad'; big = '你的教師資格暫停中'; sub = '把之前沒上完的時數補完，下個月 1 日就恢復。'; }
  else if (eligible) { tone = 'ok'; big = d.trackType === 'renewal' ? '你已經可以續約（展延）了' : '你已經可以申請臨床教師了'; }
  else if (code === 'valid') { tone = 'ok'; big = '你的臨床教師資格有效'; sub = cert ? `有效到 ${roc(cert.valid_end)}。` : ''; }
  else if (code === 'expiring') { tone = 'warn'; big = '你的資格快到期了'; sub = cert ? `${roc(cert.valid_end)} 到期。` : ''; }
  else if (code === 'expired') { tone = 'bad'; big = '你的臨床教師資格已經過期'; sub = '把時數上滿就可以重新申請。'; }
  else { tone = 'warn'; big = '你還不是臨床教師'; sub = '上滿下面的課程時數，就可以申請。'; }
  // ② 還要做什麼（最多 3 件，口語化）
  const word = { teach: '教學能力提升課', total: '師培課（一般醫學或教學能力提升都算）', basic: '基礎課', adv: '進階課', irb: '人體試驗相關課程', makeup: '補上之前沒完成的時數' };
  const todo = [];
  (d.requirements || []).filter(q => !q.met).forEach(q => {
    const gap = n(q.need - q.have);
    if (q.key === 'items') todo.push(`再修 ${gap} 種不同的基礎課（課程設計、教學技巧、評估技巧、教材製作 任選）`);
    else if (q.key === 'seniority') todo.push(`工作年資還差 ${gap} 年（課可以先上）`);
    else if (q.key === 'makeup') todo.push(`先補上 ${gap} 小時之前沒完成的時數`);
    else if (word[q.key]) todo.push(`再上 ${gap} 小時${word[q.key]}`);
  });
  // 期限：每年規範 → 今年 12/31；以效期計算（舊證展延）→ 效期到期日；初次認證沒有期限
  const yearly = ((d.window || {}).years || []).length === 1;
  const deadline = d.trackType === 'initial' ? '' : yearly || !cert ? `${cy - 1911} 年 12 月 31 日前` : `${roc(cert.valid_end)}前`;
  let next;
  if (d.trackType === 'exempt') next = '';
  else if (pending) next = '等通知就好。';
  else if (eligible) next = o.regime === 'new' ? '你不用自己送件，科部主管會幫你提報。' : (o.lookup ? '請登入系統，在「我的認證」按「申請」。' : '在下面詳細資料裡按「申請臨床教師認證」。');
  else if (!todo.length) next = '目前不用再上課，繼續保持。';
  else next = `${deadline ? `請在 ${deadline}完成：` : '完成下面這些就可以申請：'}`;
  // ③ 我的學習路線（一句話）
  const recs = (o.records || []).filter(x => Number(x.teaching_hours) > 0);
  const itemOf = x => { const s = `${x.category || ''} ${x.course_title || ''}`; return BASIC.find(b => s.includes(b)) || ADVANCED.find(a => s.includes(a)); };
  const cnt = {}; recs.forEach(x => { const i = itemOf(x); if (i) cnt[i] = (cnt[i] || 0) + Number(x.teaching_hours); });
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  const never = [...BASIC, ...ADVANCED].filter(i => !cnt[i]);
  const route = !recs.length ? '' : `<section class="card sv-route"><h3>你的學習路線</h3>
    <p>${top ? `你最常上的是 <b>${esc(top[0])}</b>。` : ''}${never.length && never.length < 9 ? `還沒上過：${never.slice(0, 3).map(esc).join('、')}${never.length > 3 ? ' 等' : ''}，可以試試看。` : ''}</p></section>`;
  // ④ 點數小路（重用旅程卡裡的人像）
  const have = Number(certTrack ? d.teachingHours : d.totalHours) || 0, need = Number(d.requiredTotalHours) || 0;
  const p = need ? Math.min(100, have / need * 100) : 0;
  const path = !need || d.trackType === 'exempt' ? '' : `<div class="pw ${have >= need ? 'arrived' : ''} sv-pw" role="img" aria-label="${n(have)} / ${n(need)} 小時">
      <div class="pw-road"><i style="width:${p}%"></i></div>
      <div class="pw-me" style="left:${have >= need ? 94 : p}%">${WALKER}<small>${have >= need ? '抵達！' : `${n(have)} 小時`}</small></div>
      <div class="pw-goal">${FLAG}<small>${n(need)} 小時</small></div></div>`;
  return `<section class="card sv sv-${tone}">
      ${o.name ? `<div class="sv-hi">${esc(o.name)}，你好</div>` : ''}
      <div class="sv-big">${esc(big)}</div>${sub ? `<p class="sv-sub">${esc(sub)}</p>` : ''}
      ${path}
      ${next || todo.length ? `<div class="sv-todo"><b>${esc(next)}</b>${todo.length && !eligible && !pending ? `<ul>${todo.slice(0, 3).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    </section>${route}
    <button class="btn btn-ghost sv-toggle" type="button" onclick="toggleView(this)">${simpleMode() ? '看詳細資料 ▼' : '收起詳細資料 ▲'}</button>`;
}
function endLookup() {
  clearTimeout(state.lkTimer);
  state.lkAuth = null; if ($('fbDlg') && $('fbDlg').open) $('fbDlg').close();
  setFab(null);
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
// 以員工編號查個人進度（師培中心：全院；科部主管：資料列權限只回傳所屬科部人員）
if ($('empSearch')) $('empSearch').onsubmit = async e => {
  e.preventDefault();
  const q = $('empQ').value.trim().replace(/[%_\\,()]/g, '');
  if (!q) return;
  const { data, error } = await sb.from('cert_status').select('emp_id').ilike('emp_id', q).limit(1);
  if (error) return toast('查詢失敗：' + error.message, false);
  if (!data || !data.length) return toast(`查無員工編號 ${q}${state.role === 'dept_coordinator' ? '，或此人不在您的科部範圍' : ''}。`, false);
  $('empQ').value = ''; $('empQ').blur();
  logView('search', data[0].emp_id);
  go('person', data[0].emp_id);
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
  `tot:${d}->>totalHours,score:${d}->appraisal->>score,sbase:${d}->appraisal->>base,staff(*)`;   // staff(*) 含姓名（008 起）
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
// 姓名：雲端 staff.name（008 起）；師培中心若另外選了本機名冊，也可對照
const nameOf = emp => (state.names && state.names.get(String(emp).toLowerCase())) || (state.roster && state.roster.get(String(emp).toLowerCase()) || {}).name || '';
const rememberNames = rows => {
  state.names = state.names || new Map();
  (rows || []).forEach(r => { const n = (r.staff && r.staff.name) || r.name; if (n && r.emp_id) state.names.set(String(r.emp_id).toLowerCase(), n); });
};
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
    state.list = rows; rememberNames(rows);
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
  const { data: profile } = await sb.from('profiles').select('*').eq('user_id', session.user.id).maybeSingle();   // 含職類別管理範圍（008）
  if (!profile || profile.disabled) { await sb.auth.signOut(); return showAuth('此帳號無法使用，請洽師培中心。'); }
  const [{ data: staff }, { data: setting }] = await Promise.all([
    sb.from('staff').select('*').eq('emp_id', profile.emp_id).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'rules').maybeSingle()
  ]);
  const { data: exRow } = await sb.from('settings').select('value').eq('key', 'pec_exclusions').maybeSingle();
  state.pecEx = (exRow && exRow.value) || {};
  state.me = { ...profile, ...(staff || {}) };
  state.role = profile.role;
  state.rules = setting ? setting.value : {};
  state.regime = regimeOf(state.rules).active;
  $('authView').hidden = true; $('appView').hidden = false;
  const scopeLabel = state.role === 'dept_coordinator' ? (state.me.scope_profession ? `｜${state.me.scope_profession}職類` : state.me.scope_dept ? `｜${state.me.scope_dept}` : '') : '';
  $('whoText').textContent = `${state.me.emp_id}${state.me.name ? ' ' + state.me.name : ''}｜${ROLE_LABEL[state.role]}${scopeLabel}`;

  const views = [];
  if (state.role === 'cfd_staff') views.push(['calls', '來電紀錄'], ['dept', '名單查詢'], ['all', '全院總覽'], ['progress', '完成率']);   // 承辦人員：以接聽來電、查詢為主
  if (isAdmin()) views.push(['all', '全院總覽'], ['progress', '完成率'], ['expiry', '到期與提報'], ['dept', '名單查詢']);
  if (state.role === 'dept_coordinator') views.push(['dept', '科部總覽'], ['progress', '完成率'], ['expiry', '到期與提報']);
  views.push(['mine', '我的認證'], ['courses', '課程'], ['rules', '認證規範']);
  if (isAdmin()) views.push(['review', '審查'], ['calls', '來電紀錄']);
  // 課程辦理：最高管理者看全部；其他人只有在擔任某些課程的承辦人時才出現（資料列權限只回傳自己的課）
  let myCourses = 0;
  if (state.role !== 'super_admin') { try { const { count } = await sb.from('course_stats').select('id', { count: 'exact', head: true }); myCourses = count || 0; } catch (e) { /* 012 尚未執行 */ } }
  const showCs = state.role === 'super_admin' || myCourses > 0;
  if (isAdmin() || state.role === 'dept_coordinator') views.push(['plan', '訓練計畫'], ...(showCs ? [['coursestats', '課程辦理']] : []), ['roster', '追蹤名單'], ['ratio', '師生比']);
  else if (state.role === 'cfd_staff') views.push(...(showCs ? [['coursestats', '課程辦理']] : []), ['ratio', '師生比']);
  else if (showCs) views.push(['coursestats', '課程辦理']);
  if (isAdmin()) views.push(['logs', '使用紀錄']);
  if (state.role === 'super_admin') views.push(['admin', '管理']);
  // 護理部認證概況（取代 Power BI）：師培中心人員、護理職類管理人與護理部單位主管；護理主管放在第一個
  if (canNursing()) { if (isCfd()) views.splice(views.findIndex(v => v[0] === 'all') + 1, 0, ['nursing', '護理部概況']); else views.unshift(['nursing', '護理部概況']); }
  logView('login');
  setFab(isCfd() ? null : 'login');   // 師培中心人員是處理反映的人，不顯示
  $('nav').innerHTML = views.map(([v, t]) => `<button type="button" data-view="${v}">${t}</button>`).join('');
  if ($('empSearch')) $('empSearch').hidden = !(isCfd() || state.role === 'dept_coordinator');
  $('nav').querySelectorAll('button').forEach(b => { b.onclick = () => go(b.dataset.view); });

  // 掃描簽到 QR 進來的連結：登入後直接完成簽到
  const params = new URLSearchParams(location.search);
  if (params.get('checkin') && params.get('t')) {
    history.replaceState(null, '', location.pathname);
    const d = await act('course.checkin', { course_id: params.get('checkin'), token: params.get('t') });
    if (d) toast(`${d.message}｜${d.course.title}（${d.course.hours} 點）`);
    return go('mine');
  }
  // 專用連結：…/#nursing 登入後直接開護理部概況
  if (location.hash === '#nursing' && canNursing()) return go('nursing');
  go(views[0][0]);
}
const canNursing = () => isCfd() || (state.role === 'dept_coordinator' &&
  (state.me.scope_profession === '護理' || state.me.profession === '護理' || String(state.me.scope_dept || state.me.dept || '').startsWith('護理部')));   // 護理長、護理主管（含兒童醫院、分院等護理單位）

function go(view, arg) {
  clearInterval(state.qrTimer);
  if (view === 'person' && state.view !== 'person') state.backTo = state.view;
  state.view = view;
  $('nav').querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('content').innerHTML = '<div class="card empty">載入中…</div>';
  const run = { mine: () => renderPerson(state.me.emp_id), person: () => renderPerson(arg, true), dept: renderList, all: renderOverview, progress: renderProgress, nursing: renderNursing,
    courses: renderCourses, rules: renderRules, ratio: renderRatio, coursestats: renderCourseStats, calls: renderCalls, logs: renderLogs, plan: () => { state.planId = arg || null; return renderPlanPage(); }, review: renderReview, roster: renderRoster, admin: renderAdmin, expiry: renderExpiry }[view];
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

// 新制基礎必修：至少 N 項（不是四項全修）
const basicItemsGap = x => `基礎課程還需 ${x.gapBasicItemsCount} 項${(x.missingBasicItems || []).length ? `（可從尚未修過的${x.missingBasicItems.join('、')}中選）` : ''}`;

// 醫事職類新制「四宮格」：對照認證時數標準表（初次認證／展延 × 基礎／進階），本人適用的一欄顯示進度，另一欄淡化只列規則
function newGrid(dn, o = {}) {
  if (!dn || !(dn.trackType === 'initial' || dn.trackType === 'renewal')) return '';
  const ini = dn.trackType === 'initial';
  const eq = dn.itemsEquipped || {};
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const bar = (have, need) => `<div class="g-bar"><i style="width:${need ? Math.min(100, have / need * 100) : 100}%" class="${have >= need ? 'ok' : ''}"></i></div>`;
  const chips = list => `<div class="g-chips">${list.map(i => `<span class="g-chip ${n(eq[i]?.hours) > 0 ? 'on' : ''}">${esc(i)}<b>${n(eq[i]?.hours)}</b></span>`).join('')}</div>`;
  const tag = must => `<span class="g-tag ${must ? 'must' : ''}">${must ? '必修' : '選修'}</span>`;
  const check = ok => `<span class="g-ok ${ok ? 'yes' : ''}">${ok ? '✓ 已達' : '未達'}</span>`;
  const yr = Number(String(dn.asOf || today()).slice(0, 4)) - 1911;
  const needItems = dn.requiredBasicItemsCount || 2, needBasic = dn.requiredBasicHours || 4;
  const needAdv = dn.requiredAdvancedHours || 2, needYear = dn.requiredTotalHours || 4;

  const head = (on, title, rule, prog) => `<div class="g-head ${on ? 'on' : 'off'}"><b>${title}</b><span>${rule}</span>${prog || ''}</div>`;
  const cell = (on, row, must, rule, body) => `<div class="g-cell ${on ? 'on' : 'off'}"><div class="g-row">${row}${tag(must)}</div><p class="g-rule">${rule}</p>${on ? body : ''}</div>`;

  const iniHead = head(ini, '初次認證教師', '二年十小時（或十點）', ini ? `<div class="g-prog"><b class="num">${n(dn.teachingHours)} / ${dn.requiredTotalHours || 10}</b> 小時 ${check(dn.teachingHours >= (dn.requiredTotalHours || 10))}${bar(dn.teachingHours, dn.requiredTotalHours || 10)}<small>${esc(dn.window?.label || '')}</small></div>` : '<small class="g-na">取得認證前適用</small>');
  const renHead = head(!ini, '展延認證教師', '每年四小時（或四點）', !ini ? `<div class="g-prog"><b class="num">${n(dn.teachingHours)} / ${needYear}</b> 小時 ${check(dn.teachingHours >= needYear)}${bar(dn.teachingHours, needYear)}<small>${yr} 年度</small></div>` : '<small class="g-na">取得認證後每年適用</small>');

  const iniBasic = cell(ini, '基礎課程', true, '至少（含）二項課程項目，共計至少四小時',
    `<div class="g-nums"><span>項目 <b class="num">${dn.basicItemsCount || 0} / ${needItems}</b> 項</span><span>時數 <b class="num">${n(dn.basicHours)} / ${needBasic}</b> 小時</span>
      ${check((dn.basicItemsCount || 0) >= needItems && dn.basicHours >= needBasic)}</div>${bar(dn.basicHours, needBasic)}${chips(BASIC)}`);
  const iniAdv = cell(ini, '進階課程', false, '可任選，時數計入二年十小時',
    `<div class="g-nums"><span>已修 <b class="num">${n(dn.advancedHours)}</b> 小時</span></div>${chips(ADVANCED)}`);
  const renBasic = cell(!ini, '基礎課程', false, '可任選，時數計入每年四小時',
    `<div class="g-nums"><span>今年已修 <b class="num">${n(dn.basicHours)}</b> 小時</span></div>${chips(BASIC)}`);
  const renAdv = cell(!ini, '進階課程', true, '每年至少二小時（或二點）',
    `<div class="g-nums"><span>今年 <b class="num">${n(dn.advancedHours)} / ${needAdv}</b> 小時</span>${check(dn.advancedHours >= needAdv)}</div>${bar(dn.advancedHours, needAdv)}${chips(ADVANCED)}`);

  const s = dn.suspension;
  const susp = s && s.active ? `<div class="g-susp"><b>${s.debtTotal > 0 || s.debtAdv > 0 ? '教師資格暫停中' : `已補滿，${esc(s.restoredOn)} 起恢復`}</b>
      ${s.debtTotal > 0 || s.debtAdv > 0 ? `${esc(s.years.join('、'))} 年度未完成，自 ${esc(s.from)} 起暫停。請先補滿 ${n(Math.max(s.debtTotal, s.debtAdv))} 點${s.debtAdv > 0 ? `（其中進階 ${n(s.debtAdv)} 點）` : ''}，補滿當月的次月 1 日恢復；效期不變，補足用掉的時數不計入今年。` : '補足的時數已用於前一年度，下列為今年度進度。'}</div>` : '';
  const uncls = dn.unclassifiedHours > 0 ?`<div class="note">另有 ${n(dn.unclassifiedHours)} 小時教學能力提升課程尚未歸類到基礎或進階項目：會計入總時數，但不計入基礎／進階。如有疑問請洽師培中心。</div>` : '';
  return `<section class="card grid4-card ${o.big ? 'big' : ''}"><h3>${esc(o.title || '新制認證進度')}</h3>
    <p class="hint">依「教學能力提升（基礎／進階）課程分類與認證時數標準」。${ini ? '您目前適用左欄「初次認證教師」。' : '您目前適用右欄「展延認證教師」。'}</p>
    ${susp}<div class="grid4">${iniHead}${renHead}${iniBasic}${renBasic}${iniAdv}${renAdv}</div>${uncls}</section>`;
}

// ---------- 個人頁的資訊區塊：臨床教師／主治醫師年度考核（CFD 構面）／核心教師／教職／師培講師／修課紀錄（顏色區分） ----------
const BLK = {
  teacher: '臨床教師', cfd: '主治醫師年度考核｜CFD 構面', core: '核心教師', faculty: '教職', lecturer: '師培講師', pref: '學習偏好軌跡', records: '修課紀錄'
};
const block = (kind, inner, sub) => !inner ? '' : `<section class="blk blk-${kind}" id="blk-${kind}">
  <div class="blk-h"><span class="blk-dot" aria-hidden="true"></span><b>${BLK[kind]}</b>${sub ? `<small>${sub}</small>` : ''}</div>
  <div class="blk-b">${inner}</div></section>`;

// 頁首的角色摘要列：每個區塊一個色塊，點一下捲到該區塊
function roleBar(d) {
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const chips = [];
  const short = String(d.status || '').replace(/^[^\p{L}\p{N}]+/u, '');
  if (d.trackType !== 'exempt') chips.push(['teacher', short]);
  if (d.appraisal) chips.push(['cfd', `${n(d.appraisal.score)} 分`]);
  const core = d.coreCourses || [];
  chips.push(['core', core.length ? `${core.length} 門｜${n(core.reduce((a, c) => a + c.hours, 0))} 小時` : '尚無']);
  if (d.facultyCheck) chips.push(['faculty', d.facultyCheck.met ? '符合申請條件' : '尚未符合']);
  if (d.lecturer) chips.push(['lecturer', d.lecturer.byOrg
    ? `教學部 ${n(d.lecturer.byOrg.cfd.hours)}｜科部 ${n(d.lecturer.byOrg.dept.hours)} 小時`
    : `${n(d.lecturer.totalHours)} 小時｜${d.lecturer.count} 個單元`]);
  return `<nav class="role-bar" aria-label="資訊區塊">${chips.map(([k, v]) => `<button type="button" class="role-chip rc-${k}" onclick="document.getElementById('blk-${k}').scrollIntoView({behavior:'smooth'})">
    <span>${BLK[k].split('｜')[0]}</span><b>${esc(v)}</b></button>`).join('')}</nav>`;
}

// 核心教師：師培中心核心教師認證課程（SDM、EPA、ACGME 臨床教練、精準醫學教育…）
function coreCard(d) {
  const list = d.coreCourses || [];
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  if (!list.length) return `<section class="card"><p class="hint" style="margin:0">尚無核心教師認證課程紀錄。師培中心授予的核心教師認證課程包括：SDM 醫病共享決策、EPA 可信賴專業活動、ACGME 臨床教練、精準醫學教育等。</p></section>`;
  const byItem = {};
  list.forEach(c => (c.item || '核心教師認證課程').split('、').forEach(i => { byItem[i] = n((byItem[i] || 0) + c.hours); }));
  return `<section class="card"><div class="core-sum">${Object.entries(byItem).map(([i, h]) => `<span class="core-badge"><b>${esc(i)}</b>${h} 小時</span>`).join('')}</div>
    <ul class="lk-list">${list.map(c => `<li><span class="lk-date">${esc(String(c.date).slice(0, 10).replace(/-/g, '/'))}</span><span class="lk-title">${esc(c.title)}<small>${esc(c.item)}</small></span><span class="lk-h">${n(c.hours)}</span></li>`).join('')}</ul></section>`;
}

// 師培講師：擔任教學能力提升課程講師的紀錄（依年度收合，點開看日期、課程名稱、單元、時數）
function lecturerCard(d) {
  const L = d.lecturer;
  if (!L) return '';
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const years = Object.keys(L.byYear || {}).sort().reverse();
  // 依開課單位分「教學部辦」（含 OSCE 中心）與「科部辦」；舊資料沒有 by 欄位時歸教學部
  const isCfd = c => (c.by || 'cfd') === 'cfd';
  const sumOf = list => n(list.reduce((a, c) => a + c.hours, 0));
  const all = L.courses || [];
  const cfd = all.filter(isCfd), dept = all.filter(c => !isCfd(c));
  const tag = c => isCfd(c) ? '<span class="org-tag cfd">教學部辦</span>' : `<span class="org-tag dept" title="開課單位">${esc(c.org || '科部辦')}</span>`;
  return `<section class="card">
    <div class="lect-sum lect-org">
      <div class="cfd"><span>教學部辦</span><b class="num">${sumOf(cfd)}</b><small>小時・${cfd.length} 個單元</small></div>
      <div class="dept"><span>科部辦</span><b class="num">${sumOf(dept)}</b><small>小時・${dept.length} 個單元</small></div>
      <div><span>合計</span><b class="num">${n(L.totalHours)}</b><small>小時・${years.length} 個年度</small></div></div>
    ${years.map((y, i) => {
      const list = all.filter(c => c.date.startsWith(y));
      const yc = list.filter(isCfd), yd = list.filter(c => !isCfd(c));
      return `<details class="lk-year" ${i === 0 ? 'open' : ''}><summary><span class="lk-yr">${Number(y) - 1911} 年</span>
        <span class="lk-chips"><span class="lk-chip t">教學部辦 <b>${sumOf(yc)}</b> 小時</span><span class="lk-chip dept">科部辦 <b>${sumOf(yd)}</b> 小時</span><span class="lk-chip">${list.length} 個單元</span></span></summary>
        <ul class="lk-list">${list.map(c => `<li><span class="lk-date">${Number(c.date.slice(5, 7))}/${Number(c.date.slice(8, 10))}</span>
          <span class="lk-title">${tag(c)} ${esc(c.title)}${c.unit && c.unit !== c.title ? `<small>${esc(c.unit)}</small>` : ''}${c.co > 1 ? `<small>共同授課（${c.co} 位講師）</small>` : ''}</span><span class="lk-h">${n(c.hours)}</span></li>`).join('')}</ul></details>`;
    }).join('')}
    <div class="note">資料來源：教學系統「教學能力提升」課程的講師欄位，依姓名比對本院名冊歸戶；同名者無法確定是誰，未列入。共同授課的單元，每位講師都列全部時數。
      依「開課單位」區分：教學部（含 OSCE 中心）開課為「教學部辦」，其他科部或單位開課為「科部辦」。</div></section>`;
}

// ---------- 他院轉任：上傳原醫院的臨床教師認證證書，師培中心查證後以展延教師列管 ----------
// 證書存於不公開的儲存區（只有本人與管理者可存取），審查後自動刪除
function transferCard(d, empId, apps, canUpload) {
  if (!(d.trackType === 'initial' || d.trackType === 'renewal')) return '';
  const pend = (apps || []).find(a => a.app_type === '他院轉任採認' && a.status === '審核中');
  if (d.transferredFrom) return `<section class="card transfer-ok"><b>已採認他院認證</b>：${esc(d.transferredFrom)}。依規定視為展延教師${d.activeCertificate ? '，採認原效期' : ''}。</section>`;
  if (pend) return `<section class="card"><b>他院轉任採認：審核中</b><br><small>${esc(pend.ext_org || '')}｜原效期 ${esc(pend.ext_valid_start || '')}～${esc(pend.ext_valid_end || '')}。師培中心查證證書後會更新您的認證狀態。</small></section>`;
  if (!canUpload) return '';
  return `<details class="card transfer"><summary><b>由其他教學醫院轉任？</b>上傳原認證證書，申請採認</summary>
    <ul class="recs"><li>於其他教學醫院取得臨床教師認證後轉任本院者，<b>視為展延教師</b>。</li>
      <li>原認證效期<b>仍有效</b>：查證後採認原效期，之後依展延規定辦理。</li>
      <li>原認證效期<b>已屆滿</b>：查證後依展延的時數規定認證，不必依初次認證完成 10 點。</li></ul>
    <form id="trfForm" class="inline-form">
      <label>原認證醫院<input id="trfOrg" required placeholder="例如：○○醫院"></label>
      <label>原證書字號（選填）<input id="trfNo"></label>
      <label>原效期起日<input id="trfStart" type="date" required></label>
      <label>原效期迄日<input id="trfEnd" type="date" required></label>
      <label>原認證證書（PDF、JPG 或 PNG，10 MB 以內）<input id="trfFile" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required></label>
      <label>備註（選填）<input id="trfMemo"></label>
      <button class="btn btn-primary" type="submit" style="width:auto">上傳並送出查證</button>
      <p class="hint">證書只有您本人與師培中心看得到，查證完成後系統會自動刪除檔案。</p>
    </form></details>`;
}
async function submitTransfer(empId, after) {
  const f = $('trfFile').files[0];
  if (!f) return toast('請選擇證書檔案', false);
  if (f.size > 10 * 1024 * 1024) return toast('檔案超過 10 MB', false);
  const ext = (f.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z]/g, '');
  const path = `${empId.toLowerCase()}/${Date.now()}.${ext}`;
  const btn = $('trfForm').querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = '上傳中…';
  const up = await sb.storage.from('cert-uploads').upload(path, f, { contentType: f.type || undefined, upsert: false });
  if (up.error) { btn.disabled = false; btn.textContent = '上傳並送出查證'; return toast('上傳失敗：' + up.error.message, false); }
  const d = await act('cert.transferApply', { emp_id: empId, ext_org: $('trfOrg').value, ext_cert_no: $('trfNo').value, ext_valid_start: $('trfStart').value, ext_valid_end: $('trfEnd').value, attachment_path: path, memo: $('trfMemo').value }, after);
  if (!d) { await sb.storage.from('cert-uploads').remove([path]); btn.disabled = false; btn.textContent = '上傳並送出查證'; }
}
// 管理者查看證書：產生 5 分鐘有效的臨時連結
async function viewCert(path) {
  const { data, error } = await sb.storage.from('cert-uploads').createSignedUrl(path, 300);
  if (error) return toast('無法開啟證書：' + error.message, false);
  window.open(data.signedUrl, '_blank', 'noopener');
}

// 主治醫師申請教職新聘／升等的時數檢核（申請前三年內教學能力提升、前一年度師培總點數）
function facultyCard(d, o = {}) {
  const f = d.facultyCheck;
  if (!f) return '';
  return `<section class="card req-card ${o.big ? 'big' : ''}"><h3>申請教職新聘／升等的時數檢核</h3>
    <p class="hint">若今年要申請教職新聘或升等，需同時符合下列兩項（以今天為申請日試算）。</p>
    <ul class="req-list">${f.items.map(q => `<li class="${q.met ? 'met' : ''}"><div class="req-top"><span class="req-mark">${q.met ? '✓' : '○'}</span><span class="req-label">${esc(q.label)}</span>
      <span class="req-num num">${q.have} / ${q.need} ${esc(q.unit)}</span></div>
      <div class="bar"><i style="width:${Math.min(100, q.have / q.need * 100)}%"></i></div>
      <small>${q.met ? '已符合' : `還差 ${Math.round((q.need - q.have) * 10) / 10} ${esc(q.unit)}`}${q.note ? `｜${esc(q.note)}` : ''}</small></li>`).join('')}</ul>
    ${tutorList(d.tutor)}
    <div class="note">${f.met ? '目前已符合申請教職的條件。' : '尚未符合；請在送件前補足。'}三年內的時數以今天往回 ${f.windowMonths} 個月計算。</div></section>`;
}
// 教職 tutor 授課紀錄：已認證（教職3年16小時）／待師培中心認證
function tutorList(t) {
  if (!t || !(t.sessions || []).length) return '';
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  return `<details class="tutor-list"><summary>三年內 tutor 授課紀錄（${t.sessions.length} 場：已認證 ${n(t.certHours)} 小時、待認證 ${n(t.uncertHours)} 小時）</summary>
    <ul class="lk-list">${t.sessions.map(s => `<li><span class="lk-date">${esc(s.d.replace(/-/g, '/'))}</span>
      <span class="lk-title">${s.cert ? '<span class="org-tag cfd">已認證</span>' : '<span class="org-tag dept">待認證</span>'} ${esc(s.t)}<small>${esc(s.cat)}</small></span><span class="lk-h">${n(s.h)}</span></li>`).join('')}</ul>
    ${t.uncertHours > 0 ? '<p class="hint">「待認證」是課程名稱或類別符合 PBL、OSCE、case study、臨床技能等，但尚未登錄為「教職3年16小時」的授課；已先計入，師培中心會陸續完成認證。</p>' : ''}</details>`;
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
    <h3>${a.roc} 年度考核分數（CFD 構面）</h3>
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

// ---------- 認證旅程：效期時間軸（人像站在今天）＋點數小路（人像走到目前點數，旗子是目標） ----------
const WALKER = `<svg class="walker" viewBox="0 0 32 48" aria-hidden="true"><circle cx="16" cy="7" r="6" fill="currentColor"/>
  <path d="M16 14 L16 30 M16 18 L7 25 M16 18 L25 23 M16 30 L9 45 M16 30 L23 45" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" fill="none"/></svg>`;
const FLAG = '<svg class="flag" viewBox="0 0 24 36" aria-hidden="true"><path d="M4 2 V34" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M5 3 H21 L17 9 L21 15 H5 Z" fill="#FFCB0D" stroke="currentColor" stroke-width="1.5"/></svg>';
function journeyCard(d) {
  if (!d || d.trackType === 'exempt') return '';
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const roc = s => `${Number(s.slice(0, 4)) - 1911}/${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const day = s => new Date(`${s}T00:00:00`).getTime();
  const now = today();
  const certTrack = d.trackType === 'initial' || d.trackType === 'renewal';
  const cert = d.activeCertificate, last = d.lastCertificate;
  // 時間軸的起訖：有效證書＝效期；剛屆滿（保留期）＝上一張效期延到今天；醫師等每年規範＝今年 1/1–12/31
  let start, end, title, after = false;
  if (cert && cert.valid_start && cert.valid_end) { start = cert.valid_start; end = cert.valid_end; title = '認證效期時間軸'; }
  else if (certTrack && last && last.valid_start && last.valid_end) { start = last.valid_start; end = last.valid_end; title = '上一張認證的效期'; after = now > end; }
  else if (!certTrack) { const y = now.slice(0, 4); start = `${y}-01-01`; end = `${y}-12-31`; title = `${Number(y) - 1911} 年度時間軸`; }
  let timeline = '';
  if (start) {
    const span = Math.max(1, day(end) - day(start));
    const pos = s => Math.max(0, Math.min(100, (day(s) - day(start)) / span * 100));
    const me = after ? 100 : pos(now);
    const left = Math.round((day(end) - day(now)) / 864e5);
    const months = Math.floor(left / 30.4);
    // 年度分段：新制每年要完成的時數，依逐年結果上色
    const ys = Number(start.slice(0, 4)), ye = Number(end.slice(0, 4));
    const yearly = new Map((d.yearly || []).map(y => [Number(y.roc) + 1911, y]));
    const segs = [];
    for (let y = ys; y <= ye; y++) {
      const a = pos(y === ys ? start : `${y}-01-01`), b = pos(y === ye ? end : `${y}-12-31`);
      if (b - a < 0.5) continue;
      const st = (yearly.get(y) || {}).state || (String(y) < now.slice(0, 4) ? '' : String(y) === now.slice(0, 4) ? 'in_progress' : 'future');
      segs.push(`<div class="tl-seg s-${esc(st)}" style="left:${a}%;width:${b - a}%" title="${y - 1911} 年${STATE_LABEL[st] ? '｜' + STATE_LABEL[st] : ''}"><span>${y - 1911}</span></div>`);
    }
    const near = !after && left >= 0 && left <= 183;
    const caption = after ? `已於 ${roc(end)} 屆滿` : left < 0 ? '已屆滿' : certTrack ? `距到期還有 <b>${months >= 1 ? `${months} 個月` : `${left} 天`}</b>` : `今年度還剩 <b>${left} 天</b>`;
    const extLine = cert && cert.extended_from ? `<p class="tl-ext">原效期至 ${esc(cert.extended_from_roc)}，依過渡規定<b>延至 ${roc(end)}</b>（效期總長不超過四年），年底統一辦理展延。</p>` : '';
    timeline = `<div class="tl" role="img" aria-label="${esc(title)}：${roc(start)} 至 ${roc(end)}，今天 ${roc(now)}">
        <div class="tl-track">${segs.join('')}</div>
        <div class="tl-me ${near || after ? 'warn' : ''}" style="left:${me}%">${WALKER}<small>今天</small></div>
        <div class="tl-end" style="left:100%">${FLAG}</div></div>
      <div class="tl-ends"><span>${roc(start)}<small>${certTrack ? '效期起' : '1 月 1 日'}</small></span><span class="tl-cap ${near || after ? 'warn' : ''}">${caption}</span><span>${roc(end)}<small>${certTrack ? '效期迄' : '12 月 31 日'}</small></span></div>
      ${segs.length > 1 ? `<div class="legend tl-legend"><span><i class="s-met"></i>已達標</span><span><i class="s-in_progress"></i>今年進行中</span><span><i class="s-missed"></i>未達標</span><span><i class="s-counsel"></i>輔導年未達標</span><span><i class="s-future"></i>尚未開始</span></div>` : ''}${extLine}`;
  }
  // 點數小路：人像依目前點數前進，旗子是本次要達到的點數
  const have = Number(certTrack ? d.teachingHours : d.totalHours) || 0, need = Number(d.requiredTotalHours) || 0;
  let path = '';
  if (need) {
    const p = Math.min(100, have / need * 100), arrived = have >= need;
    const stones = Array.from({ length: Math.min(12, Math.ceil(need)) + 1 }, (_, i) => {
      const v = need * i / Math.min(12, Math.ceil(need));
      return `<span class="pw-stone ${have >= v ? 'on' : ''}" style="left:${i / Math.min(12, Math.ceil(need)) * 100}%"></span>`;
    }).join('');
    path = `<div class="pw ${arrived ? 'arrived' : ''}" role="img" aria-label="點數 ${n(have)} / ${n(need)}">
        <div class="pw-road"><i style="width:${p}%"></i>${stones}</div>
        <div class="pw-me" style="left:${arrived ? 94 : p}%">${WALKER}<small>${arrived ? '抵達！' : `${n(have)} 點`}</small></div>
        <div class="pw-goal">${FLAG}<small>${n(need)} 點</small></div></div>
      <p class="pw-cap">${arrived ? '<b>已抵達終點！</b>本次應完成的點數已達標。' : `已走了 <b>${Math.round(p)}%</b>，離終點還有 <b>${n(need - have)} 點</b>。`}<small>${esc(certTrack ? '教學能力提升點數' : '年度師培點數')}・${esc(d.window?.label || '')}</small></p>`;
  }
  if (!timeline && !path) return '';
  return `<section class="card journey"><h3>我的認證旅程</h3>
    ${timeline ? `<div class="group-label">${esc(title)}</div>${timeline}` : ''}
    ${path ? `<div class="group-label">${certTrack ? '點數進度' : '今年度點數進度'}</div>${path}` : ''}</section>`;
}

// ---------- 學習偏好軌跡：從修課紀錄看偏好哪些教學能力項目、各年度的變化、常在幾月修課 ----------
function prefCard(records) {
  const recs = records || [];
  if (recs.length < 2) return '';
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const itemOf = x => {
    const s = `${x.category || ''} ${x.course_title || ''}`;
    return BASIC.find(b => s.includes(b)) || ADVANCED.find(a => s.includes(a)) || null;
  };
  const teach = recs.filter(x => Number(x.teaching_hours) > 0), gen = recs.filter(x => !(Number(x.teaching_hours) > 0) && Number(x.general_hours) > 0);
  // 九大項目累計時數
  const byItem = {}; let other = 0;
  teach.forEach(x => { const i = itemOf(x); if (i) byItem[i] = (byItem[i] || 0) + Number(x.teaching_hours); else other += Number(x.teaching_hours); });
  const items = [...BASIC, ...ADVANCED].map(i => [i, n(byItem[i] || 0)]);
  const maxI = Math.max(1, ...items.map(x => x[1]));
  const ranked = items.filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const totT = n(teach.reduce((a, x) => a + Number(x.teaching_hours), 0));
  const totB = n(BASIC.reduce((a, i) => a + (byItem[i] || 0), 0)), totA = n(ADVANCED.reduce((a, i) => a + (byItem[i] || 0), 0));
  const untouched = items.filter(x => !x[1]).map(x => x[0]);
  // 一般醫學／院內課程：依課程類別
  const byCat = {}; gen.forEach(x => { const c = (x.category || '其他').split(/[\/／]/)[0].trim() || '其他'; byCat[c] = (byCat[c] || 0) + Number(x.general_hours); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxC = Math.max(1, ...cats.map(c => c[1]));
  // 各年度軌跡：基礎／進階／其他教學／一般 堆疊，加上當年最常修的項目
  const years = [...new Set(recs.map(x => x.course_date.slice(0, 4)))].sort().slice(-6);
  const yrRows = years.map(y => {
    const t = teach.filter(x => x.course_date.startsWith(y)), g = gen.filter(x => x.course_date.startsWith(y));
    const sum = (list, f) => n(list.reduce((a, x) => a + Number(x[f]), 0));
    const b = sum(t.filter(x => BASIC.includes(itemOf(x))), 'teaching_hours'), a = sum(t.filter(x => ADVANCED.includes(itemOf(x))), 'teaching_hours');
    const o = n(sum(t, 'teaching_hours') - b - a), gg = sum(g, 'general_hours');
    const top = {}; t.forEach(x => { const i = itemOf(x); if (i) top[i] = (top[i] || 0) + Number(x.teaching_hours); });
    const best = Object.entries(top).sort((p, q) => q[1] - p[1])[0];
    return { y, b, a, o, g: gg, tot: n(b + a + o + gg), best: best ? best[0] : '' };
  });
  const maxY = Math.max(1, ...yrRows.map(r => r.tot));
  const trail = yrRows.filter(r => r.best).map(r => `<span class="pf-step"><small>${Number(r.y) - 1911}</small>${esc(r.best)}</span>`).join('<span class="pf-arrow">→</span>');
  // 月份分佈
  const mon = Array(12).fill(0); recs.forEach(x => { mon[Number(x.course_date.slice(5, 7)) - 1]++; });
  const maxM = Math.max(1, ...mon);
  const peak = mon.map((v, i) => [i + 1, v]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => `${x[0]} 月`);
  // 解讀與建議
  const tips = [];
  if (ranked.length) tips.push(`最常修的是「${ranked[0][0]}」，占教學能力提升的 ${Math.round(ranked[0][1] / Math.max(1, totT) * 100)}%。`);
  if (totB + totA > 0) tips.push(totA === 0 ? '目前只修過基礎課程；新制展延每年需要進階課程 2 小時，可以開始安排進階課。'
    : totB === 0 ? '目前只修過進階課程；初次認證需要基礎課程至少 2 項、4 小時。'
    : `基礎與進階的比例約 ${Math.round(totB / (totB + totA) * 100)} : ${Math.round(totA / (totB + totA) * 100)}。`);
  if (untouched.length && untouched.length < 9) tips.push(`還沒修過：${untouched.join('、')}。可以挑一兩項拓展教學能力。`);
  if (peak.length) tips.push(`多半在 ${peak.join('、')}修課。`);
  return `<section class="card pref">
    <div class="pf-grid">
      <div><div class="group-label">九大教學能力項目（累計時數）</div>
        ${items.map(([i, h]) => `<div class="pf-bar ${h ? '' : 'zero'} ${ranked[0] && ranked[0][0] === i ? 'top' : ''}"><span class="pf-l">${BASIC.includes(i) ? '<em class="b">基</em>' : '<em class="a">進</em>'}${esc(i)}</span>
          <div class="pf-t"><i style="width:${h / maxI * 100}%"></i></div><span class="num">${h || '—'}</span></div>`).join('')}
        ${other > 0 ? `<p class="hint">另有 ${n(other)} 小時教學能力提升課程未標示項目。</p>` : ''}</div>
      <div><div class="group-label">一般醫學／院內課程（前 ${cats.length} 類）</div>
        ${cats.length ? cats.map(([c, h]) => `<div class="pf-bar g"><span class="pf-l">${esc(c)}</span><div class="pf-t"><i style="width:${h / maxC * 100}%"></i></div><span class="num">${n(h)}</span></div>`).join('') : '<p class="hint">沒有一般課程紀錄。</p>'}
        <div class="group-label" style="margin-top:14px">常在幾月修課</div>
        <div class="pf-months">${mon.map((v, i) => `<span style="--a:${v / maxM}" title="${i + 1} 月：${v} 門"><b>${i + 1}</b></span>`).join('')}</div></div>
    </div>
    <div class="group-label">各年度軌跡</div>
    <div class="pf-years">${yrRows.map(r => `<div class="pf-yr"><span class="pf-yl">${Number(r.y) - 1911} 年</span>
      <div class="pf-stack" style="width:${Math.max(4, r.tot / maxY * 100)}%">${[['b', r.b, '基礎'], ['a', r.a, '進階'], ['o', r.o, '其他教學'], ['g', r.g, '一般']].map(([k, v, t]) => v > 0 ? `<i class="k-${k}" style="flex:${v}" title="${t} ${v} 點"></i>` : '').join('')}</div>
      <span class="num">${r.tot}</span></div>`).join('')}</div>
    <div class="legend"><span><i class="k-b"></i>基礎</span><span><i class="k-a"></i>進階</span><span><i class="k-o"></i>其他教學能力提升</span><span><i class="k-g"></i>一般醫學／院內</span></div>
    ${trail ? `<div class="pf-trail"><span class="group-label" style="margin:0">偏好變化</span>${trail}</div>` : ''}
    ${tips.length ? `<ul class="pf-tips">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

async function renderPerson(empId, back) {
  const own = empId === state.me.emp_id;
  const [{ data: row, error }, { data: staff }, { data: records }, { data: apps }, { data: upcoming }, { data: myRegs }] = await Promise.all([
    sb.from('cert_status').select('*').eq('emp_id', empId).maybeSingle(),
    sb.from('staff').select('*').eq('emp_id', empId).maybeSingle(),
    sb.from('course_records').select('course_title,course_date,category,teaching_hours,general_hours').eq('emp_id', empId).order('course_date', { ascending: false }).limit(500),
    sb.from('applications').select('*').eq('emp_id', empId).order('submitted_at', { ascending: false }).limit(10),
    sb.from('courses').select('id,title,course_date,start_time,hours,main_category,sub_categories,location_detail').gte('course_date', today()).order('course_date').limit(20),
    own ? sb.from('registrations').select('course_id').eq('emp_id', empId) : Promise.resolve({ data: [] })
  ]);
  if (error) throw error;
  if (!row) { $('content').innerHTML = '<div class="card empty">尚無此人員的認證資料。</div>'; return; }
  if (staff && staff.name) rememberNames([{ emp_id: empId, name: staff.name }]);
  logView('person', empId);
  $('asOf').textContent = fmtTime(row.computed_at);
  $('content').innerHTML = personHTML({ empId, back, own, row, staff, records, apps, upcoming, myRegs,
    regime: state.regime, role: state.role, admin: isAdmin(), canAct: own || isAdmin() || state.role === 'dept_coordinator' });
  if ($('applyForm')) $('applyForm').onsubmit = e => {
    e.preventDefault();
    act('cert.apply', { emp_id: empId, service_years: $('apYears').value, external_hours: $('apExt').value, memo: $('apMemo').value },
      () => { state.list = null; renderPerson(empId, back); });
  };
  if ($('trfForm')) $('trfForm').onsubmit = e => { e.preventDefault(); submitTransfer(empId, () => { state.list = null; renderPerson(empId, back); }); };
}

// 教學醫院年資採認（管理者）：人事資料離職再到職、留職停薪後只顯示最新到職日，系統算出的年資可能偏低
function seniorityForm(d, empId) {
  const s = d.senioritySource || {};
  const cur = s.override ? `目前採認 ${s.override} 年` : d.seniorityDeemed ? '曾認證，已視為符合' : `系統計算 ${s.computed ?? d.seniority} 年`;
  return `<details class="apply"><summary class="btn btn-ghost" style="width:auto">教學醫院年資（${esc(cur)}）</summary>
    <div class="inline-form">
      <p class="hint">系統依人事資料的執業登記起始日計算${s.from ? `（${esc(s.from.slice(0, 7).replace('-', '/'))} 起，${esc(s.computed ?? '')} 年）` : ''}。離職再到職或留職停薪者只顯示最新日期，年資可能偏低。
        <b>曾取得臨床教師認證者已自動視為符合，不必登錄。</b>查證後可在此登錄實際的教學醫院年資（可含他院），系統取較大者。</p>
      <label>教學醫院年資（年）<input id="senY" type="number" step="0.1" min="0" max="60" value="${esc(s.override || '')}"></label>
      <label>依據（例如：再到職前任職 101/3–106/8、○○醫院 2 年）<input id="senN" maxlength="100" value="${esc(s.note || '')}"></label>
      <button class="btn btn-primary" style="width:auto" type="button" onclick="setSeniority('${esc(empId)}', false)">採認並重新計算</button>
      ${s.override ? `<button class="btn btn-ghost" style="width:auto" type="button" onclick="setSeniority('${esc(empId)}', true)">取消採認</button>` : ''}
    </div></details>`;
}
function setSeniority(empId, remove, years, note) {
  act('admin.seniority', { emp_id: empId, years: remove ? null : (years ?? $('senY').value), note: remove ? '' : (note ?? $('senN').value), remove },
    () => { state.list = null; return state.view === 'review' ? renderReview() : renderPerson(empId, state.view === 'person'); });
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
      <div class="person-name">${esc(staff?.name || nameOf(empId) || empId)}<small>${esc(empId)}｜${esc(staff?.dept || '')}｜${esc(staff?.title || '')}</small></div>
      ${certTrack ? `<span class="tag ${d.regime === 'legacy' ? 'legacy' : ''}">目前適用：${esc(d.regimeLabel)}</span>` : ''}${d.transferredFrom ? ` <span class="tag transfer-tag">他院轉任：${esc(d.transferredFrom)}</span>` : ''}
      <div class="status">${esc(d.status)}</div>
      <div class="rule">${esc(d.trackLabel)}</div>
      <div class="rule">員工編號 ${o.lookup ? `${esc(empId)} <span class="nm">${esc(o.name || '')}</span>` : empLabel(empId)}｜${esc(staff?.dept || '')}｜${esc(staff?.title || '')}｜${esc(staff?.profession || '')}${cert ? `｜認證效期 ${esc(cert.valid_start_roc)}–${esc(cert.valid_end_roc)}${cert.extended_from ? `（原至 ${esc(cert.extended_from_roc)}，依過渡規定延至年底）` : ''}` : ''}</div>
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
      ${o.admin && certTrack ? seniorityForm(d, empId) : ''}
      ${o.admin && certTrack ? (pecEx(empId)
        ? `<button class="btn btn-ghost" type="button" onclick="togglePec('${esc(empId)}', true)">取消標記，恢復列入醫策會提報</button>`
        : `<details class="apply"><summary class="btn btn-ghost" style="width:auto">標記為醫策會不受理（不列入提報）</summary>
            <div class="inline-form"><label>原因<select id="pecReason"><option>執業登記不在本院</option><option>年資不符醫策會規定</option><option>醫策會退件（其他原因）</option></select></label>
            <button class="btn btn-primary" style="width:auto" type="button" onclick="togglePec('${esc(empId)}', false)">確認標記</button></div></details>`) : ''}
    </section>`;

  // 下一步：把「現在該做什麼」放在結論之後、細節之前
  const eligible = certTrack && (d.initialEligible || d.renewalCompliant);
  const gaps = [];
  if (d.gapBasicItemsCount > 0) gaps.push(basicItemsGap(d));
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
        ${p.gapBasicItemsCount > 0 ? `<li><b>${esc(basicItemsGap(p))}</b></li>` : ''}${p.gapTotal > 0 ? `<li>合計還差 <b>${p.gapTotal}</b> 點</li>` : ''}
        ${p.gapBasicHours > 0 ? `<li>基礎還差 <b>${p.gapBasicHours}</b> 點（${p.basicHours} / ${p.requiredBasicHours}）</li>` : ''}
        ${p.gapAdvancedHours > 0 ? `<li>進階還差 <b>${p.gapAdvancedHours}</b> 點（${p.advancedHours} / ${p.requiredAdvancedHours}）</li>` : ''}
      </ul>`}
    </section>`;

  const years = (d.yearly || []).length ? `
    <section class="card"><h3>逐年點數</h3><div class="years">
      ${d.yearly.map(y => `<div class="year ${esc(y.state)}"><b>${y.roc} 年</b> <small>${STATE_LABEL[y.state] || ''}${y.madeUpOn ? `，${esc(y.madeUpOn.slice(0, 7).replace('-', '/'))} 起恢復` : ''}</small><br>
        教學 <b class="num">${y.teach}</b>　基礎 <b class="num">${y.basic}</b>　進階 <b class="num">${y.adv}</b>${y.madeUpHours > 0 ? `<br><small>另 ${y.madeUpHours} 點用於補足前一年度</small>` : ''}</div>`).join('')}
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

  // 醫事職類：以新制四宮格取代「新制試算」與「九大項目」兩張卡（舊制期間顯示為新制試算）
  const dn = o.regime === 'new' ? d : row.detail_new;
  const grid = certTrack ? newGrid(dn, { title: o.regime === 'new' ? '新制認證進度' : `${(d.newRulePreview && d.newRulePreview.appliesFrom) || 116} 年起改採新制：進度試算` }) : '';
  // 結論 → 角色摘要 → 各資訊區塊（臨床教師／CFD 考核／核心教師／教職／師培講師／修課紀錄）
  // 一般同仁看自己的頁面：先給簡單版，完整內容收在「看詳細資料」；管理者、主管查看他人時直接看完整版
  const simple = own && !o.admin && o.role !== 'cfd_staff';
  const full = hero + roleBar(d)
    + block('teacher', d.trackType === 'exempt' ? '' : journeyCard(d) + meters + transferCard(d, empId, apps, (own || o.admin) && !o.lookup) + next + (grid || preview) + years + (grid ? '' : items))
    + block('cfd', appraisalCard(d))
    + block('core', coreCard(d))
    + block('faculty', facultyCard(d), '新聘／升等')
    + block('lecturer', lecturerCard(d), '擔任教學能力提升課程講師')
    + block('pref', prefCard(records), '依修課紀錄分析')
    + block('records', appList + recs);   // 結論 → 我的身分要完成什麼 → 下一步 → 細節
  const fb = own && !o.lookup && !o.admin ? feedbackCard('login') : '';
  if (!simple) return full + fb;
  return simpleView(d, { records, apps, regime: o.regime, name: staff?.name || '' }) + `<div class="lk-more" ${simpleMode() ? 'hidden' : ''}>${full}</div>` + fb;
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
      符合當年度時數規範者，即為當年度臨床教師。<b>醫師不分舊制、新制</b>，一律依上表每年完成。</div>
    ${ph.faculty_promotion ? `<h4 style="margin:16px 0 6px">主治醫師申請教職新聘／升等</h4>
      <ul class="recs"><li>申請前三年內完成「教學能力提升」至少 <b>${ph.faculty_promotion.prior_three_years_teaching_hours ?? 3}</b> 小時</li>
      <li>申請前一年度完成師培總點數至少 <b>${ph.faculty_promotion.prior_one_year_total_hours ?? 4}</b> 點</li>
      <li>申請前三年內擔任 <b>${ph.faculty_promotion.tutor_hours_3y ?? 16}</b> 小時以上教學課程（含 PBL、OSCE、case study 或 clinical skill）之 tutor（以講師授課記錄的「老師授課積分」計）</li></ul>` : ''}
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
        <dl><dt>初次認證</dt><dd>認證前 ${ini.timeframe_years || 2} 年內完成 ${ini.required_total_hours || 10} 點；基礎必修至少（含）${(ini.basic_courses || {}).min_items || 2} 項共 ${(ini.basic_courses || {}).required_total_hours || 4} 點，進階選修</dd>
          <dt>效期</dt><dd>${rc.validity_years || 4} 年（次年 1/1 起至第 ${rc.validity_years || 4} 年 12/31）</dd>
          <dt>展延</dt><dd>效期內每年 ${rc.annual_required_hours || 4} 點，其中進階必修至少 ${rc.annual_advanced_required_hours ?? 2} 點，基礎選修；不得跨年抵充</dd>
          <dt>未完成</dt><dd>${esc(rc.suspension_rule || '某年度未完成者，次年 1/1 起暫停教師資格；補滿當月的次月 1 日恢復，效期不變。')}</dd>
          <dt>提報</dt><dd>由科部主管統一提報，師培中心審查</dd></dl></div>
    </div>
    <h4 style="margin-top:14px">他院轉任教師</h4>
    <ul class="recs">
      <li>於其他教學醫院取得臨床教師認證後轉任本院者，<b>視為展延教師</b>，不必依初次認證規定重新完成 10 點。</li>
      <li>原認證效期<b>仍有效</b>者：檢附原認證證書，經師培中心查證後<b>採認原效期</b>，之後依展延規定辦理。</li>
      <li>原認證效期<b>已屆滿</b>者：檢附原認證證書，經查證後依展延的時數規定認證（舊制：申請前 2 年內 8 點；新制：當年度 4 點、其中進階 2 點）。</li>
      <li>申請方式：登入後在「我的認證」上傳證書；證書僅本人與師培中心可查看，查證完成後自動刪除。</li></ul>
    <h4 style="margin-top:14px">新制：教學能力提升課程分類與認證時數標準</h4>
    <div class="table-wrap"><table class="rules-t std-t"><thead><tr><th>類別</th><th>課程項目</th><th>初次認證教師<br><small>二年十小時（或十點）</small></th><th>展延認證教師<br><small>每年四小時（或四點）</small></th></tr></thead><tbody>
      <tr><td><b>基礎課程</b></td><td>${BASIC.join('<br>')}</td><td><b class="must">必修</b>；至少（含）二項課程項目，共計至少四小時（或四點）</td><td>選修</td></tr>
      <tr><td><b>進階課程</b></td><td>${ADVANCED.join('<br>')}</td><td>選修</td><td><b class="must">必修</b>；每年至少二小時（或二點）</td></tr>
    </tbody></table></div>
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

  // 新舊制轉換的過渡規定（使用者 2026-10-13 決定，rules.transition）
  const T = R.transition || {};
  const rocY = y => Number(y) - 1911;
  const trans = !T.new_rule_cert_start ? '' : `<section class="card"><h3>新舊制轉換的過渡規定（醫事人員）</h3>
    <ol class="recs">
      <li><b>效期一律到 12/31：</b>${(T.extend_to_year_end_years || []).map(rocY).join('、')} 年在年中到期的證書，效期延至到期當年 12/31（效期總長不超過四年，依醫策會作業程序「至多四年」），年底統一辦理展延，新證自次年 1/1 起四年。</li>
      <li><b>舊證照舊規定：</b>效期起日在 ${rocY(T.new_rule_cert_start.slice(0, 4))}/${Number(T.new_rule_cert_start.slice(5, 7))}/${Number(T.new_rule_cert_start.slice(8, 10))} 之前的證書，依原規定展延（效期屆滿前二年內 ${L.renewal_total ?? 8} 點），不追溯每年四小時；換發新證後才適用每年四小時。</li>
      <li><b>年中認證：</b>經科部每季提報者，自下一季的第一天（1/1、4/1、7/1、10/1）生效，效期至生效年度起算第四年度 12/31。效期不是從 1/1 開始的，生效當年度不另計年度時數。</li>
      ${(T.counseling_years || []).length ? `<li><b>輔導年（試行）：</b>${T.counseling_years.map(rocY).join('、')} 年未完成每年四小時者，只提醒、不暫停資格；之後的年度未完成，次年 1/1 起暫停資格，補滿後次月恢復。</li>` : ''}
    </ol>
    <div class="note">範例：效期原至 116/5/31 → 延至 116/12/31 → 116 年底展延 → 新證 117/1/1–120/12/31，117 年起每年四小時。</div></section>`;
  $('content').innerHTML = you + doctors + allied + trans + others + common;
}

// ---------- 師生比：衛福部臨床醫事人員培訓計畫每月核定人員（核定點數 5000＝PGY 學員、0＝臨床教師），至少 1:3 ----------
async function renderRatio() {
  const { data } = await sb.from('settings').select('value').eq('key', 'teacher_ratio').maybeSingle();
  const months = (data && data.value && data.value.months) || {};
  const keys = Object.keys(months).sort().reverse();
  if (!keys.length) { $('content').innerHTML = '<div class="card empty">尚無每月核定人員資料。師培中心執行 node tools/teacher-ratio.js 後會顯示。</div>'; return; }
  const label = key => `${Number(key.slice(0, 3))} 年 ${Number(key.slice(4))} 月`;
  const modeSeg = `<div class="seg">${[['one', '單月'], ['multi', '勾選多個月份分析']].map(([v, t]) => `<button type="button" class="${(state.ratioMode || 'one') === v ? 'is-active' : ''}" onclick="state.ratioMode='${v}';renderRatio()">${t}</button>`).join('')}</div>`;
  if (state.ratioMode === 'multi') return renderRatioMulti(months, keys, label, modeSeg);
  const k = keys.includes(state.ratioMonth) ? state.ratioMonth : keys[0];
  const M = months[k], R = M.ratioRequired || 3;
  const bad = M.rows.filter(r => !r.ok);
  const invalid = M.rows.reduce((a, r) => a + r.teachersInvalid, 0);
  const row = r => {
    const cap = r.teachersValid * R, use = cap ? Math.min(100, r.trainees / cap * 100) : (r.trainees ? 100 : 0);
    return `<tr class="${r.ok ? '' : 'bad'}">
      <td><b>${esc(r.prof)}</b></td>
      <td class="num">${r.teachers}${r.teachersInvalid ? ` <small class="warn">（${r.teachersInvalid} 位認證有問題）</small>` : ''}${r.teachersUnverified ? `<br><small class="muted" title="醫策會教師認證資料只列現職人員，已離職者無法回溯查證，仍計入教師">${r.teachersUnverified} 位已離職、無法查證</small>` : ''}</td>
      <td class="num">${r.trainees}</td>
      <td class="num"><b>${r.ratio == null ? '—' : `1 : ${r.ratio}`}</b></td>
      <td style="min-width:150px"><div class="cap-bar"><i style="width:${use}%" class="${r.ok ? '' : 'over'}"></i></div>
        <small>可帶 ${cap} 名，已帶 ${r.trainees} 名</small></td>
      <td>${r.ok ? '<span class="pill valid">符合</span>' : `<span class="pill expired">不符合</span><br><small>尚需 ${r.needTeachers} 位有效教師</small>`}</td></tr>`;
  };
  const trend = keys.length < 2 ? '' : `<section class="card"><h3>各月趨勢</h3><div class="table-wrap"><table><thead><tr><th>月份</th><th>教師（有效認證）</th><th>學員</th><th>整體師生比</th><th>不符合的職類</th></tr></thead><tbody>
    ${keys.map(x => { const m = months[x]; return `<tr><td>${label(x)}</td><td class="num">${m.totals.teachers}（${m.totals.teachersValid}）</td><td class="num">${m.totals.trainees}</td>
      <td class="num">1 : ${m.totals.teachersValid ? Math.round(m.totals.trainees / m.totals.teachersValid * 100) / 100 : '—'}</td><td>${m.rows.filter(r => !r.ok).map(r => esc(r.prof)).join('、') || '—'}</td></tr>`; }).join('')}
    </tbody></table></div></section>`;
  $('content').innerHTML = `
    <section class="card"><h3>師生比｜衛福部臨床醫事人員培訓計畫</h3>
      <div class="filters" style="align-items:center">${modeSeg}<label style="margin:0;font-weight:700">月份 <select id="rMonth" style="display:inline-block;width:auto;margin-left:6px">${keys.map(x => `<option value="${x}" ${x === k ? 'selected' : ''}>${label(x)}</option>`).join('')}</select></label>
        <span class="hint" style="margin:0">評鑑標準：每位臨床教師至多帶 ${R} 名 PGY 學員（師生比至少 1:${R}）。教師認證以 ${esc(M.ref)} 為準。</span></div>
    </section>
    <section class="kpis">
      <div class="kpi" style="--tone:${bad.length ? 'var(--crimson)' : 'var(--success)'}"><b class="num">${M.rows.length - bad.length} / ${M.rows.length}</b><span>職類符合 1:${R}</span></div>
      <div class="kpi"><b class="num">${M.totals.teachers}</b><span>名單臨床教師</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${M.totals.trainees}</b><span>PGY 學員</span></div>
      <div class="kpi" style="--tone:${invalid ? 'var(--warning)' : 'var(--success)'}"><b class="num">${invalid}</b><span>名單教師認證有問題</span></div>
    </section>
    ${invalid ? `<section class="card attention-card"><b>有 ${invalid} 位列在核定名單上的教師，在 ${esc(M.ref)} 沒有有效的醫策會臨床教師認證</b>（查無認證、已屆滿或教學年資不符合）。這些人不計入有效教師；評鑑時可能被認定不符。名單請見師培中心本機的「師生比核對」檔。</section>` : ''}
    <section class="card"><h3>${label(k)}各職類師生比</h3>
      <div class="table-wrap"><table><thead><tr><th>職類</th><th>名單教師</th><th>PGY 學員</th><th>師生比</th><th>帶教容量（有效教師 × ${R}）</th><th>1:${R}</th></tr></thead>
      <tbody>${M.rows.map(row).join('')}</tbody></table></div>
      <div class="note">師生比以「有效認證教師」計算。醫策會教師認證資料只列現職人員，名單上已離職的教師無法回溯查證，仍計入教師、另行標示。資料來源：${esc(M.file)}；教師認證比對：${esc(M.pecFile || '')}。</div></section>
    ${trend}`;
  $('rMonth').onchange = e => { state.ratioMonth = e.target.value; renderRatio(); };
}

// 師生比：勾選數個月份合併分析（各職類的平均師生比、最差月份、不符合的月數，及每月走勢）
function renderRatioMulti(months, keys, label, modeSeg) {
  const asc = [...keys].sort();
  if (!state.ratioSel || !state.ratioSel.some(k => months[k])) state.ratioSel = [...asc];
  const sel = asc.filter(k => state.ratioSel.includes(k));
  const R = (months[asc[asc.length - 1]] || {}).ratioRequired || 3;
  const years = [...new Set(asc.map(k => k.slice(0, 3)))];
  const quick = [['all', '全選', asc], ['none', '清除', []], ['last3', '最近 3 個月', asc.slice(-3)], ['last6', '最近 6 個月', asc.slice(-6)],
    ...years.flatMap(y => [[`h1${y}`, `${Number(y)} 年上半年`, asc.filter(k => k.startsWith(y) && Number(k.slice(4)) <= 6)], [`h2${y}`, `${Number(y)} 年下半年`, asc.filter(k => k.startsWith(y) && Number(k.slice(4)) > 6)]])]
    .filter(q => q[0] === 'none' || q[2].length);
  state.ratioQuick = Object.fromEntries(quick.map(q => [q[0], q[2]]));
  const picker = `<div class="rm-pick">${asc.map(k => `<label class="rm-chip ${sel.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${sel.includes(k) ? 'checked' : ''} onchange="ratioToggle(this)">${label(k)}</label>`).join('')}</div>
    <div class="rm-quick">${quick.map(q => `<button class="btn btn-ghost" type="button" onclick="state.ratioSel=[...state.ratioQuick['${q[0]}']];renderRatio()">${q[1]}</button>`).join('')}</div>`;
  const head = `<section class="card"><h3>師生比｜多月份分析</h3><div class="filters" style="align-items:center">${modeSeg}<span class="hint" style="margin:0">勾選要合併分析的月份（已選 ${sel.length} 個月）。評鑑標準：師生比至少 1:${R}。</span></div>${picker}</section>`;
  if (!sel.length) { $('content').innerHTML = head + '<div class="card empty">請至少勾選一個月份。</div>'; return; }
  // 各職類跨月彙整
  const profs = [...new Set(sel.flatMap(k => months[k].rows.map(r => r.prof)))];
  const agg = profs.map(p => {
    const per = sel.map(k => ({ k, r: months[k].rows.find(r => r.prof === p) })).filter(x => x.r);
    const avg = f => Math.round(per.reduce((a, x) => a + (Number(x.r[f]) || 0), 0) / per.length * 10) / 10;
    const ratios = per.map(x => ({ k: x.k, v: x.r.teachersValid ? x.r.trainees / x.r.teachersValid : (x.r.trainees ? Infinity : 0), ok: x.r.ok }));
    const worst = ratios.reduce((a, x) => (x.v > a.v ? x : a), ratios[0]);
    const tv = avg('teachersValid'), tr = avg('trainees');
    return { p, months: per.length, tv, tr, avgRatio: tv ? Math.round(tr / tv * 100) / 100 : null, worst, bad: per.filter(x => !x.r.ok).map(x => x.k),
      invalid: per.reduce((a, x) => a + (x.r.teachersInvalid || 0), 0), series: sel.map(k => { const x = ratios.find(r => r.k === k); return x ? x.v : null; }) };
  }).sort((a, b) => b.bad.length - a.bad.length || b.tr - a.tr);
  const badProfs = agg.filter(a => a.bad.length);
  const allOk = sel.filter(k => months[k].rows.every(r => r.ok)).length;
  const fmtR = v => v == null ? '—' : v === Infinity ? '無有效教師' : `1 : ${Math.round(v * 100) / 100}`;
  // 每月走勢小圖：柱高＝學員/有效教師，紅線＝1:R 上限
  const top = Math.max(R * 1.25, ...agg.flatMap(a => a.series.filter(v => v != null && v !== Infinity)));
  const spark = a => `<div class="rm-spark" title="各月師生比">${a.series.map((v, i) => `<i class="${v == null ? 'na' : v > R ? 'over' : ''}" style="height:${v == null ? 4 : v === Infinity ? 100 : Math.max(4, v / top * 100)}%" title="${label(sel[i])}：${fmtR(v)}"></i>`).join('')}<b style="bottom:${R / top * 100}%"></b></div>`;
  const tot = sel.map(k => months[k].totals);
  const avgT = f => Math.round(tot.reduce((a, t) => a + (Number(t[f]) || 0), 0) / tot.length * 10) / 10;
  $('content').innerHTML = head + `
    <section class="kpis">
      <div class="kpi" style="--tone:${allOk === sel.length ? 'var(--success)' : 'var(--crimson)'}"><b class="num">${allOk} / ${sel.length}</b><span>月份全部職類符合 1:${R}</span></div>
      <div class="kpi" style="--tone:${badProfs.length ? 'var(--warning)' : 'var(--success)'}"><b class="num">${badProfs.length} / ${agg.length}</b><span>職類曾有月份不符合</span></div>
      <div class="kpi"><b class="num">${avgT('teachersValid')}</b><span>平均有效教師／月</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${avgT('trainees')}</b><span>平均 PGY 學員／月</span></div>
    </section>
    ${badProfs.length ? `<section class="card attention-card"><b>需要注意的職類</b><ul class="recs">${badProfs.map(a => `<li><b>${esc(a.p)}</b>：${a.bad.map(label).join('、')} 不符合（最差 ${fmtR(a.worst.v)}，${label(a.worst.k)}）</li>`).join('')}</ul></section>` : `<section class="card"><b>所選 ${sel.length} 個月，各職類每月都符合 1:${R}。</b></section>`}
    <section class="card"><h3>各職類合併分析（${label(sel[0])}～${label(sel[sel.length - 1])}，共 ${sel.length} 個月）</h3>
      <div class="table-wrap"><table><thead><tr><th>職類</th><th>平均有效教師</th><th>平均 PGY 學員</th><th>平均師生比</th><th>最差月份</th><th>不符合月數</th><th>每月走勢（紅線＝1:${R}）</th></tr></thead><tbody>
      ${agg.map(a => `<tr class="${a.bad.length ? 'bad' : ''}"><td><b>${esc(a.p)}</b>${a.months < sel.length ? `<br><small class="muted">${a.months} 個月有資料</small>` : ''}</td>
        <td class="num">${a.tv}${a.invalid ? `<br><small class="warn">累計 ${a.invalid} 人次認證有問題</small>` : ''}</td><td class="num">${a.tr}</td><td class="num"><b>${fmtR(a.avgRatio)}</b></td>
        <td>${fmtR(a.worst.v)}<br><small>${label(a.worst.k)}</small></td>
        <td>${a.bad.length ? `<span class="pill expired">${a.bad.length} 個月</span>` : '<span class="pill valid">0</span>'}</td><td>${spark(a)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="note">平均值為所選月份的月平均；師生比以「有效認證教師」計算。最差月份是學員對有效教師比例最高的月份。</div>
      <button class="btn btn-ghost" type="button" id="rmCsv" style="width:auto;margin-top:8px">下載 CSV</button></section>`;
  $('rmCsv').onclick = () => download(`師生比_多月份_${today()}.csv`, [['職類', '月份', '名單教師', '有效教師', '學員', '師生比', '是否符合'],
    ...agg.flatMap(a => sel.map(k => { const r = months[k].rows.find(x => x.prof === a.p); return r ? [a.p, label(k), r.teachers, r.teachersValid, r.trainees, r.ratio == null ? '' : `1:${r.ratio}`, r.ok ? '符合' : '不符合'] : null; }).filter(Boolean))]);
}
function ratioToggle(cb) {
  const s = new Set(state.ratioSel || []);
  cb.checked ? s.add(cb.value) : s.delete(cb.value);
  state.ratioSel = [...s]; renderRatio();
}

// ---------- 問題反映／諮詢：免登入查詢者與登入者都可填寫，師培中心在「來電紀錄」頁處理 ----------
function openFeedback(mode) {
  const lookup = mode === 'lookup';
  if (lookup && !state.lkAuth) return toast('請先完成查詢', false);
  const emp = lookup ? state.lkAuth.emp : state.me.emp_id;
  const name = lookup ? '' : (state.me.name || '');
  let dlg = $('fbDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'fbDlg'; dlg.className = 'small-dlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form id="fbForm" class="dlg-body fb-form" autocomplete="off">
    <div class="dlg-head"><h3>問題反映／諮詢</h3><button class="btn btn-ghost" type="button" onclick="$('fbDlg').close()">關閉</button></div>
    <p class="hint">師培中心收到後，會依您留下的電話與您聯絡。</p>
    <label>員工編號<input value="${esc(emp)}" disabled></label>
    <label>姓名 <span class="req">*必填</span><input id="fbName" required maxlength="40" value="${esc(name)}"></label>
    <label>連絡電話（分機或手機） <span class="req">*必填</span><input id="fbPhone" required maxlength="40" inputmode="tel" placeholder="例如 2345 或 0912-345678"></label>
    <label>方便聯絡的時段（選填）<input id="fbTime" maxlength="60" placeholder="例如 平日下午"></label>
    <div class="call-cats"><span class="lbl">問題類別</span>${CALL_CATS.map((c, i) => `<label class="chip-r"><input type="radio" name="fbCat" value="${esc(c)}" ${i === 0 ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div>
    <label>內容 <span class="req">*必填</span><textarea id="fbMsg" required rows="4" maxlength="2000" placeholder="請描述您的問題，例如：我的某堂課沒有列入時數"></textarea></label>
    <p id="fbMsgOut" class="msg"></p>
    <button class="btn btn-primary" type="submit">送出</button></form>`;
  dlg.showModal();
  setTimeout(() => (name ? $('fbPhone') : $('fbName')).focus(), 0);
  $('fbForm').onsubmit = async e => {
    e.preventDefault();
    const body = { name: $('fbName').value.trim(), phone: $('fbPhone').value.trim(), contact_time: $('fbTime').value.trim(),
      category: (document.querySelector('input[name=fbCat]:checked') || {}).value || '', message: $('fbMsg').value.trim() };
    if (!body.name || !body.phone || !body.message) { $('fbMsgOut').textContent = '請填寫姓名、連絡電話與內容。'; return; }
    const btn = $('fbForm').querySelector('button[type=submit]'); btn.disabled = true;
    try {
      let d;
      if (lookup) {
        const res = await fetch(`${window.APP_CONFIG.url}/functions/v1/lookup`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: window.APP_CONFIG.anonKey, Authorization: `Bearer ${window.APP_CONFIG.anonKey}` },
          body: JSON.stringify({ action: 'feedback', emp_id: state.lkAuth.emp, last4: state.lkAuth.last4, ...body }) });
        d = await res.json().catch(() => ({}));
        if (!d.success) throw new Error(d.message || '送出失敗，請稍後再試。');
      } else d = await api('feedback.submit', body);
      dlg.close(); toast(d.message || '已送出');
    } catch (err) { $('fbMsgOut').textContent = err.message; btn.disabled = false; }
  };
}
// 右下角的小機器人按鈕：免登入查詢結果頁（lookup）與一般登入者（login）顯示；師培中心人員不顯示
function setFab(mode) {
  const b = $('fbFab'); if (!b) return;
  b.hidden = !mode;
  b.onclick = mode ? () => openFeedback(mode) : null;
}
const feedbackCard = mode => `<section class="card fb-card"><div><b>有問題要反映或諮詢？</b><br><small>例如時數沒有列入、認證狀態有疑問。填寫後師培中心會與您聯絡。</small></div>
  <button class="btn btn-primary" style="width:auto" type="button" onclick="openFeedback('${mode}')">問題反映／諮詢</button></section>`;

// 師培中心處理線上反映
async function feedbackInbox() {
  const { data, error } = await sb.from('feedback').select('*, who:staff!feedback_emp_id_fkey(dept)').order('created_at', { ascending: false }).limit(200);
  if (error) return '';
  const list = data || [];
  const pend = list.filter(x => x.status === '待處理');
  state.fbList = list;
  const when = t => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const item = x => `<li class="fb-item ${x.status === '待處理' ? 'pend' : ''}"><div class="fb-top"><b>${esc(x.name)}</b> ${esc(x.emp_id)}｜${esc(x.who?.dept || '')}｜☎ <b>${esc(x.phone)}</b>${x.contact_time ? `（${esc(x.contact_time)}）` : ''}
      <span class="pill ${x.status === '待處理' ? 'expiring' : 'valid'}">${esc(x.status)}</span><small>${when(x.created_at)}・${x.source === 'lookup' ? '免登入查詢' : '登入後'}</small></div>
    <div class="fb-msg">${x.category ? `<span class="org-tag dept">${esc(x.category)}</span> ` : ''}${esc(x.message)}</div>
    ${x.status === '待處理' ? `<div class="filters"><input id="fbR-${Number(x.id)}" placeholder="處理說明（選填）" style="flex:1"><button class="btn btn-ghost" type="button" onclick="go('person','${esc(x.emp_id)}')">看個人頁</button>
      <button class="btn btn-primary" style="width:auto" type="button" onclick="feedbackDone(${Number(x.id)})">已回覆</button></div>` : (x.reply ? `<small>處理說明：${esc(x.reply)}</small>` : '')}</li>`;
  return `<section class="card ${pend.length ? 'attention-card' : ''}"><h3>線上反映（待處理 ${pend.length}）</h3>
    ${list.length ? `<ul class="fb-list">${pend.map(item).join('')}</ul>
      ${list.length > pend.length ? `<details><summary>已回覆（${list.length - pend.length}）</summary><ul class="fb-list">${list.filter(x => x.status !== '待處理').slice(0, 50).map(item).join('')}</ul></details>` : ''}`
      : '<p class="hint" style="margin:0">尚無線上反映。同仁可在「免登入查詢」結果頁或「我的認證」頁按「問題反映／諮詢」填寫。</p>'}</section>`;
}
async function feedbackDone(id) { const d = await act('feedback.update', { id, status: '已回覆', reply: $(`fbR-${id}`) ? $(`fbR-${id}`).value : '' }); if (d) renderCalls(); }

// ---------- 使用紀錄（管理者）：誰在什麼時候登入、查看了誰、免登入查詢、資料異動 ----------
const LOG_TYPES = { login: ['登入系統'], person: ['查看個人頁'], search: ['員工編號查詢'], lookup: ['免登入查詢'], notify: ['寄送提醒'] };
async function renderLogs() {
  const f = state.logF = state.logF || { range: 'week', type: '', q: '' };
  const days = { today: 0, week: 6, month: 29, quarter: 89 }[f.range];
  const since = new Date(Date.now() + 8 * 3600e3 - days * 864e5).toISOString().slice(0, 10);
  let q = sb.from('audit_logs').select('id,at,actor,action,target,detail').gte('at', `${since}T00:00:00+08:00`).order('at', { ascending: false });
  if (f.type && LOG_TYPES[f.type]) q = q.in('action', LOG_TYPES[f.type]);
  else if (f.type === 'change') q = q.not('action', 'in', `(${Object.values(LOG_TYPES).flat().join(',')})`);
  const { data, error } = await q.limit(3000);
  if (error) throw error;
  let logs = data || [];
  // 姓名：使用者與對象
  const ids = [...new Set(logs.flatMap(l => [l.actor, l.target]).filter(x => x && /^[A-Za-z0-9_]{2,20}$/.test(x)))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: s } = await sb.from('staff').select('emp_id,name,dept').in('emp_id', ids.slice(i, i + 200));
    rememberNames(s || []); (s || []).forEach(x => { state.deptOf = state.deptOf || new Map(); state.deptOf.set(x.emp_id.toLowerCase(), x.dept); });
  }
  const nm = e => nameOf(e) || '';
  const kw = f.q.trim().toLowerCase();
  if (kw) logs = logs.filter(l => [l.actor, l.target, nm(l.actor), nm(l.target)].some(v => String(v || '').toLowerCase().includes(kw)));
  const isType = (l, t) => LOG_TYPES[t].includes(l.action);
  const cnt = t => logs.filter(l => isType(l, t)).length;
  const users = new Set(logs.filter(l => isType(l, 'login')).map(l => l.actor)).size;
  // 每日趨勢（登入、免登入查詢、查看個人頁）
  const dayKeys = Array.from({ length: days + 1 }, (_, i) => new Date(Date.now() + 8 * 3600e3 - (days - i) * 864e5).toISOString().slice(0, 10));
  const dayOf = l => new Date(new Date(l.at).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const series = ['login', 'lookup', 'person'].map(t => dayKeys.map(d => logs.filter(l => isType(l, t) && dayOf(l) === d).length));
  const maxD = Math.max(1, ...series.flat());
  const trend = days >= 6 ? `<div class="cs-chart log-chart" style="grid-template-columns:repeat(${dayKeys.length},1fr)">${dayKeys.map((d, i) => `<div class="cs-col">
      <div class="cs-bars">${series.map((s, k) => `<i class="lg${k}" style="height:${s[i] / maxD * 100}%" title="${d}｜${['登入', '免登入查詢', '查看個人頁'][k]} ${s[i]}"></i>`).join('')}</div>
      <span class="cs-m">${dayKeys.length <= 14 || i % 5 === 0 ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : ''}</span></div>`).join('')}</div>
    <div class="legend"><span><i class="lg0"></i>登入</span><span><i class="lg1"></i>免登入查詢</span><span><i class="lg2"></i>查看個人頁</span></div>` : '';
  // 最常使用的人（登入＋查看＋查詢）
  const top = {}; logs.filter(l => !isType(l, 'lookup')).forEach(l => { top[l.actor] = (top[l.actor] || 0) + 1; });
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const label = e => `${esc(nm(e) || '')} <small>${esc(e || '')}</small>`;
  $('content').innerHTML = `
    <section class="card"><h3>使用紀錄</h3>
      <div class="filters" style="align-items:center">
        <div class="seg">${[['today', '今日'], ['week', '近 7 天'], ['month', '近 30 天'], ['quarter', '近 90 天']].map(([v, t]) => `<button type="button" class="${f.range === v ? 'is-active' : ''}" onclick="state.logF.range='${v}';renderLogs()">${t}</button>`).join('')}</div>
        <select id="lgType" style="width:auto"><option value="">所有類型</option>${[['login', '登入系統'], ['person', '查看個人頁'], ['search', '員工編號查詢'], ['lookup', '免登入查詢'], ['notify', '寄送提醒'], ['change','資料異動（審查、授權、上傳…）']].map(([v, t]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <input id="lgQ" type="search" placeholder="使用者或對象的員工編號、姓名" value="${esc(f.q)}" style="flex:1;min-width:180px">
        <button class="btn btn-ghost" type="button" id="lgCsv">下載 CSV</button></div>
      <p class="hint">只有師培中心管理者看得到這一頁。同一人 5 分鐘內重複查看同一頁只記一次；免登入查詢的「使用者」即被查詢的本人。</p></section>
    <section class="kpis">
      <div class="kpi"><b class="num">${cnt('login')}</b><span>登入次數</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${users}</b><span>不重複登入者</span></div>
      <div class="kpi" style="--tone:var(--success)"><b class="num">${cnt('lookup')}</b><span>免登入查詢</span></div>
      <div class="kpi" style="--tone:var(--warning)"><b class="num">${cnt('person') + cnt('search')}</b><span>查看個人頁／編號查詢</span></div>
    </section>
    ${trend ? `<section class="card"><h3>每日使用</h3>${trend}</section>` : ''}
    <section class="card"><h3>使用最多的帳號（登入、查看、查詢）</h3>
      ${topList.map(([e, v]) => `<div class="cs-hbar"><span class="cs-hl">${label(e)}</span><div class="cs-ht"><i style="width:${v / topList[0][1] * 100}%;background:var(--secondary)"></i></div><span class="num">${v}</span></div>`).join('') || '<div class="empty">無資料</div>'}</section>
    <section class="card"><h3>明細（${logs.length} 筆${logs.length >= 3000 ? '，僅顯示最近 3000 筆' : ''}）</h3>
      <div class="table-wrap"><table><thead><tr><th>時間</th><th>使用者</th><th>動作</th><th>對象</th><th>說明</th></tr></thead><tbody>
      ${logs.slice(0, 500).map(l => `<tr><td>${esc(fmtTime(l.at))}</td><td>${label(l.actor)}</td><td><span class="pill ${isType(l, 'lookup') ? 'valid' : isType(l, 'login') ? 'eligible' : isType(l, 'person') || isType(l, 'search') ? '' : 'expiring'}">${esc(l.action)}</span></td>
        <td>${l.target && l.target !== l.actor ? `<button class="btn-link" type="button" onclick="go('person','${esc(l.target)}')">${label(l.target)}</button>` : (l.target === l.actor && !isType(l, 'login') ? '本人' : '')}</td>
        <td class="reason">${esc(ROLE_LABEL[l.detail] || l.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">沒有符合的紀錄</td></tr>'}</tbody></table></div>
      ${logs.length > 500 ? '<p class="hint">畫面顯示最近 500 筆，完整明細請下載 CSV。</p>' : ''}</section>`;
  $('lgType').onchange = e => { f.type = e.target.value; renderLogs(); };
  $('lgQ').onchange = e => { f.q = e.target.value; renderLogs(); };
  $('lgCsv').onclick = () => download(`使用紀錄_${today()}.csv`, [['時間', '使用者員工編號', '使用者姓名', '動作', '對象員工編號', '對象姓名', '說明'],
    ...logs.map(l => [fmtTime(l.at), l.actor, nm(l.actor), l.action, l.target || '', nm(l.target), ROLE_LABEL[l.detail] || l.detail || ''])]);
}

// ---------- 來電紀錄：師培中心承辦人員接聽同仁詢問時記錄（分機、員工編號必填），並可立即查看來電者進度 ----------
const CALL_CATS = ['時數查詢', '認證狀態／效期', '申請／展延流程', '課程報名', '帳號開通／密碼', '醫師考核／教職', '他院轉任', '其他'];
async function renderCalls() {
  const f = state.callF = state.callF || { range: 'month', cat: '', status: '', q: '' };
  const now = new Date(Date.now() + 8 * 3600e3);
  const since = { today: today(), week: new Date(now - 6 * 864e5).toISOString().slice(0, 10), month: today().slice(0, 7) + '-01', all: '2000-01-01' }[f.range];
  const { data, error } = await sb.from('call_logs')
    .select('*, caller:staff!call_logs_emp_id_fkey(name,dept), handler:staff!call_logs_handled_by_fkey(name)')
    .gte('called_at', `${since}T00:00:00+08:00`).order('called_at', { ascending: false }).limit(1000);
  if (error) throw error;
  const { data: pend } = await sb.from('call_logs').select('*, caller:staff!call_logs_emp_id_fkey(name,dept)').eq('status', '待回電').order('called_at').limit(200);
  const rows = (data || []).filter(c => (!f.cat || c.category === f.cat) && (!f.status || c.status === f.status) &&
    (!f.q || c.emp_id.toLowerCase().includes(f.q.toLowerCase()) || (c.caller?.name || '').includes(f.q) || (c.question || '').includes(f.q)));
  const inbox = await feedbackInbox();
  const tCount = (data || []).filter(c => new Date(new Date(c.called_at).getTime() + 8 * 3600e3).toISOString().slice(0, 10) === today()).length;   // 台灣時間的今天
  const catN = {}; (data || []).forEach(c => { const k = c.category || '未分類'; catN[k] = (catN[k] || 0) + 1; });
  const maxC = Math.max(1, ...Object.values(catN));
  const when = t => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('content').innerHTML = `
    <section class="card call-form"><h3>記錄來電</h3>
      <form id="callForm" class="call-grid" autocomplete="off">
        <label>分機 <span class="req">*必填</span><input id="cExt" inputmode="numeric" required placeholder="例如 2345"></label>
        <label>員工編號 <span class="req">*必填</span><input id="cEmp" required placeholder="輸入後顯示來電者資料"></label>
        <div id="cWho" class="call-who"><span class="hint">輸入員工編號後，這裡會顯示姓名、單位、認證狀態與過去來電。</span></div>
        <div class="call-cats"><span class="lbl">問題類別</span>${CALL_CATS.map(c => `<label class="chip-r"><input type="radio" name="cCat" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('')}</div>
        <label class="wide">問題內容<textarea id="cQ" rows="2" placeholder="同仁詢問的內容"></textarea></label>
        <label class="wide">回覆內容<textarea id="cA" rows="2" placeholder="您的回覆，或需要回電處理的事項"></textarea></label>
        <div class="wide call-actions"><label class="check"><input type="checkbox" id="cPend"> 需要回電（標為「待回電」）</label>
          <button class="btn btn-primary" style="width:auto" type="submit">儲存來電紀錄</button></div>
      </form></section>
    ${inbox}
    <section class="kpis">
      <div class="kpi"><b class="num">${tCount}</b><span>今日來電</span></div>
      <div class="kpi" style="--tone:var(--secondary)"><b class="num">${(data || []).length}</b><span>${{ today: '今日', week: '近 7 天', month: '本月', all: '全部' }[f.range]}來電</span></div>
      <div class="kpi" style="--tone:var(--warning)"><b class="num">${(pend || []).length}</b><span>待回電</span></div>
    </section>
    ${(pend || []).length ? `<section class="card attention-card"><h3>待回電（${pend.length}）</h3><ul class="lk-list">
      ${pend.map(c => `<li><span class="lk-date">${when(c.called_at)}</span><span class="lk-title"><b>${esc(c.caller?.name || '')}</b> ${esc(c.emp_id)}｜分機 <b>${esc(c.ext)}</b>｜${esc(c.caller?.dept || '')}
        <small>${esc(c.category || '')}：${esc(c.question || '')}</small></span>
        <button class="btn btn-ghost" type="button" onclick="callDone(${Number(c.id)})">已回覆</button></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h3>常見問題（${{ today: '今日', week: '近 7 天', month: '本月', all: '全部' }[f.range]}）</h3>
      ${Object.entries(catN).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="cs-hbar"><span class="cs-hl">${esc(k)}</span><div class="cs-ht"><i style="width:${v / maxC * 100}%;background:var(--secondary)"></i></div><span class="num">${v}</span></div>`).join('') || '<div class="empty">尚無來電紀錄</div>'}
      <p class="hint">常被問的問題可以考慮公告或放進「免登入查詢」頁的說明，減少來電。</p></section>
    <section class="card"><h3>來電紀錄（${rows.length} 筆）</h3>
      <div class="filters" style="align-items:center">
        <div class="seg">${[['today', '今日'], ['week', '近 7 天'], ['month', '本月'], ['all', '全部']].map(([v, t]) => `<button type="button" class="${f.range === v ? 'is-active' : ''}" onclick="state.callF.range='${v}';renderCalls()">${t}</button>`).join('')}</div>
        <select id="cfCat" style="width:auto"><option value="">所有類別</option>${CALL_CATS.map(c => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="cfSt" style="width:auto"><option value="">所有狀態</option><option ${f.status === '已回覆' ? 'selected' : ''}>已回覆</option><option ${f.status === '待回電' ? 'selected' : ''}>待回電</option></select>
        <input id="cfQ" type="search" placeholder="員工編號、姓名或問題" value="${esc(f.q)}" style="flex:1;min-width:160px">
        <button class="btn btn-ghost" type="button" id="cfCsv">下載 CSV</button></div>
      <div class="table-wrap"><table><thead><tr><th>時間</th><th>來電者</th><th>分機</th><th>類別</th><th>問題／回覆</th><th>狀態</th><th>接聽</th></tr></thead><tbody>
      ${rows.slice(0, 300).map(c => `<tr><td>${when(c.called_at)}</td>
        <td><button class="btn-link" type="button" onclick="go('person','${esc(c.emp_id)}')">${esc(c.caller?.name || c.emp_id)}</button><br><small>${esc(c.emp_id)}｜${esc(c.caller?.dept || '')}</small></td>
        <td class="num">${esc(c.ext)}</td><td>${esc(c.category || '')}</td>
        <td class="reason">${esc(c.question || '')}${c.answer ? `<br><small>回覆：${esc(c.answer)}</small>` : ''}</td>
        <td>${c.status === '待回電' ? `<span class="pill expiring">待回電</span><br><button class="btn-link" type="button" onclick="callDone(${Number(c.id)})">標為已回覆</button>` : '<span class="pill valid">已回覆</span>'}</td>
        <td>${esc(c.handler?.name || c.handled_by || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">沒有符合的紀錄</td></tr>'}</tbody></table></div></section>`;

  // 輸入員工編號 → 顯示來電者資料（姓名、單位、認證狀態、過去來電）
  let timer;
  $('cEmp').oninput = () => { clearTimeout(timer); timer = setTimeout(showCaller, 350); };
  async function showCaller() {
    const q = $('cEmp').value.trim().replace(/[%_\\,()]/g, '');
    if (q.length < 3) { $('cWho').innerHTML = '<span class="hint">輸入員工編號後，這裡會顯示姓名、單位、認證狀態與過去來電。</span>'; return; }
    const [{ data: st }, { data: past }] = await Promise.all([
      sb.from('cert_status').select('emp_id,dept,status,status_code,ve:detail->activeCertificate->>valid_end_roc,teach:detail->>teachingHours,need:detail->>requiredTotalHours,staff(name,title)').ilike('emp_id', q).limit(1),
      sb.from('call_logs').select('called_at,category,question,status').ilike('emp_id', q).order('called_at', { ascending: false }).limit(5)
    ]);
    const s = st && st[0];
    if (!s) { $('cWho').innerHTML = `<span class="warn-text">查無員工編號「${esc(q)}」，請再確認。</span>`; return; }
    $('cWho').innerHTML = `<div class="call-card tone-${esc(s.status_code)}"><b>${esc(s.staff?.name || '')}</b> ${esc(s.emp_id)}｜${esc(s.dept)}｜${esc(s.staff?.title || '')}
      <div>${esc(s.status)}${s.ve ? `｜效期至 ${esc(s.ve)}` : ''}｜點數 ${esc(s.teach)} / ${esc(s.need)}</div>
      <button class="btn-link" type="button" onclick="go('person','${esc(s.emp_id)}')">開啟完整個人頁 →</button>
      ${(past || []).length ? `<div class="hint" style="margin:4px 0 0">過去來電 ${past.length} 次：${past.map(p => `${new Date(p.called_at).toLocaleDateString('zh-TW')} ${esc(p.category || '')}${p.status === '待回電' ? '（待回電）' : ''}`).join('；')}</div>` : ''}</div>`;
  }
  $('callForm').onsubmit = async e => {
    e.preventDefault();
    const cat = (document.querySelector('input[name=cCat]:checked') || {}).value || '';
    const d = await act('call.log', { ext: $('cExt').value, emp_id: $('cEmp').value, category: cat, question: $('cQ').value, answer: $('cA').value, status: $('cPend').checked ? '待回電' : '已回覆' });
    if (d) renderCalls();
  };
  $('cfCat').onchange = e => { f.cat = e.target.value; renderCalls(); };
  $('cfSt').onchange = e => { f.status = e.target.value; renderCalls(); };
  $('cfQ').onchange = e => { f.q = e.target.value; renderCalls(); };
  $('cfCsv').onclick = () => download(`來電紀錄_${today()}.csv`, [['時間', '員工編號', '姓名', '單位', '分機', '類別', '問題', '回覆', '狀態', '接聽'],
    ...rows.map(c => [fmtTime(c.called_at), c.emp_id, c.caller?.name || '', c.caller?.dept || '', c.ext, c.category || '', c.question || '', c.answer || '', c.status, c.handler?.name || c.handled_by || ''])]);
  setTimeout(() => $('cExt').focus(), 0);
}
async function callDone(id) { const d = await act('call.update', { id, status: '已回覆' }); if (d) renderCalls(); }

// ---------- 課程辦理狀況：一般醫學、教學能力提升課程的課程數、通過人次、開課單位、形式、參與者職類 ----------
// 資料：每次同步由本機彙總的課程層級統計（settings.course_stats），不含個人資料
const CAT_NAME = { general: '一般醫學', teaching: '教學能力提升' };
async function renderCourseStats() {
  // 資料列權限：最高管理者看全部；其他人只看得到自己擔任承辦人的課程
  const raw = await fetchAll(() => sb.from('course_stats').select('*').order('course_date'));
  const all = raw.map(x => ({ c: x.cat, t: x.title, d: x.course_date, o: x.org, by: x.by_org, f: x.form || '', io: x.inout || '', h: Number(x.hours) || 0, p: x.passed, pr: x.prof || {}, orgz: x.organizer_names || '',
    s: x.satisfaction == null ? null : Number(x.satisfaction), sc: x.avg_score == null ? null : Number(x.avg_score), pass: x.pass_rate == null ? null : Number(x.pass_rate) }));
  if (!all.length) { $('content').innerHTML = `<div class="card empty">${state.role === 'super_admin' ? '尚無課程辦理資料，請執行同步（node tools/sync-up.js）。' : '目前沒有您擔任承辦人的一般醫學或教學能力提升課程。'}</div>`; return; }
  const years = [...new Set(all.map(c => c.d.slice(0, 4)))].sort().reverse();
  const f = state.cs = state.cs || { year: years[0], cat: '', by: '', q: '' };
  if (!years.includes(f.year)) f.year = years[0];
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const inYear = all.filter(c => c.d.startsWith(f.year));
  const rows = inYear.filter(c => (!f.cat || c.c === f.cat) && (!f.by || c.by === f.by));
  const kpi = cat => {
    const L = inYear.filter(c => c.c === cat && (!f.by || c.by === f.by));
    const p = L.reduce((a, c) => a + c.p, 0), ph = L.reduce((a, c) => a + c.p * c.h, 0);
    return `<div class="card cs-kpi cs-${cat}"><h3>${CAT_NAME[cat]}</h3>
      <div class="cs-kpi-row"><div><b class="num">${L.length}</b><span>辦理課程</span></div><div><b class="num">${p.toLocaleString()}</b><span>參與人次（通過）</span></div>
        <div><b class="num">${L.length ? Math.round(p / L.length) : 0}</b><span>平均每門人次</span></div><div><b class="num">${Math.round(ph).toLocaleString()}</b><span>人時</span></div></div>
      <small>教學部辦 ${L.filter(c => c.by === 'cfd').length} 門・科部辦 ${L.filter(c => c.by === 'dept').length} 門・線上 ${L.filter(c => c.f === '線上').length} 門</small></div>`;
  };
  // 逐月：兩類課程的通過人次（長條）與課程數
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const byMonth = cat => months.map(m => inYear.filter(c => c.c === cat && c.d.slice(5, 7) === m && (!f.by || c.by === f.by)));
  const gm = byMonth('general'), tm = byMonth('teaching');
  const maxP = Math.max(1, ...months.map((_, i) => Math.max(gm[i].reduce((a, c) => a + c.p, 0), tm[i].reduce((a, c) => a + c.p, 0))));
  const monthChart = `<div class="cs-chart" role="img" aria-label="${f.year - 1911} 年逐月通過人次">
    ${months.map((m, i) => { const gp = gm[i].reduce((a, c) => a + c.p, 0), tp = tm[i].reduce((a, c) => a + c.p, 0); return `<div class="cs-col">
      <div class="cs-bars"><i class="g" style="height:${gp / maxP * 100}%" title="一般醫學 ${gp} 人次（${gm[i].length} 門）"></i><i class="t" style="height:${tp / maxP * 100}%" title="教學能力提升 ${tp} 人次（${tm[i].length} 門）"></i></div>
      <span class="cs-m">${Number(m)} 月</span><small>${gm[i].length + tm[i].length} 門</small></div>`; }).join('')}</div>
    <div class="legend"><span><i style="background:var(--cs-g)"></i>一般醫學</span><span><i style="background:var(--cs-t)"></i>教學能力提升</span>　<small class="hint">長條＝通過人次；下方＝課程數（滑鼠移到長條可看數字）</small></div>`;
  // 開課單位（前 12）、形式、參與者職類
  const agg = (list, keyOf) => { const m = {}; list.forEach(c => { const k = keyOf(c); m[k] = m[k] || { n: 0, p: 0 }; m[k].n++; m[k].p += c.p; }); return Object.entries(m).sort((a, b) => b[1].p - a[1].p); };
  const orgs = agg(rows, c => c.o).slice(0, 12), maxO = Math.max(1, ...orgs.map(o => o[1].p));
  const forms = agg(rows, c => `${c.f || '未註明'}${c.io ? '・' + c.io : ''}`);
  const pr = {}; rows.forEach(c => Object.entries(c.pr || {}).forEach(([k, v]) => { pr[k] = (pr[k] || 0) + v; }));
  const prTotal = Object.values(pr).reduce((a, b) => a + b, 0) || 1;
  const PR_COLOR = { 護理: '#2575A1', 醫師: '#13A3B8', 醫事: '#48B6A2', 其他: '#A7ACAF' };
  const top = [...rows].sort((a, b) => b.p - a.p).slice(0, 10);
  const q = f.q.trim();
  const listRows = rows.filter(c => !q || c.t.includes(q) || c.o.includes(q)).sort((a, b) => b.d.localeCompare(a.d));
  $('content').innerHTML = `
    <section class="card"><h3>課程辦理狀況</h3>
      <div class="filters" style="align-items:center">
        <label style="margin:0;font-weight:700">年度 <select id="csYear" style="display:inline-block;width:auto">${years.map(y => `<option value="${y}" ${y === f.year ? 'selected' : ''}>${Number(y) - 1911} 年</option>`).join('')}</select></label>
        <div class="seg" role="tablist">${[['', '全部'], ['general', '一般醫學'], ['teaching', '教學能力提升']].map(([v, t]) => `<button type="button" class="${f.cat === v ? 'is-active' : ''}" onclick="state.cs.cat='${v}';renderCourseStats()">${t}</button>`).join('')}</div>
        <div class="seg">${[['', '所有開課單位'], ['cfd', '教學部辦'], ['dept', '科部辦']].map(([v, t]) => `<button type="button" class="${f.by === v ? 'is-active' : ''}" onclick="state.cs.by='${v}';renderCourseStats()">${t}</button>`).join('')}</div>
      </div>
      <p class="hint">${state.role === 'super_admin' ? '最高管理者：顯示全院課程。' : '只顯示<b>您擔任承辦人</b>的課程。'}資料來源：教學系統「詳細修課紀錄」報表（一般醫學、教學能力提升）。參與人次＝通過人次，同一人同一門課只算一次；課程依「認證項目」歸類。</p></section>
    <section class="cs-kpis">${!f.cat || f.cat === 'general' ? kpi('general') : ''}${!f.cat || f.cat === 'teaching' ? kpi('teaching') : ''}</section>
    <section class="card"><h3>${Number(f.year) - 1911} 年逐月辦理情形</h3>${monthChart}</section>
    <section class="cs-two">
      <div class="card"><h3>開課單位（依通過人次，前 12）</h3>
        ${orgs.map(([o, v]) => `<div class="cs-hbar"><span class="cs-hl" title="${esc(o)}">${esc(o)}</span><div class="cs-ht"><i style="width:${v.p / maxO * 100}%" class="${o.startsWith('教學部') ? 'cfd' : 'dept'}"></i></div><span class="num">${v.p.toLocaleString()}<small>／${v.n} 門</small></span></div>`).join('') || '<div class="empty">無資料</div>'}
        <div class="legend"><span><i style="background:#3F8233"></i>教學部辦</span><span><i style="background:#C7891A"></i>科部辦</span></div></div>
      <div class="card"><h3>參與者職類（通過人次）</h3>
        <div class="cs-stack">${Object.entries(pr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<i style="width:${v / prTotal * 100}%;background:${PR_COLOR[k] || '#ccc'}" title="${k} ${v}"></i>`).join('')}</div>
        <div class="legend">${Object.entries(pr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span><i style="background:${PR_COLOR[k] || '#ccc'}"></i>${k} ${v.toLocaleString()}（${Math.round(v / prTotal * 100)}%）</span>`).join('')}</div>
        <h3 style="margin-top:16px">課程形式</h3>
        ${forms.map(([k, v]) => `<div class="cs-form"><span>${esc(k)}</span><b class="num">${v.n}</b> 門・<b class="num">${v.p.toLocaleString()}</b> 人次</div>`).join('')}</div>
    </section>
    ${satCard(rows)}
    <section class="card"><h3>通過人次最多的 10 門課</h3><div class="table-wrap"><table><thead><tr><th>日期</th><th>類別</th><th>課程名稱</th><th>開課單位</th><th>形式</th><th>通過人次</th></tr></thead><tbody>
      ${top.map(c => `<tr><td>${esc(c.d)}</td><td>${CAT_NAME[c.c]}</td><td style="white-space:normal">${esc(c.t)}</td><td>${esc(c.o)}</td><td>${esc(c.f)}</td><td class="num"><b>${c.p.toLocaleString()}</b></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h3>課程清單（${listRows.length} 門）</h3>
      <div class="filters"><input id="csQ" type="search" placeholder="搜尋課程名稱或開課單位" value="${esc(f.q)}" style="flex:1"><button class="btn btn-ghost" type="button" id="csCsv">下載 CSV</button></div>
      <div class="table-wrap"><table><thead><tr><th>日期</th><th>類別</th><th>課程名稱</th><th>開課單位</th><th>承辦人</th><th>形式</th><th>認證時數</th><th>通過人次</th><th>滿意度</th><th>護理／醫師／醫事／其他</th></tr></thead><tbody>
      ${listRows.slice(0, 300).map(c => `<tr><td>${esc(c.d)}</td><td>${CAT_NAME[c.c]}</td><td style="white-space:normal;min-width:200px">${esc(c.t)}</td><td>${esc(c.o)}</td><td style="white-space:normal">${esc(c.orgz)}</td><td>${esc(c.f)}</td><td class="num">${n(c.h)}</td><td class="num">${c.p.toLocaleString()}</td>
        <td class="num">${c.s == null ? '<small class="muted">未發問卷</small>' : `<span class="${c.s < 90 ? 'warn' : ''}">${n(c.s)}%</span>`}</td>
        <td class="num">${['護理', '醫師', '醫事', '其他'].map(k => (c.pr || {})[k] || 0).join('／')}</td></tr>`).join('')}</tbody></table></div>
      ${listRows.length > 300 ? '<p class="hint">畫面顯示前 300 門，完整清單請下載 CSV。</p>' : ''}</section>`;
  $('csYear').onchange = e => { f.year = e.target.value; renderCourseStats(); };
  $('csQ').onchange = e => { f.q = e.target.value; renderCourseStats(); };
  $('csCsv').onclick = () => download(`課程辦理_${Number(f.year) - 1911}年.csv`, [['日期', '類別', '課程名稱', '開課單位', '教學部辦／科部辦', '承辦人', '形式', '內外訓', '認證時數', '通過人次', '滿意度(%)', '通過率(%)', '平均成績', '護理', '醫師', '醫事', '其他'],
    ...listRows.map(c => [c.d, CAT_NAME[c.c], c.t, c.o, c.by === 'cfd' ? '教學部辦' : '科部辦', c.orgz, c.f, c.io, n(c.h), c.p, c.s ?? '', c.pass ?? '', c.sc ?? '', ...['護理', '醫師', '醫事', '其他'].map(k => (c.pr || {})[k] || 0)])]);
}

// 課程滿意度（教學系統「單位開課報表」的課程滿意度問卷 %）：發放率、平均、分布、面授／線上、教學部辦／科部辦、較低的課程
function satCard(rows) {
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const S = rows.filter(c => c.s != null);
  if (!rows.some(c => c.s != null || c.pass != null)) return `<section class="card"><h3>課程滿意度</h3>
    <p class="hint" style="margin:0">尚未匯入課程品質資料：請把教學系統的「單位開課報表」（division_course_create.xlsx）放在「開課報表」資料夾，並執行 supabase/013_course_quality.sql 後同步。</p></section>`;
  const avg = list => list.length ? n(list.reduce((a, c) => a + c.s, 0) / list.length) : null;
  const cov = Math.round(S.length / Math.max(1, rows.length) * 100);
  const bins = [['95% 以上', c => c.s >= 95, 'var(--success)'], ['90–95%', c => c.s >= 90 && c.s < 95, 'var(--secondary)'], ['未滿 90%', c => c.s < 90, 'var(--crimson)']];
  const cmp = (label, a, b, la, lb) => `<div class="sat-cmp"><span>${label}</span><b>${la} ${avg(a) == null ? '—' : avg(a) + '%'}</b><small>（${a.length} 門）</small><b>${lb} ${avg(b) == null ? '—' : avg(b) + '%'}</b><small>（${b.length} 門）</small></div>`;
  const low = [...S].sort((a, b) => a.s - b.s).slice(0, 5);
  if (!S.length) return `<section class="card"><h3>課程滿意度</h3><p class="hint" style="margin:0">這些課程都沒有發放滿意度問卷（共 ${rows.length} 門）。</p></section>`;
  return `<section class="card sat"><h3>課程滿意度</h3>
    <div class="sat-top">
      <div><b class="num">${avg(S)}%</b><span>平均滿意度</span></div>
      <div class="${cov < 50 ? 'warn' : ''}"><b class="num">${cov}%</b><span>有發問卷（${S.length} / ${rows.length} 門）</span></div>
      <div><b class="num">${n(Math.min(...S.map(c => c.s)))}%</b><span>最低</span></div></div>
    <div class="sat-bar">${bins.map(([t, fn, col]) => { const k = S.filter(fn).length; return k ? `<i style="flex:${k};background:${col}" title="${t}：${k} 門">${Math.round(k / S.length * 100)}%</i>` : ''; }).join('')}</div>
    <div class="legend">${bins.map(([t, fn, col]) => `<span><i style="background:${col}"></i>${t} ${S.filter(fn).length} 門</span>`).join('')}</div>
    ${cmp('授課形式', S.filter(c => c.f === '面授'), S.filter(c => c.f === '線上'), '面授', '線上')}
    ${cmp('開課單位', S.filter(c => c.by === 'cfd'), S.filter(c => c.by === 'dept'), '教學部辦', '科部辦')}
    <div class="group-label">滿意度最低的 5 門課</div>
    <ul class="lk-list">${low.map(c => `<li><span class="lk-date">${esc(c.d.slice(5).replace('-', '/'))}</span><span class="lk-title">${esc(c.t)}<small>${esc(c.o)}・${esc(c.f)}・${c.p.toLocaleString()} 人次</small></span><span class="lk-h ${c.s < 90 ? 'warn' : ''}">${n(c.s)}%</span></li>`).join('')}</ul>
    <div class="note">資料來源：教學系統「單位開課報表」的「課程滿意度問卷」，依課程編號對應。滿意度普遍很高、差異不大，<b>發放率</b>和<b>較低的課程</b>比平均值更值得注意；要看課程成效，建議搭配同仁之後是否持續修課等行為資料。</div></section>`;
}

// ---------- 職類別管理人：勾選要監測的單位（例如護理職類管理人勾選護理單位） ----------
async function openUnitPicker() {
  let data;
  try { data = await api('scope.units'); } catch (err) { return toast(err.message, false); }
  let dlg = $('unitDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'unitDlg'; document.body.appendChild(dlg); }
  const sel = new Set(data.selected || []);
  const total = data.units.reduce((a, u) => a + u.n, 0);
  dlg.innerHTML = `<div class="dlg-body"><div class="dlg-head"><h3>設定監測單位｜${esc(data.profession)}職類</h3><button class="btn btn-ghost" type="button" onclick="$('unitDlg').close()">關閉</button></div>
    <p class="hint">勾選您要監測的單位；全部不勾＝監測所有 ${data.units.length} 個有${esc(data.profession)}執登人員的單位（共 ${total} 人）。名單、總覽、到期與提報、訓練計畫的教師名單都會依此範圍顯示。</p>
    <div class="filters"><input id="uQ" type="search" placeholder="搜尋單位名稱" style="flex:1">
      <button class="btn btn-ghost" type="button" id="uAll">全選（目前篩選）</button><button class="btn btn-ghost" type="button" id="uNone">全部取消</button></div>
    <div id="uList" class="unit-list"></div>
    <div class="filters" style="justify-content:space-between;align-items:center;margin-top:10px"><span id="uCount" class="num"></span>
      <button class="btn btn-primary" style="width:auto" type="button" id="uSave">儲存監測單位</button></div></div>`;
  const draw = () => {
    const q = $('uQ').value.trim();
    const list = data.units.filter(u => !q || u.dept.includes(q));
    $('uList').innerHTML = list.map(u => `<label class="unit"><input type="checkbox" value="${esc(u.dept)}" ${sel.has(u.dept) ? 'checked' : ''}><span>${esc(u.dept)}</span><small>${u.n} 人</small></label>`).join('') || '<div class="empty">沒有符合的單位</div>';
    $('uList').querySelectorAll('input').forEach(i => { i.onchange = () => { i.checked ? sel.add(i.value) : sel.delete(i.value); count(); }; });
    count();
  };
  const count = () => { $('uCount').textContent = sel.size ? `已勾選 ${sel.size} 個單位（${data.units.filter(u => sel.has(u.dept)).reduce((a, u) => a + u.n, 0)} 人）` : `未勾選＝全部 ${data.units.length} 個單位`; };
  $('uQ').oninput = draw;
  $('uAll').onclick = () => { const q = $('uQ').value.trim(); data.units.filter(u => !q || u.dept.includes(q)).forEach(u => sel.add(u.dept)); draw(); };
  $('uNone').onclick = () => { sel.clear(); draw(); };
  $('uSave').onclick = async () => {
    const d = await act('scope.setUnits', { units: [...sel] });
    if (!d) return;
    state.me.scope_units = sel.size ? [...sel] : null; state.list = null; state.alts = {};
    dlg.close(); go(state.view, state.arg);
  };
  draw(); dlg.showModal();
}
const scopeCard = () => state.role === 'dept_coordinator' && state.me.scope_profession ? `<section class="card scope-card">
  <div><b>監測範圍：${esc(state.me.scope_profession)}職類</b>　${(state.me.scope_units || []).length ? `已勾選 ${state.me.scope_units.length} 個單位` : '所有單位'}</div>
  <button class="btn btn-ghost" type="button" onclick="openUnitPicker()">設定監測單位</button></section>` : '';

// ---------- 訓練計畫書：依 PEC「訓練計畫書模板」九大項目填寫；教師部分由系統帶入 ----------
const PLAN_TEMPLATE = [
  { k: '1', t: '一、計畫書格式規範', items: [
    ['1A', '標題', '標題清楚標示學年度、訓練單位與層級'], ['1B', '定稿及修訂會議日期', '計畫書須經正式會議（如 PEC 或科部會議）通過，封面標示會議日期及名稱'],
    ['1C', '計畫主持人', '含子計畫主持人（選填）、教學負責人（協助計畫主持人執行訓練計畫的主要負責人）'], ['1D', '目錄、版次、格式排版', '目錄與版次依本院規範；字體、邊界、行寬等格式一致'] ] },
  { k: '2', t: '二、訓練目標與架構', items: [
    ['2A', '訓練宗旨及具體目標', '符合該職類公告之專業核心能力（如 ACGME 六大核心能力）'], ['2B', '核心能力理論架構', '導入明確之核心能力框架，如 milestone 或 EPA 指標'],
    ['2C', '訓練計畫執行架構', '清楚標示部門組織分工與跨部門組織'] ] },
  { k: '3', t: '三、教學師資', teachers: true, items: [
    ['3A', '計畫主持人', '揭露主持人之臨床教學資歷、學術表現、教師認證資格及工作說明'], ['3B', '教學負責人', '揭露教學負責人之臨床教學資歷、學術表現、教師認證資格及工作說明'],
    ['3C', '教師名單（專長、職責、認證）', '以表格陳列所有教師名單、資格及認證；註明臨床、學術與教學專長；教師群明確分工（導師、研究指導、困難輔導等）；註明院內外教師認證'],
    ['3D', '教師發展', '所有教師需符合臨床教師資格並持續接受師資培育課程'], ['3E', '其他人員', '說明行政人員、技術員等在訓練計畫中的角色'] ] },
  { k: '4', t: '四、教學資源', items: [
    ['4A', '硬體設備', '機構共享（臨床技能中心、圖書館、數位教材室）與科內專屬（會議室、檢查室、電腦、投影設備、教具）'],
    ['4B', '學習教材', '機構共享與科內專屬之專書、期刊、數位教材、核心課程影片、E-portfolio、學習平台'] ] },
  { k: '5', t: '五、醫學與專業能力訓練方式（MK & PC & ICS）', items: [
    ['5A', '專業領域核心課程及活動', '多元學習方式（課室、模擬、數位混成）；包含專業與一般醫學（感染管制、實證醫學等）'],
    ['5B', '專業領域臨床實作與輪訓', '單位輪訓規劃、足夠案例種類與數目、多元臨床場域、明確指導授權與監督機制'],
    ['5C', '跨領域團隊照護訓練', '全院型活動與跨職類或場域之教學活動（如 TRM、跨領域教案討論）'] ] },
  { k: '6', t: '六、全人照顧能力訓練方式（PROF & SBP & PBLD）', items: [
    ['6A', '醫療品質與病人安全課程', '全院或科部醫品病安課程、團隊會議（M&M、QA）、模擬課程'], ['6B', '醫學倫理與法律課程', '相關課程、案例討論與反思、模擬課程'],
    ['6C', '全人照護訓練', '靈性、性別、韌性等課程與案例討論'], ['6D', '其他能力', '教學能力提升、行政能力提升、臨床研究提升'] ] },
  { k: '7', t: '七、考評機制與反映管道', items: [
    ['7A', '以能力為本的評量藍圖', '以圖表將各類評量工具對應於各種核心能力'], ['7B', '形成性評量', '評量工具與頻率（如 Mini-CEX、DOPS、CbD）'],
    ['7C', '總結性評量', '評量工具與頻率（如口試、筆試、OSCE）'], ['7D', '雙向溝通或回饋方式', '機構、計畫主持人、導師三個層級的座談、滿意度調查等'],
    ['7E', '臨床能力委員會（CCC）', '組成方式與頻率；至少每半年以多元評量評估學員核心能力（milestone 或 EPA）'], ['7F', '訓練計畫評估委員會（PEC）', '組成方式；至少每年一次'] ] },
  { k: '8', t: '八、輔導與補強機制', items: [
    ['8A', '學習成效不佳之定義與輔導', '學習時數、案例種類不足或學習成效不佳的定義與輔導機制'],
    ['8B', '教學成效不佳之定義與輔導', '教師定期多元評量（學員書面回饋、滿意度、教學貢獻、優良教師選拔、研究表現），至少每年一次確認評估；教學成效不佳之輔導機制'],
    ['8C', '個人化學習計畫（ILP）', '學員學習不佳、輔導後之個人化學習計畫'] ] },
  { k: '9', t: '九、其他', items: [
    ['9A', '作業與評量表單', '呈現於附件'], ['9B', '計畫書修改與精進', '訓練計畫年度報告（APE）、計畫書修改內容、教學精進專案（PDCA）'],
    ['9C', '特色教學課程', '特色教學活動、多元學習方式與課程主題'] ] }
];
const PLAN_ITEMS = PLAN_TEMPLATE.flatMap(s => s.items.map(i => i[0]));
const planDone = c => PLAN_ITEMS.filter(k => c && c.items && c.items[k] && c.items[k].done).length;
const myScopeKey = () => state.me.scope_profession ? `prof:${state.me.scope_profession}` : `dept:${state.me.scope_dept || state.me.dept}`;
const scopeName = key => key.startsWith('prof:') ? `${key.slice(5)}職類` : key.slice(5);
const PLAN_STATUS_PILL = { 草稿: 'expiring', 送審中: 'eligible', 已通過: 'valid', 退回修改: 'expired' };

// 系統帶入：計畫範圍內的教師（有效臨床教師認證或醫師本年度達標）與教師發展指標
async function planTeachers(plan) {
  const c = plan.content || {};
  const build = () => {   // 每頁重新建立查詢（查詢物件不可重複使用）
    let q = sb.from('cert_status').select('emp_id,dept,status_code,track_type,ve:detail->activeCertificate->>valid_end_roc,teach:detail->>teachingHours,' +
      'tot:detail->>totalHours,ok:detail->>compliant,core:detail->coreCourses,lect:detail->lecturer->>totalHours,staff!inner(name,title,profession)');
    if (plan.scope_key.startsWith('prof:')) {
      q = q.eq('staff.profession', plan.scope_key.slice(5));
      if ((c.scope_units || []).length) q = q.in('dept', c.scope_units);
    } else q = q.like('dept', `${plan.scope_key.slice(5)}%`);
    return q.order('emp_id');
  };
  const rows = await fetchAll(build);
  rememberNames(rows);
  const teachers = rows.filter(r => r.ve || (r.track_type === 'physician' && r.ok === 'true'));
  return { all: rows, teachers };
}

async function renderPlanPage() {
  if (isAdmin() && !state.planId) return renderPlanList();
  const year = Number(today().slice(0, 4)) - 1911;
  let plan;
  if (state.planId) {
    const { data } = await sb.from('training_plans').select('*').eq('id', state.planId).maybeSingle();
    plan = data;
  } else {
    const { data } = await sb.from('training_plans').select('*').eq('academic_year', year).eq('scope_key', myScopeKey()).maybeSingle();
    plan = data || { academic_year: year, scope_key: myScopeKey(), title: `${year} 學年度${scopeName(myScopeKey())}訓練計畫書`, content: { items: {} }, status: '草稿',
      _new: true };
    if (!plan.content.scope_units && state.me.scope_units) plan.content.scope_units = state.me.scope_units;
  }
  if (!plan) { $('content').innerHTML = '<div class="card empty">找不到計畫書。</div>'; return; }
  const editable = !isAdmin() ? !['送審中', '已通過'].includes(plan.status) : true;
  const c = plan.content || {}; c.items = c.items || {};
  const T = await planTeachers(plan);
  const n = v => Math.round((Number(v) || 0) * 10) / 10;
  const done = planDone(c), total = PLAN_ITEMS.length;
  const coreN = T.teachers.filter(t => (t.core || []).length).length, lectN = T.teachers.filter(t => Number(t.lect) > 0).length;
  const devOk = T.teachers.filter(t => t.status_code === 'valid' || t.status_code === 'eligible' || t.ok === 'true').length;
  const leaders = [['leader', '計畫主持人'], ['teach_lead', '教學負責人']].map(([k, label]) => {
    const emp = (c[k] || '').trim(); const t = emp && T.all.find(x => x.emp_id.toLowerCase() === emp.toLowerCase());
    return `<label>${label}（員工編號）<input data-f="${k}" value="${esc(emp)}" ${editable ? '' : 'disabled'} placeholder="例如 N4181">
      ${emp ? `<small>${t ? `${esc(t.staff?.name || '')}｜${esc(t.dept)}｜${t.ve ? `臨床教師認證有效至 ${esc(t.ve)}` : esc(t.status_code === 'valid' ? '本年度達標' : '目前無有效認證')}` : '不在本計畫範圍內或查無此人'}</small>` : ''}</label>`;
  }).join('');
  const teacherPanel = `<div class="plan-auto"><div class="group-label">系統帶入：本計畫範圍的教師現況（教師認證、教師發展）</div>
    <div class="score-dist">
      <div class="sd valid"><b class="num">${T.teachers.length}</b><span>臨床教師（有效認證）</span><small>範圍內共 ${T.all.length} 人</small></div>
      <div class="sd eligible"><b class="num">${T.teachers.length ? Math.round(devOk / T.teachers.length * 100) : 0}%</b><span>教師發展達標</span><small>${devOk} 人符合本年度規定</small></div>
      <div class="sd bonus"><b class="num">${coreN}</b><span>核心教師</span><small>有核心教師認證課程</small></div>
      <div class="sd"><b class="num">${lectN}</b><span>師培講師</span><small>擔任教學能力提升講師</small></div>
    </div>
    <details class="plan-tlist"><summary>教師名單（${T.teachers.length} 人）：姓名、單位、職稱、認證效期、教學能力提升、核心教師、師培講師</summary>
      <div class="table-wrap"><table><thead><tr><th>姓名</th><th>員工編號</th><th>單位</th><th>職稱</th><th>認證效期至</th><th>教學能力提升</th><th>核心教師</th><th>師培講師</th></tr></thead><tbody>
      ${T.teachers.slice(0, 500).map(t => `<tr><td>${esc(t.staff?.name || '')}</td><td><button class="btn-link" type="button" onclick="go('person','${esc(t.emp_id)}')">${esc(t.emp_id)}</button></td><td>${esc(t.dept)}</td><td>${esc(t.staff?.title || '')}</td>
        <td>${esc(t.ve || (t.track_type === 'physician' ? '本年度達標' : ''))}</td><td class="num">${n(t.teach)}</td><td>${(t.core || []).length ? [...new Set(t.core.map(x => x.item))].map(esc).join('、') : ''}</td><td class="num">${Number(t.lect) > 0 ? n(t.lect) + ' 小時' : ''}</td></tr>`).join('')}
      </tbody></table></div>${T.teachers.length > 500 ? '<p class="hint">僅顯示前 500 人，完整名單請按「下載教師名單」。</p>' : ''}
      <button class="btn btn-ghost" type="button" id="planTeacherCsv">下載教師名單（CSV）</button></details></div>`;
  const section = s => {
    const sd = s.items.filter(i => c.items[i[0]] && c.items[i[0]].done).length;
    return `<details class="plan-sec" ${s.k === '3' || sd < s.items.length ? 'open' : ''}><summary><b>${esc(s.t)}</b><span class="pill ${sd === s.items.length ? 'valid' : 'expiring'}">${sd} / ${s.items.length}</span></summary>
      ${s.k === '1' ? `<div class="plan-leaders">${leaders}</div>` : ''}
      ${s.teachers ? teacherPanel : ''}
      ${s.items.map(([k, t, desc]) => { const v = c.items[k] || {}; return `<div class="plan-item ${v.done ? 'done' : ''}">
        <label class="plan-check"><input type="checkbox" data-done="${k}" ${v.done ? 'checked' : ''} ${editable ? '' : 'disabled'}><b>${k.slice(1)}. ${esc(t)}</b></label>
        <p class="hint">${esc(desc)}</p>
        <textarea data-text="${k}" rows="3" ${editable ? '' : 'disabled'} placeholder="填寫本計畫的做法、文件或連結">${esc(v.text || '')}</textarea></div>`; }).join('')}
    </details>`;
  };
  $('content').innerHTML = `
    <section class="card plan-head">
      ${isAdmin() ? '<button class="btn-link" type="button" onclick="state.planId=null;renderPlanPage()">← 計畫書列表</button>' : ''}
      <h3><input id="planTitle" value="${esc(plan.title)}" ${editable ? '' : 'disabled'} style="font-size:18px;font-weight:800"></h3>
      <div class="filters" style="align-items:center"><span class="pill ${PLAN_STATUS_PILL[plan.status] || ''}">${esc(plan.status)}</span>
        <span>範圍：${esc(scopeName(plan.scope_key))}${(c.scope_units || []).length ? `（${c.scope_units.length} 個監測單位）` : ''}</span>
        <span class="num">完成 <b>${done}</b> / ${total} 項</span></div>
      <div class="cap-bar"><i style="width:${done / total * 100}%"></i></div>
      ${plan.review_comment ? `<div class="attention">師培中心審查意見：${esc(plan.review_comment)}</div>` : ''}
      <p class="hint">依醫策會「訓練計畫書模板」九大項目逐項填寫並勾選完成；「三、教學師資」的教師名單與教師發展由系統依本計畫範圍自動帶入。</p>
      <div class="filters">
        ${editable && !isAdmin() ? '<button class="btn btn-ghost" type="button" id="planSave">儲存草稿</button><button class="btn btn-primary" style="width:auto" type="button" id="planSubmit">送出審查</button>' : ''}
        ${isAdmin() && !plan._new ? `<input id="planCm" placeholder="審查意見（選填）" style="flex:1"><button class="btn btn-primary" style="width:auto" type="button" onclick="reviewPlan(${Number(plan.id)},true)">通過</button><button class="btn btn-ghost" type="button" onclick="reviewPlan(${Number(plan.id)},false)">退回修改</button>` : ''}
        <button class="btn btn-ghost" type="button" onclick="window.print()">列印／存成 PDF</button>
      </div></section>
    ${PLAN_TEMPLATE.map(section).join('')}`;
  const collect = () => {
    const items = {};
    PLAN_ITEMS.forEach(k => { items[k] = { done: !!document.querySelector(`[data-done="${k}"]`)?.checked, text: document.querySelector(`[data-text="${k}"]`)?.value || '' }; });
    const extra = {}; document.querySelectorAll('[data-f]').forEach(i => { extra[i.dataset.f] = i.value.trim(); });
    return { title: $('planTitle').value, content: { ...c, ...extra, items } };
  };
  const save = submit => async () => {
    if (submit && planDone(collect().content) < total && !confirm(`還有 ${total - planDone(collect().content)} 項未勾選完成，仍要送出審查嗎？`)) return;
    const body = collect();
    const d = await act('plan.save', { academic_year: plan.academic_year, title: body.title, content: body.content, submit });
    if (d) { state.planId = null; renderPlanPage(); }
  };
  if ($('planSave')) $('planSave').onclick = save(false);
  if ($('planSubmit')) $('planSubmit').onclick = save(true);
  if ($('planTeacherCsv')) $('planTeacherCsv').onclick = () => download(`${plan.title}_教師名單.csv`, [['姓名', '員工編號', '單位', '職稱', '認證效期至', '教學能力提升', '核心教師', '師培講師時數'],
    ...T.teachers.map(t => [t.staff?.name, t.emp_id, t.dept, t.staff?.title, t.ve || '', n(t.teach), [...new Set((t.core || []).map(x => x.item))].join('、'), n(t.lect)])]);
}
function reviewPlan(id, approve) { act('plan.review', { id, approve, comment: $('planCm') ? $('planCm').value : '' }, () => { state.planId = null; renderPlanPage(); }); }

// 管理者：各科部／職類的計畫書總覽
async function renderPlanList() {
  const { data: plans } = await sb.from('training_plans').select('id,academic_year,scope_key,title,status,updated_at,submitted_at,content').order('academic_year', { ascending: false }).order('scope_key');
  const list = plans || [];
  $('content').innerHTML = `<section class="card"><h3>訓練計畫書（${list.length} 份）</h3>
    <p class="hint">各科部管理人依醫策會「訓練計畫書模板」九大項目填寫；送審後在這裡審查。完成度＝已勾選完成的查檢項目數。</p>
    <div class="table-wrap"><table><thead><tr><th>學年度</th><th>範圍</th><th>計畫書</th><th>完成度</th><th>狀態</th><th>最後更新</th></tr></thead><tbody>
    ${list.map(p => `<tr><td class="num">${p.academic_year}</td><td>${esc(scopeName(p.scope_key))}</td>
      <td><button class="btn-link" type="button" onclick="state.planId=${Number(p.id)};renderPlanPage()">${esc(p.title)}</button></td>
      <td style="min-width:120px"><div class="cap-bar"><i style="width:${planDone(p.content) / PLAN_ITEMS.length * 100}%"></i></div><small>${planDone(p.content)} / ${PLAN_ITEMS.length}</small></td>
      <td><span class="pill ${PLAN_STATUS_PILL[p.status] || ''}">${esc(p.status)}</span></td><td>${esc(fmtTime(p.updated_at))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">尚無計畫書</td></tr>'}
    </tbody></table></div></section>`;
}

// ---------- 名單 ----------
const ORDER = { expiring: 0, suspended: 1, remedy: 1, eligible: 2, expired: 3, deficient: 4, valid: 5 };
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
  const kpis = isCfd() ? '' : `
    <section class="kpis">
      <button type="button" class="kpi" onclick="pickStatus('')"><b class="num">${list.length}</b><span>所屬人員</span></button>
      <button type="button" class="kpi" style="--tone:var(--success)" onclick="pickStatus('valid')"><b class="num">${count('valid')}</b><span>認證有效／年度達標</span></button>
      <button type="button" class="kpi" style="--tone:var(--secondary)" onclick="pickStatus('can')"><b class="num">${list.filter(r => r.can_apply).length}</b><span>可提報認證 ›</span></button>
      <button type="button" class="kpi" style="--tone:var(--warning)" onclick="pickStatus('expiring')"><b class="num">${count('expiring') + count('remedy') + count('suspended')}</b><span>即將到期、資格暫停或點數尚缺 ›</span></button>
    </section>
    <section class="card"><h3>各職類認證分佈</h3>${LEGEND}${distRows(list)}</section>`;
  $('content').innerHTML = scopeCard() + kpis + `
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
    else if (s === 'expiring') rows = rows.filter(r => ['expiring', 'remedy', 'suspended'].includes(r.status_code));
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

// ---------- 護理部認證概況（取代 Power BI；資料每次同步自動更新）----------
// 範圍：執登職類為護理者；資料列權限決定看得到哪些人（師培中心全院；護理職類管理人依勾選單位；護理部單位主管依所屬單位）
const N_LEVEL = t => { const m = String(t || '').match(/\((NP\d?|N\d?|DN)\)/); return m ? m[1] : (/護理長/.test(t) ? '護理長' : /督導/.test(t) ? '督導' : '其他'); };
async function renderNursing() {
  const list = (await loadList()).filter(r => r.staff?.profession === '護理');
  if (!list.length) { $('content').innerHTML = '<div class="card empty">您的權限範圍內沒有護理人員資料。</div>'; return; }
  const t = today();
  const F = state.nf = state.nf || { area: '', unit: '', level: '', status: '', q: '' };
  const isValid = r => !!(r.ve && r.ve >= t);
  const in12 = (() => { const d = new Date(`${t}T00:00:00`); d.setMonth(d.getMonth() + 12); return d.toISOString().slice(0, 10); })();
  const cls = r => isValid(r) ? (r.ve <= in12 ? 'soon' : 'ok') : r.can_apply ? 'can' : r.status_code === 'expired' ? 'exp' : 'none';
  const CLS = { ok: ['認證有效', 'var(--success)'], soon: ['一年內到期', 'var(--warning)'], can: ['可提報認證', 'var(--secondary)'], exp: ['已過期（保留期）', 'var(--crimson)'], none: ['尚未認證', '#c9d3da'] };
  const area = r => (r.dept || '').startsWith('護理部') ? '護理部' : '非護理部';
  const scoped = list.filter(r => (!F.area || area(r) === F.area));
  const rate = L => L.length ? Math.round(L.filter(isValid).length / L.length * 1000) / 10 : 0;
  const cnt = (L, k) => L.filter(r => cls(r) === k).length;
  // ① 四個大數字
  const V = scoped.filter(isValid).length;
  const kpi = `<section class="kpis">
    <div class="kpi"><b class="num">${scoped.length.toLocaleString()}</b><span>護理人員</span></div>
    <div class="kpi" style="--tone:var(--success)"><b class="num">${V.toLocaleString()}</b><span>持有效認證（${rate(scoped)}%）</span></div>
    <div class="kpi" style="--tone:var(--warning)"><b class="num">${cnt(scoped, 'soon')}</b><span>一年內到期</span></div>
    <div class="kpi" style="--tone:var(--secondary)"><b class="num">${cnt(scoped, 'can')}</b><span>可提報認證</span></div></section>`;
  // ② 全體分布色帶
  const band = `<div class="nb-band">${Object.keys(CLS).map(k => { const v = cnt(scoped, k); return v ? `<i style="flex:${v};background:${CLS[k][1]}" title="${CLS[k][0]} ${v} 人"></i>` : ''; }).join('')}</div>
    <div class="legend">${Object.keys(CLS).map(k => `<span><i style="background:${CLS[k][1]}"></i>${CLS[k][0]} ${cnt(scoped, k)}</span>`).join('')}</div>`;
  // ③ 能階
  const lv = {}; scoped.forEach(r => { const k = N_LEVEL(r.staff?.title); (lv[k] = lv[k] || []).push(r); });
  const LV_ORDER = ['N', 'N1', 'N2', 'N3', 'N4', 'NP', 'NP1', 'NP2', 'DN', '護理長', '督導', '其他'];
  const levels = Object.entries(lv).sort((a, b) => LV_ORDER.indexOf(a[0]) - LV_ORDER.indexOf(b[0]));
  const lvRows = levels.map(([k, L]) => `<button type="button" class="nb-row ${F.level === k ? 'on' : ''}" onclick="state.nf.level=state.nf.level===${esc(JSON.stringify(k))}?'':${esc(JSON.stringify(k))};renderNursing()">
    <span class="nb-l">${esc(k)}</span><span class="nb-t"><i style="width:${rate(L)}%"></i></span><span class="num">${rate(L)}%</span><small>${L.filter(isValid).length} / ${L.length}</small></button>`).join('');
  // ④ 到期月份（未來 24 個月）
  const months = Array.from({ length: 24 }, (_, i) => { const d = new Date(`${t.slice(0, 7)}-01T00:00:00`); d.setMonth(d.getMonth() + i); return d.toISOString().slice(0, 7); });
  const byM = months.map(m => scoped.filter(r => isValid(r) && r.ve.startsWith(m)).length);
  const maxM = Math.max(1, ...byM);
  const exp = `<div class="cs-chart nb-exp" style="grid-template-columns:repeat(24,1fr)">${months.map((m, i) => `<div class="cs-col"><div class="cs-bars"><i class="t" style="height:${byM[i] / maxM * 100}%" title="${Number(m.slice(0, 4)) - 1911}/${Number(m.slice(5))}：${byM[i]} 人到期"></i></div>
    <span class="cs-m">${i % 3 === 0 ? `${Number(m.slice(0, 4)) - 1911}/${Number(m.slice(5))}` : ''}</span><small>${byM[i] || ''}</small></div>`).join('')}</div>`;
  // ⑤ 各單位
  const units = {}; scoped.forEach(r => { (units[r.dept || '（未註明）'] = units[r.dept || '（未註明）'] || []).push(r); });
  const uRows = Object.entries(units).map(([u, L]) => ({ u, n: L.length, v: L.filter(isValid).length, rate: rate(L), soon: cnt(L, 'soon'), can: cnt(L, 'can'), exp: cnt(L, 'exp') }));
  const sortKey = state.nfSort || 'rate';
  uRows.sort((a, b) => sortKey === 'n' ? b.n - a.n : sortKey === 'soon' ? b.soon - a.soon : a.rate - b.rate || b.n - a.n);
  const watch = uRows.filter(u => u.n >= 5).sort((a, b) => a.rate - b.rate).slice(0, 5);
  // ⑥ 人員名單（點單位、能階或狀態篩選）
  const people = scoped.filter(r => (!F.unit || (r.dept || '（未註明）') === F.unit) && (!F.level || N_LEVEL(r.staff?.title) === F.level) && (!F.status || cls(r) === F.status)
    && (!F.q || r.emp_id.toLowerCase().includes(F.q.toLowerCase()) || (r.staff?.name || '').includes(F.q)));
  people.sort((a, b) => (a.dept || '').localeCompare(b.dept || '') || (a.ve || '9').localeCompare(b.ve || '9'));
  const tag = (k, v) => v ? `<b>${esc(k)}</b> ${esc(v)}　<button class="btn-link" type="button" onclick="state.nf.${k === '單位' ? 'unit' : k === '能階' ? 'level' : 'status'}='';renderNursing()">✕</button>` : '';
  $('content').innerHTML = `
    <section class="card"><h3>護理部臨床教師認證概況</h3>
      <div class="filters" style="align-items:center">
        <div class="seg">${[['', '全部護理人員'], ['護理部', '護理部'], ['非護理部', '非護理部單位']].map(([v, s]) => `<button type="button" class="${F.area === v ? 'is-active' : ''}" onclick="state.nf.area='${v}';state.nf.unit='';renderNursing()">${s}</button>`).join('')}</div>
        <button class="btn btn-ghost" type="button" onclick="nursingLink()">複製這頁的連結</button></div>
      <p class="hint">依「執登職類＝護理」統計；資料每次同步自動更新（${esc(fmtTime(list[0].computed_at))}），不必再整理報表。認證率＝持有效臨床教師認證人數 ÷ 護理人員數。</p></section>
    ${kpi}
    <section class="card"><h3>認證狀態分布</h3>${band}</section>
    <section class="cs-two">
      <div class="card"><h3>各能階認證率</h3><p class="hint" style="margin:0 0 6px">點一列可在下方名單篩選。</p>${lvRows}</div>
      <div class="card"><h3>需要關注的單位</h3><p class="hint" style="margin:0 0 6px">5 人以上單位中，認證率最低的 5 個。</p>
        ${watch.map(u => `<button type="button" class="nb-row" onclick="state.nf.unit=${esc(JSON.stringify(u.u))};renderNursing();document.getElementById('nbList').scrollIntoView({behavior:'smooth'})">
          <span class="nb-l" title="${esc(u.u)}">${esc(u.u)}</span><span class="nb-t low"><i style="width:${u.rate}%"></i></span><span class="num">${u.rate}%</span><small>${u.v} / ${u.n}</small></button>`).join('') || '<div class="empty">無</div>'}</div>
    </section>
    <section class="card"><h3>未來 24 個月到期人數</h3>${exp}<p class="hint">提前安排展延：到期當年需完成展延時數。</p></section>
    <section class="card"><h3>各單位（${uRows.length} 個）</h3>
      <div class="filters"><div class="seg">${[['rate', '認證率低→高'], ['n', '人數多→少'], ['soon', '即將到期多→少']].map(([v, s]) => `<button type="button" class="${sortKey === v ? 'is-active' : ''}" onclick="state.nfSort='${v}';renderNursing()">${s}</button>`).join('')}</div>
        <button class="btn btn-ghost" type="button" id="nbUnitCsv">下載單位統計</button></div>
      <div class="table-wrap nb-units"><table><thead><tr><th>單位</th><th>人數</th><th>有效認證</th><th>認證率</th><th>一年內到期</th><th>可提報</th><th>已過期</th></tr></thead><tbody>
      ${uRows.map(u => `<tr><td><button class="btn-link" type="button" onclick="state.nf.unit=${esc(JSON.stringify(u.u))};renderNursing();document.getElementById('nbList').scrollIntoView({behavior:'smooth'})">${esc(u.u)}</button></td>
        <td class="num">${u.n}</td><td class="num">${u.v}</td><td><div class="nb-cell"><span class="nb-t ${u.rate < 30 ? 'low' : ''}"><i style="width:${u.rate}%"></i></span><span class="num">${u.rate}%</span></div></td>
        <td class="num">${u.soon || ''}</td><td class="num">${u.can || ''}</td><td class="num">${u.exp || ''}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card" id="nbList"><h3>人員名單（${people.length} 人）</h3>
      <div class="filters" style="align-items:center">
        <select id="nbSt" style="width:auto"><option value="">所有狀態</option>${Object.keys(CLS).map(k => `<option value="${k}" ${F.status === k ? 'selected' : ''}>${CLS[k][0]}</option>`).join('')}</select>
        <input id="nbQ" type="search" placeholder="員工編號或姓名" value="${esc(F.q)}" style="flex:1;min-width:160px">
        <button class="btn btn-ghost" type="button" id="nbCsv">下載名單</button></div>
      ${F.unit || F.level ? `<p class="hint">篩選：${tag('單位', F.unit)}${tag('能階', F.level)}</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th>員工編號</th><th>單位</th><th>職稱</th><th>狀態</th><th>效期至</th><th>教學點數</th><th>說明</th></tr></thead><tbody>
      ${people.slice(0, 500).map(r => `<tr><td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${empLabel(r.emp_id)}</button></td><td>${esc(r.dept)}</td><td>${esc(r.staff?.title || '')}</td>
        <td><span class="pill" style="background:${CLS[cls(r)][1]};color:${cls(r) === 'none' ? 'var(--text)' : '#fff'}">${CLS[cls(r)][0]}</span></td><td>${esc(r.valid_end || '')}</td>
        <td class="num">${esc(r.teach)} / ${esc(r.need)}</td><td class="reason">${esc(r.reason)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">沒有符合的人員</td></tr>'}</tbody></table></div>
      ${people.length > 500 ? '<p class="hint">畫面顯示前 500 人，完整名單請下載。</p>' : ''}</section>`;
  $('nbSt').onchange = e => { F.status = e.target.value; renderNursing(); };
  $('nbQ').onchange = e => { F.q = e.target.value.trim(); renderNursing(); };
  $('nbCsv').onclick = () => download(`護理部認證名單_${today()}.csv`, [['員工編號', '姓名', '單位', '職稱', '能階', '狀態', '效期至', '教學點數', '應達', '說明'],
    ...people.map(r => [r.emp_id, nameOf(r.emp_id), r.dept, r.staff?.title || '', N_LEVEL(r.staff?.title), CLS[cls(r)][0], r.valid_end || '', r.teach, r.need, r.reason])]);
  $('nbUnitCsv').onclick = () => download(`護理部各單位認證率_${today()}.csv`, [['單位', '人數', '有效認證', '認證率(%)', '一年內到期', '可提報', '已過期'],
    ...uRows.map(u => [u.u, u.n, u.v, u.rate, u.soon, u.can, u.exp])]);
}
async function nursingLink() {
  const url = `${location.origin}${location.pathname}#nursing`;
  try { await navigator.clipboard.writeText(url); toast('已複製連結：' + url); } catch (e) { prompt('請複製這個連結：', url); }
}

// ---------- 完成率：依身分（PGY、住院醫師、研究醫師、主治醫師、各醫事職類）看應完成的比例，勾選未完成者寄信提醒 ----------
// 「已完成」：醫師與每年規範者＝今年度時數達標；醫事認證教師＝本次應完成的點數已達標（或已可提報）；PGY 醫師不列管，以「今年有修課」表示參與
const PG_DOC = ['PGY醫師', '住院醫師（第一、二年）', '住院醫師（第三年以上）', '研究醫師／完訓醫師', '主治醫師'];
const pgGroup = r => {
  if (r.track_type === 'exempt') return /PGY/.test(r.cat || '') ? 'PGY醫師' : null;
  if (r.track_type === 'physician') return r.cat || '主治醫師';
  if (r.track_type === 'annual') return '其他人員（每年時數）';
  return profGroup(r);
};
const pgDone = r => {
  if (r.track_type === 'exempt') return Number(r.tot) > 0;
  if (r.track_type === 'physician' || r.track_type === 'annual') return r.cp === 'true';
  if (r.can_apply) return true;
  if (['suspended', 'expired', 'remedy'].includes(r.status_code)) return false;
  return Number(r.gap_t || 0) <= 0 && Number(r.gap_b || 0) <= 0 && Number(r.gap_a || 0) <= 0;
};
const mailDomain = () => { try { return localStorage.getItem('cfdMailDomain') || 'mail.cmuh.org.tw'; } catch (e) { return 'mail.cmuh.org.tw'; } };
const mailOf = emp => `${String(emp).trim()}@${mailDomain()}`;

async function renderProgress() {
  const list = await loadList();
  const P = state.pg = state.pg || { group: '', show: 'todo', dept: '', sel: new Set() };
  const rows = list.filter(r => pgGroup(r) && (!P.dept || r.dept === P.dept));
  const groups = {};
  rows.forEach(r => { const g = pgGroup(r); (groups[g] = groups[g] || { all: [], done: [] }).all.push(r); if (pgDone(r)) groups[g].done.push(r); });
  const order = [...PG_DOC.filter(g => groups[g]), ...Object.keys(groups).filter(g => !PG_DOC.includes(g)).sort((a, b) => groups[b].all.length - groups[a].all.length)];
  const depts = [...new Set(list.filter(pgGroup).map(r => r.dept).filter(Boolean))].sort();
  const pct = g => Math.round(groups[g].done.length / groups[g].all.length * 100);
  const totAll = rows.filter(r => r.track_type !== 'exempt'), totDone = totAll.filter(pgDone);
  const card = g => {
    const G = groups[g], p = pct(g), todo = G.all.length - G.done.length;
    return `<button type="button" class="pg-card ${P.group === g ? 'on' : ''} ${g === 'PGY醫師' ? 'na' : ''}" onclick="state.pg.group=${esc(JSON.stringify(g))};state.pg.sel=new Set();renderProgress()">
      <span class="pg-name">${esc(g)}</span>
      <span class="pg-pct num">${p}<small>%</small></span>
      <span class="pg-bar"><i style="width:${p}%" class="${p >= 80 ? 'ok' : p >= 50 ? 'mid' : 'low'}"></i></span>
      <span class="pg-n">${g === 'PGY醫師' ? '今年有修課' : '已完成'} <b>${G.done.length}</b> / ${G.all.length}${todo ? `・<em>${g === 'PGY醫師' ? '未修課' : '未完成'} ${todo}</em>` : ''}</span></button>`;
  };
  const sec = (title, list) => !list.length ? '' : `<div class="group-label">${title}</div><div class="pg-grid">${list.map(card).join('')}</div>`;
  // 下方名單：選定的身分
  const G = P.group && groups[P.group];
  let table = '';
  if (G) {
    const shown = (P.show === 'todo' ? G.all.filter(r => !pgDone(r)) : P.show === 'done' ? G.done : G.all)
      .sort((a, b) => (a.dept || '').localeCompare(b.dept || '') || a.emp_id.localeCompare(b.emp_id));
    state.pgShown = shown;
    // 管理者：顯示每人被提醒過幾次（使用紀錄只有管理者讀得到）
    let reminded = new Map();
    if (isAdmin() && shown.length) {
      const ids = shown.map(r => r.emp_id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await sb.from('audit_logs').select('target,at').eq('action', '寄送提醒').in('target', ids.slice(i, i + 200)).order('at', { ascending: false });
        (data || []).forEach(l => { const x = reminded.get(l.target) || { n: 0, last: l.at }; x.n++; reminded.set(l.target, x); });
      }
    }
    const allOn = shown.length && shown.every(r => P.sel.has(r.emp_id));
    table = `<section class="card" id="pgList"><h3>${esc(P.group)}｜${P.show === 'todo' ? '未完成' : P.show === 'done' ? '已完成' : '全部'}名單（${shown.length} 人）</h3>
      <div class="filters" style="align-items:center"><div class="seg">${[['todo', '未完成'], ['done', '已完成'], ['all', '全部']].map(([v, t]) => `<button type="button" class="${P.show === v ? 'is-active' : ''}" onclick="state.pg.show='${v}';state.pg.sel=new Set();renderProgress()">${t}</button>`).join('')}</div>
        <span class="hint" style="margin:0">勾選後可在下方寄信提醒、複製信箱或下載名單。</span></div>
      <div class="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="全選" ${allOn ? 'checked' : ''} onchange="pgAll(this.checked)"></th><th>員工編號</th><th>單位</th><th>職稱</th><th>點數</th><th>狀態</th><th>說明</th>${isAdmin() ? '<th>已提醒</th>' : ''}</tr></thead><tbody>
      ${shown.slice(0, 1000).map(r => { const m = reminded.get(r.emp_id); return `<tr><td><input type="checkbox" ${P.sel.has(r.emp_id) ? 'checked' : ''} onchange="pgPick('${esc(r.emp_id)}',this.checked)"></td>
        <td><button class="btn-link" type="button" onclick="go('person','${esc(r.emp_id)}')">${empLabel(r.emp_id)}</button></td><td>${esc(r.dept)}</td><td>${esc(r.staff?.title || '')}</td>
        <td class="num">${esc(hoursOf(r))} / ${esc(r.need)}</td><td><span class="pill ${esc(r.status_code)}">${esc(String(r.status || '').replace(/^[^\p{L}\p{N}]+/u, ''))}</span></td><td class="reason">${esc(r.reason)}</td>
        ${isAdmin() ? `<td>${m ? `${m.n} 次<br><small>${esc(fmtTime(m.last).split(' ')[0])}</small>` : '—'}</td>` : ''}</tr>`; }).join('') || '<tr><td colspan="8" class="empty">沒有人員</td></tr>'}
      </tbody></table></div>${shown.length > 1000 ? '<p class="hint">畫面顯示前 1000 人，請用上方單位篩選縮小範圍。</p>' : ''}</section>`;
  }
  const n = P.sel.size;
  $('content').innerHTML = `
    <section class="card"><h3>各身分完成率｜${Number(today().slice(0, 4)) - 1911} 年度</h3>
      <div class="filters" style="align-items:center"><select id="pgDept" style="width:auto"><option value="">${isCfd() ? '全院所有單位' : '所屬全部單位'}</option>${depts.map(d => `<option ${d === P.dept ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
        <span class="hint" style="margin:0">點身分卡片看名單。醫師與每年規範者：今年度時數達標；醫事認證教師：本次應完成的點數已達標或可提報；PGY 醫師不列管，以今年是否修課表示參與。</span></div>
      <div class="pg-total"><b class="num">${totAll.length ? Math.round(totDone.length / totAll.length * 100) : 0}%</b><span>整體完成率（不含 PGY）<br><small>${totDone.length} / ${totAll.length} 人</small></span></div>
    </section>
    <section class="card">${sec('醫師（ED-026 第四條）', order.filter(g => PG_DOC.includes(g)))}${sec('醫事職類與其他人員', order.filter(g => !PG_DOC.includes(g)))}
      ${order.length ? '' : '<div class="empty">沒有資料</div>'}</section>
    ${table}
    <div class="pg-act ${n ? 'on' : ''}"><span>已選 <b>${n}</b> 人</span>
      <button class="btn btn-primary" type="button" onclick="pgMail()">寄信提醒</button>
      <button class="btn btn-ghost" type="button" onclick="pgCopy('mail')">複製信箱</button>
      <button class="btn btn-ghost" type="button" onclick="pgCopy('emp')">複製員工編號</button>
      <button class="btn btn-ghost" type="button" onclick="pgCsv()">下載名單（可合併列印）</button>
      <button class="btn-link" type="button" onclick="pgDomain()">信箱：員工編號@${esc(mailDomain())}</button></div>`;
  $('pgDept').onchange = e => { P.dept = e.target.value; P.sel = new Set(); renderProgress(); };
}
function pgPick(emp, on) { on ? state.pg.sel.add(emp) : state.pg.sel.delete(emp); pgBar(); }
function pgAll(on) { (state.pgShown || []).forEach(r => (on ? state.pg.sel.add(r.emp_id) : state.pg.sel.delete(r.emp_id))); renderProgress().then(() => $('pgList') && $('pgList').scrollIntoView()); }
function pgBar() { const b = document.querySelector('.pg-act'); if (!b) return; b.classList.toggle('on', state.pg.sel.size > 0); b.querySelector('b').textContent = state.pg.sel.size; }
const pgSelected = () => (state.list || []).filter(r => state.pg.sel.has(r.emp_id));
function pgDomain() {
  const v = prompt('院內信箱的網域（@ 後面的部分）。寄信時以「員工編號@網域」組成收件人。', mailDomain());
  if (v == null) return;
  try { localStorage.setItem('cfdMailDomain', v.trim().replace(/^@/, '')); } catch (e) { /* 無法儲存時本次仍用預設 */ }
  renderProgress();
}
async function pgCopy(kind) {
  const list = pgSelected(); if (!list.length) return toast('請先勾選人員', false);
  const text = list.map(r => (kind === 'mail' ? mailOf(r.emp_id) : r.emp_id)).join(kind === 'mail' ? '; ' : '\n');
  try { await navigator.clipboard.writeText(text); toast(`已複製 ${list.length} 人的${kind === 'mail' ? '信箱' : '員工編號'}`); } catch (e) { prompt('請手動複製：', text); }
}
function pgCsv() {
  const list = pgSelected(); if (!list.length) return toast('請先勾選人員', false);
  download(`完成率提醒名單_${state.pg.group || ''}_${today()}.csv`, [['員工編號', '姓名', '信箱', '單位', '職稱', '身分', '目前點數', '應完成', '狀態', '說明'],
    ...list.map(r => [r.emp_id, nameOf(r.emp_id), mailOf(r.emp_id), r.dept, r.staff?.title || '', pgGroup(r), hoursOf(r), r.need, String(r.status || '').replace(/^[^\p{L}\p{N}]+/u, ''), r.reason])]);
}
// 以使用者自己的郵件程式（Outlook）開啟新郵件，收件人放密件副本；每批 25 人，避免連結過長（Outlook 約 2000 字元上限）
function pgMail() {
  const list = pgSelected(); if (!list.length) return toast('請先勾選人員', false);
  const link = `${location.origin}${location.pathname}#lookup`;
  const yr = Number(today().slice(0, 4)) - 1911;
  const subject = `【師培中心】${yr} 年度臨床教師師培時數提醒`;
  const body = `您好：\n\n依師培中心系統資料（${today()}），您 ${yr} 年度應完成的師培時數尚未達標。\n請至下列網址，以「員工編號＋身分證後 4 碼」查詢個人進度與尚缺項目：\n${link}\n\n如已完成或資料有誤，請點查詢頁右下角的小機器人反映，或洽師培中心。\n\n師資培育中心 敬上`;
  const batches = []; for (let i = 0; i < list.length; i += 25) batches.push(list.slice(i, i + 25));
  const href = b => `mailto:?bcc=${encodeURIComponent(b.map(r => mailOf(r.emp_id)).join(';'))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const record = (b, i) => api('notify.log', { emp_ids: b.map(r => r.emp_id), channel: 'email', group: `${state.pg.group || ''}${batches.length > 1 ? `｜第 ${i + 1} 批` : ''}` }).catch(() => {});
  let dlg = $('pgDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'pgDlg'; document.body.appendChild(dlg); dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); }
  dlg.innerHTML = `<div class="dlg-body"><div class="dlg-head"><h3>寄信提醒（${list.length} 人）</h3><button class="btn btn-ghost" type="button" onclick="$('pgDlg').close()">關閉</button></div>
    <p class="hint">按下按鈕會用您電腦上的郵件程式（Outlook）開新郵件，收件人放在<b>密件副本</b>，彼此看不到。請確認內容後再自行按「傳送」。系統會記錄提醒日期，方便之後比對成效。</p>
    <div class="pg-batches">${batches.map((b, i) => `<a class="btn btn-primary" href="${href(b)}" data-i="${i}">開啟郵件${batches.length > 1 ? `：第 ${i + 1} 批（${b.length} 人）` : ''}</a>`).join('')}</div>
    <div class="group-label">信件內容（可在郵件程式中修改）</div><pre class="pg-preview">主旨：${esc(subject)}\n\n${esc(body)}</pre></div>`;
  dlg.querySelectorAll('a[data-i]').forEach(a => { a.onclick = () => { const i = Number(a.dataset.i); if (!a.dataset.done) { a.dataset.done = '1'; record(batches[i], i); } a.classList.replace('btn-primary', 'btn-ghost'); a.textContent += '　✓ 已開啟'; }; });
  dlg.showModal();
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
    // 新制＋過渡規定：與伺服器 status-runner.nextPeriod 相同（效期一律止於 12/31，總長不超過四年）
    const years = (state.rules.general || {}).cert_validity_years || 4;
    const pad = n => String(n).padStart(2, '0');
    const prev = r.ve || r.le;   // 新制計算結果中的迄日已套用「延至當年 12/31」
    if (prev && prev >= t) {
      const ey = Number(prev.slice(0, 4));
      if (prev.slice(5) === '12-31') { start = `${ey + 1}-01-01`; end = `${ey + years}-12-31`; }
      else { const d = new Date(`${prev}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); start = d.toISOString().slice(0, 10); end = `${ey + years - 1}-12-31`; }
    } else if (prev) {
      const i = Number(t.slice(0, 4)) * 12 + Number(t.slice(5, 7));
      start = `${Math.floor(i / 12)}-${pad((i % 12) + 1)}-01`; end = `${Math.floor(i / 12) + years - 1}-12-31`;
    } else {
      const cy = Number(t.slice(0, 4));
      const qs = ((state.rules.transition || {}).quarterly_starts || ['01-01']).map(q => `${cy}-${q}`).filter(d => d > t).sort();
      start = qs[0] || `${cy + 1}-01-01`; end = `${Number(start.slice(0, 4)) + years - 1}-12-31`;
    }
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
// 民國日期（115/10/1）⇄ 西元日期（2026-10-01）
const rocToAd = s => { const p = String(s || '').split('/'); return p.length === 3 ? `${Number(p[0]) + 1911}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}` : ''; };
const adToRoc = s => `${Number(s.slice(0, 4)) - 1911}/${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

// 衛福部範本第二個工作表「學公會」代碼表
const ASSOC = [['C000001', '中華民國醫事放射師公會全國聯合會'], ['C000002', '中華民國醫事放射學會'], ['C000003', '中華民國醫事檢驗公會全國聯合會'], ['C000004', '台灣助產學會'],
  ['C000005', '社團法人台灣呼吸治療學會'], ['C000006', '社團法人中華民國物理治療師公會全國聯合會'], ['C000007', '社團法人台灣醫事檢驗學會'], ['C000008', '社團法人臺灣臨床藥學會'],
  ['C000009', '社團法人臺灣職能治療學會'], ['C000010', '社團法人臺灣物理治療學會'], ['C000011', '臺灣臨床心理學會'], ['C000012', '中華民國臨床心理師公會全國聯合會'],
  ['C000013', '中華民國藥師公會全國聯合會'], ['C000014', '台灣護理學會'], ['C000015', '中華民國牙體技術學會'], ['C000016', '中華民國諮商心理師公會全國聯合會'],
  ['C000017', '中華民國營養師公會全國聯合會'], ['C000018', '台灣聽力語言學會']];

async function downloadPec(rows, ref, label, kindOf) {
  try {
    const roster = await pickRoster();
    const general = state.rules.general || {};
    const upload = [], review = [], missing = [];
    rows.forEach(r => {
      const who = roster.get(r.emp_id.toLowerCase()), p = r.period || certPeriod(r, ref), prof = PEC_NAME[r.staff?.profession] || r.staff?.profession;
      if (!who || !/^[A-Z][0-9A-Z]\d{8}$/.test(who.id)) return missing.push(r.emp_id);
      // 「取得認證機構代碼」是醫事機構代碼 1317050017A（醫策會資料中的 157 是平台內部代碼，不可用）
      const code = general.pec_org_code && general.pec_org_code !== '157' ? general.pec_org_code : '1317050017A';
      upload.push({ '姓名': who.name, '身分證字號': who.id, '職類': prof, '教師認證效期起日': p.start, '教師認證效期迄日': p.end, '取得認證機構代碼': code, '取得認證機構名稱': general.pec_org_name || '中國醫藥大學附設醫院' });
      review.push({ '員工編號': r.emp_id, '姓名': who.name, '單位': r.dept, '職稱': r.staff?.title || '', '職類': prof, '申請別': kindOf(r), '教學能力提升點數': r.teach, '應達點數': r.need, '原效期迄日': r.valid_end || '', '提報效期起日': p.start, '提報效期迄日': p.end });
    });
    if (!upload.length) throw new Error('名冊中找不到這些人員的資料');
    const stamp = today().replace(/-/g, '');
    // 與衛福部「師資認證_認證教師」範本相同：工作表1（7 欄，全部文字）＋「學公會」代碼表，存成 .xls
    const a = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(a, XLSX.utils.json_to_sheet(upload, { header: ['姓名', '身分證字號', '職類', '教師認證效期起日', '教師認證效期迄日', '取得認證機構代碼', '取得認證機構名稱'] }), '工作表1');
    XLSX.utils.book_append_sheet(a, XLSX.utils.aoa_to_sheet([['代碼', '名稱'], ...ASSOC]), '學公會');
    XLSX.writeFile(a, `師資認證_認證教師_${stamp}.xls`, { bookType: 'biff8' });
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
      ${batchPeriod ? `<div class="filters" style="align-items:center">
        <span style="font-weight:700">認證效期</span>
        <label style="margin:0">起日 <input id="bStart" type="date" value="${esc(rocToAd(batchPeriod.start))}" style="display:inline-block;width:auto"></label>
        <label style="margin:0">迄日 <input id="bEnd" type="date" value="${esc(rocToAd(batchPeriod.end))}" style="display:inline-block;width:auto"></label>
        <small class="hint" style="margin:0">預設為次月 1 日起整兩年，可直接修改；修改後下載的名單一律用這組效期。</small></div>
        <div class="note">已認證教師須在效期屆滿前 2 年內滿 8 點；新增須在 2 年內滿 10 點且年資達標。</div>` : ''}
      <div class="filters">
        <button class="btn btn-primary" style="width:auto" type="button" id="bPec" ${batchRows.length ? '' : 'disabled'}>下載衛福部認證申請名單（Excel）</button>
        <button class="btn btn-ghost" type="button" id="bCsv" ${batchRows.length ? '' : 'disabled'}>下載名單（僅員工編號）</button>
      </div>
      <div class="note">下載的「師資認證_認證教師_日期.xls」與衛福部範本相同：姓名、身分證字號、職類、教師認證效期起日、教師認證效期迄日、取得認證機構代碼（1317050017A）、取得認證機構名稱，並附「學公會」代碼表；另附一份核對清冊。
        姓名與身分證字號取自您電腦上的員工名冊（按下後選擇 user….xlsx），只在這個瀏覽器分頁內讀取，不會上傳。</div>
    </section>`;
  const wireBatch = () => {
    if (!batchOn) return;
    $('bMonth').onchange = e => { state.batchMonth = e.target.value; renderExpiry(); };
    $('bPec').onclick = () => {
      // 承辦人可修改整批的認證效期；有填就一律採用
      const s = $('bStart') && $('bStart').value, e = $('bEnd') && $('bEnd').value;
      if (s && e && e < s) return toast('迄日不可早於起日', false);
      const period = s && e ? { start: adToRoc(s), end: adToRoc(e) } : null;
      downloadPec(period ? state.batch.rows.map(r => ({ ...r, period })) : state.batch.rows, state.batch.ref, state.batch.label, state.batch.kindOf);
    };
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
          ${exportable ? '<button class="btn btn-primary" style="width:auto" type="button" id="pecBtn">下載勾選者的衛福部認證申請名單（Excel）</button>'
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

// 教職 3 年 16 小時：符合 PBL、OSCE、case study、臨床技能等但尚未認證的 tutor 課程（課程層級；含講師姓名的清單在承辦人本機 out\）
async function tutorPendingCard() {
  const { data } = await sb.from('settings').select('value').eq('key', 'tutor_pending').maybeSingle();
  const v = data && data.value; const list = (v && v.courses) || [];
  if (!list.length) return '';
  const n = x => Math.round((Number(x) || 0) * 10) / 10;
  state.tutorPending = list;
  return `<section class="card batch"><h3>教職 3 年 16 小時：待認證的 tutor 課程（${list.length} 場次）</h3>
    <p class="hint">課程名稱或類別符合 PBL、OSCE、case study、臨床技能、臨床診斷學與實習，但認證項目尚未登錄「教職3年16小時」。系統已先計入申請人時數，請陸續在教學系統完成認證。
      採計 ${esc(v.from)} 起；含講師姓名的明細在您電腦的 out\\教職3年16小時_待認證_日期.xlsx。</p>
    <details><summary>展開清單</summary><div class="table-wrap"><table><thead><tr><th>開課日期</th><th>課程編號</th><th>課程名稱</th><th>類別</th><th>tutor 人次</th><th>授課積分合計</th></tr></thead><tbody>
      ${list.slice(0, 300).map(c => `<tr><td>${esc(c.d)}</td><td>${esc(c.no)}</td><td style="white-space:normal">${esc(c.t)}</td><td>${esc(c.cat)}</td><td class="num">${c.tutors}</td><td class="num">${n(c.h)}</td></tr>`).join('')}</tbody></table></div>
      <button class="btn btn-ghost" type="button" onclick="download('教職3年16小時_待認證課程.csv',[['開課日期','課程編號','課程名稱','類別','tutor人次','授課積分合計'],...state.tutorPending.map(c=>[c.d,c.no,c.t,c.cat,c.tutors,c.h])])">下載 CSV</button></details></section>`;
}

// ---------- 審查（管理者） ----------
async function renderReview() {
  const { data: apps, error } = await sb.from('applications').select('*, staff!applications_emp_id_fkey(dept,title,profession)').order('submitted_at', { ascending: false }).limit(200);
  if (error) throw error;
  // 待審申請的預設認證效期（與系統規則相同：舊制次月 1 日起整兩年；展延自原效期屆滿之次月起）；承辦人可修改
  const pendEmps = [...new Set(apps.filter(a => a.status === '審核中' && a.app_type !== '他院轉任採認').map(a => a.emp_id))];
  const veOf = {};
  if (pendEmps.length) {
    const { data: st } = await sb.from('cert_status').select(`emp_id,ve:${D()}->activeCertificate->>valid_end`).in('emp_id', pendEmps);
    (st || []).forEach(s => { veOf[s.emp_id] = s.ve; });
  }
  const defPeriod = a => { const p = certPeriod({ ve: veOf[a.emp_id] || null }, today()); return { start: rocToAd(p.start), end: rocToAd(p.end) }; };
  const periodInputs = a => {
    if (a.app_type === '他院轉任採認') return `<small>核准後採認原效期：</small><br>
      <input id="vs-${esc(a.id)}" type="date" value="${esc(a.ext_valid_start || '')}" style="width:150px"> ～<br><input id="ve-${esc(a.id)}" type="date" value="${esc(a.ext_valid_end || '')}" style="width:150px"><br>`;
    const p = defPeriod(a);
    return `<small>認證效期（可修改）：</small><br>
      <input id="vs-${esc(a.id)}" type="date" value="${esc(p.start)}" style="width:150px"> ～<br><input id="ve-${esc(a.id)}" type="date" value="${esc(p.end)}" style="width:150px"><br>`;
  };
  const row = a => `<tr>
    <td><button class="btn-link" type="button" onclick="go('person','${esc(a.emp_id)}')">${empLabel(a.emp_id)}</button><br><small>${esc(a.staff?.dept || '')}</small></td>
    <td>${esc(a.app_type)}<br><small>${esc(fmtTime(a.submitted_at))}${a.submitted_by && a.submitted_by !== a.emp_id ? `<br>由 ${esc(a.submitted_by)} 提報` : ''}</small></td>
    <td class="reason">${a.app_type === '他院轉任採認'
      ? `<span class="pill eligible">他院轉任・待查證</span><br>原認證醫院：<b>${esc(a.ext_org || '')}</b>${a.ext_cert_no ? `（證號 ${esc(a.ext_cert_no)}）` : ''}
        <br>原效期：${esc(a.ext_valid_start || '')}～${esc(a.ext_valid_end || '')}${a.ext_valid_end && a.ext_valid_end >= today() ? ' <span class="pill valid">仍有效・採認原效期</span>' : ' <span class="pill expiring">已屆滿・視為展延</span>'}
        ${a.attachment_path ? `<br><button class="btn btn-ghost" type="button" style="margin-top:6px" onclick="viewCert('${esc(a.attachment_path)}')">查看證書</button>` : a.status !== '審核中' ? '<br><small>證書檔已於審查後刪除</small>' : ''}`
      : `<span class="pill ${a.auto_check?.eligible ? 'valid' : 'expired'}">系統檢核${a.auto_check?.eligible ? '符合' : '未符合'}</span>
      ${esc(a.auto_check?.reason || '')}<br>教學 ${esc(a.auto_check?.teaching)}・基礎 ${esc(a.auto_check?.basic)}・進階 ${esc(a.auto_check?.advanced)}（${esc(a.auto_check?.window || '')}）
      ${a.external_hours ? `<br>院外時數：${esc(a.external_hours)}` : ''}
      ${Number(a.service_years) > 0 ? `<br>申報教學醫院年資：<b>${esc(a.service_years)}</b> 年${a.status === '審核中' ? ` <button class="btn-link" type="button" title="人事資料再到職或留停者年資會偏低；查證後可採認申報年資" onclick="setSeniority('${esc(a.emp_id)}', false, '${esc(a.service_years)}', '依認證申請表申報')">採認此年資</button>` : ''}` : ''}`}${a.memo ? `<br>備註：${esc(a.memo)}` : ''}</td>
    <td>${a.status === '審核中' ? `${periodInputs(a)}<input id="cm-${esc(a.id)}" placeholder="審查意見（選填）" style="width:150px"><br>
        <button class="btn btn-primary" style="width:auto;padding:6px 12px" type="button" onclick="review('${esc(a.id)}',true)">核准</button>
        <button class="btn btn-ghost" type="button" onclick="review('${esc(a.id)}',false)">退回</button>`
      : `<span class="pill ${a.status === '已通過' ? 'valid' : 'expired'}">${esc(a.status)}</span><br><small>${a.valid_start ? `${esc(a.valid_start)}～${esc(a.valid_end)}` : esc(a.review_comment || '')}</small>`}</td></tr>`;
  // 已核准、待上傳醫策會：依核准月份整理，一鍵產生上傳檔（效期用核准時寫入的效期）
  // 他院轉任採認的認證不是本院取得，不列入本院向衛福部申請的名單
  const approved = apps.filter(a => a.status === '已通過' && a.valid_start && a.app_type !== '他院轉任採認');
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
      <button class="btn btn-primary" style="width:auto" type="button" onclick="downloadPec(state.approvedRows, undefined, '核准名單', r => r.app_type)" ${amRows.length ? '' : 'disabled'}>下載衛福部認證申請名單（Excel）</button></div>
    <div class="note">效期用您核准時填寫的效期。按下後請選擇您電腦上的員工名冊（只在瀏覽器內讀取，不會上傳）。他院轉任採認者不列入本名單。</div></section>`;
  $('content').innerHTML = approvedCard + await tutorPendingCard() + `<section class="card"><h3>認證申請（${apps.filter(a => a.status === '審核中').length} 件待審）</h3>
    <div class="note">核准後系統會寫入認證效期並重新計算該員狀態；提報醫策會 PEC 平台仍需在您的電腦上產生提報檔（雲端沒有身分證字號）。</div>
    <div class="table-wrap"><table><thead><tr><th>員工編號</th><th>申請</th><th>系統檢核</th><th>審查</th></tr></thead><tbody>
    ${apps.map(row).join('') || '<tr><td colspan="4" class="empty">目前沒有申請</td></tr>'}</tbody></table></div></section>`;
  if ($('amSel')) $('amSel').onchange = e => { state.approvedMonth = e.target.value; renderReview(); };
}
function review(id, approve) {
  const s = $(`vs-${id}`) ? $(`vs-${id}`).value : '', e = $(`ve-${id}`) ? $(`ve-${id}`).value : '';
  if (approve && (!s || !e)) return toast('請填寫認證效期起日與迄日', false);
  if (approve && e < s) return toast('迄日不可早於起日', false);
  act('cert.review', { id, approve, comment: $(`cm-${id}`).value, valid_start: s, valid_end: e }, () => { state.list = null; renderReview(); });
}

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
  const { data: accounts, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(500);
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
        <label>角色<select id="gRole"><option value="general">一般人員</option><option value="dept_coordinator">科部主管</option><option value="cfd_staff">師培中心承辦人員（查詢、來電紀錄）</option><option value="admin">師培中心管理者</option><option value="super_admin">最高管理者</option></select></label>
        <label>科部主管的授權範圍（單位名稱開頭；留空＝本人所屬單位）<input id="gScope"></label>
        <label>或：職類別管理人（依執登職類；選了就不看單位名稱，由本人勾選監測單位）<select id="gProf"><option value="">（不使用）</option>
          ${['護理', '藥師', '檢驗', '放射師(放射診斷、放射腫瘤、核子醫學)', '物理治療', '職能治療', '呼吸治療', '營養', '臨床心理', '語言治療', '聽力', '助產', '醫師'].map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select></label>
        <label class="check"><input id="gOff" type="checkbox"> 停用此帳號</label>
        <button class="btn btn-primary" style="width:auto" type="submit">套用</button>
      </form></section>

    <section class="card"><h3>已開通帳號（${accounts.length}）</h3><div class="table-wrap"><table>
      <thead><tr><th>員工編號</th><th>角色</th><th>授權範圍</th><th>狀態</th><th>開通時間</th></tr></thead><tbody>
      ${accounts.map(a => `<tr><td>${empLabel(a.emp_id)}</td><td>${esc(ROLE_LABEL[a.role])}</td><td>${esc(a.scope_profession ? `${a.scope_profession}職類${(a.scope_units || []).length ? `（${a.scope_units.length} 個單位）` : ''}` : (a.scope_dept || '—'))}</td><td>${a.disabled ? '<span class="pill expired">停用</span>' : '<span class="pill valid">使用中</span>'}</td><td>${esc(fmtTime(a.created_at))}</td></tr>`).join('')}
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
    act('admin.setRole', { emp_id: $('gEmp').value, role: $('gRole').value, scope_dept: $('gScope').value.trim(), scope_profession: $('gProf').value, disabled: $('gOff').checked }, renderAdmin);
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
