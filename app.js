'use strict';
/* ============================================================
   study-app app.js
   スマホ用模擬試験PWAのロジック。ビルド工程・npm依存・CDN読み込みなし。
   file:// でも（Service Worker 以外は）動作する。

   最重要ルール: 選択肢キーは ['A','B','C','D'] にハードコードしない。
   常に Object.keys(q.options) で動的に扱う（5択以上の multi に対応するため）。
   ============================================================ */

/* ================= storage keys / constants ================= */
const DB_NAME = 'study-app';
const DB_VERSION = 1;
const STORE_SETS = 'sets';

const LS_NOTES = 'sa-notes-v1';
const LS_HISTORY = 'sa-history-v1';
const LS_SESSION = 'sa-session-v1';
const LS_PREFS = 'sa-prefs-v1';
const LS_SETS_FALLBACK = 'sa-sets-v1'; // IndexedDB が使えないときの問題セット保管場所

const LANG_CYCLE = ['en', 'ja', 'both'];
const LANG_LABEL = { en: '英語', ja: '日本語', both: '英日併記' };
const DEFAULT_PASS_RATE = 0.7;

const NOTE_FLAGS = [
  { value: '', label: '（分類なし）' },
  { value: 'wording', label: '表現がわかりにくい' },
  { value: 'content', label: '内容に誤りがあるかも' },
  { value: 'translation', label: '和訳に問題がある' },
  { value: 'other', label: 'その他' },
];

/* ================= tiny DOM / text helpers (timed-exam.html から流用・一般化) ================= */
function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmt(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }
/* 言語別テキスト。lang: 'en' | 'ja' | 'both' */
function bi(en, ja, lang) {
  if (lang === 'ja' && ja) return fmt(ja);
  if (lang === 'both' && ja) return fmt(en) + `<span class="bi-ja">${fmt(ja)}</span>`;
  return fmt(en || '');
}
function nextLang(lang) { return LANG_CYCLE[(LANG_CYCLE.indexOf(lang) + 1) % LANG_CYCLE.length]; }
function langBtnLabel(lang) { return `🌐 ${LANG_LABEL[nextLang(lang)]}で表示`; }
function areaOf(q) {
  if (!q.study_area) return 'その他';
  return q.study_area.split('—')[0].replace(/ /g, ' ').trim() || 'その他';
}
function topicOf(q) {
  const m = (q.study_area || '').match(/_([^_]+)_/);
  return m ? m[1] : '';
}
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function hhmmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0');
}
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* ================= pure logic =================
   ここから3つの関数（isAnswered/isCorrect/calcLimitMinutes）と normalizeSet は
   ブラウザAPIに依存しない純粋関数。検証用に一時的な node スクリプトへ
   そのままコピーしてテスト可能な形にしている。 */

// 選択肢キーは常にこれで取得する（'A'..'D' 固定禁止）
function optionKeys(q) { return Object.keys((q && q.options) || {}); }

function isAnswered(ans) {
  if (ans === undefined || ans === null) return false;
  if (Array.isArray(ans)) return ans.length > 0;
  return ans !== '';
}

function isCorrect(q, ans) {
  if (!isAnswered(ans)) return false;
  if (q.type === 'multi') {
    if (!Array.isArray(ans)) return false;
    const a = ans.map(String).slice().sort();
    const c = (q.correct || []).map(String).slice().sort();
    if (a.length !== c.length) return false;
    return a.every((v, i) => v === c[i]);
  }
  return String(ans) === String(q.correct);
}

function defaultOfficialMinutes(count) {
  return Math.max(1, Math.round((Number(count) || 0) * 120 / 53));
}

function calcLimitMinutes(officialMinutes, officialCount, count) {
  const m = Number(officialMinutes) || 120;
  const c = Number(officialCount) || 53;
  const n = Number(count) || 0;
  return Math.max(1, Math.ceil((m * n) / c));
}

// v1(配列 or type/selectCount欠落) / v2 を吸収して正規化する。UIに依存しない純粋関数。
// 戻り値: { ok:true, set, questions, notes } | { ok:false, errors:[...] }
function normalizeSet(raw, providedMeta) {
  const errors = [];
  let rawQuestions, rawSet, rawNotes;

  if (Array.isArray(raw)) {
    rawQuestions = raw;
    rawSet = null;
    rawNotes = {};
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.questions)) {
    rawQuestions = raw.questions;
    rawSet = (raw.set && typeof raw.set === 'object') ? raw.set : null;
    rawNotes = (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)) ? raw.notes : {};
  } else {
    return { ok: false, errors: ['JSON のルートが配列、または questions 配列を持つオブジェクトである必要があります。'] };
  }

  if (!Array.isArray(rawQuestions) || !rawQuestions.length) {
    return { ok: false, errors: ['questions が空です。'] };
  }

  const provided = providedMeta || {};
  const count = rawQuestions.length;

  const base = Object.assign(
    { id: null, name: '', examCode: '', officialCount: null, officialMinutes: null, passRate: null, updatedAt: null },
    rawSet || {}
  );
  Object.keys(provided).forEach((k) => {
    const cur = base[k];
    const isEmpty = cur === null || cur === undefined || cur === '';
    const pv = provided[k];
    const providedIsUsable = pv !== undefined && pv !== null && pv !== '';
    if (isEmpty && providedIsUsable) base[k] = pv;
  });
  if (!base.officialCount) base.officialCount = count;
  if (!base.officialMinutes) base.officialMinutes = defaultOfficialMinutes(base.officialCount);
  if (base.passRate === null || base.passRate === undefined) base.passRate = DEFAULT_PASS_RATE;
  if (!base.updatedAt) base.updatedAt = new Date().toISOString();
  // id は以後 DOM の data-* 属性（常に文字列）や IndexedDB のキー比較と突き合わせるため、
  // ここで文字列に統一しておく（JSON側で数値idが来た場合の型不一致を防ぐ）。
  if (base.id !== null && base.id !== undefined && base.id !== '') base.id = String(base.id);
  if (!base.name) base.name = base.id || '';

  if (!base.id) errors.push('set.id が指定されていません（インポート時にセットIDを入力してください）。');

  const seenIds = new Set();
  const questions = [];
  rawQuestions.forEach((q, idx) => {
    const tag = `#${idx + 1}`;
    if (!q || typeof q !== 'object') { errors.push(`${tag}: 問題データがオブジェクトではありません。`); return; }

    const id = (q.id === undefined || q.id === null || q.id === '') ? idx : q.id;
    const idKey = String(id);
    if (seenIds.has(idKey)) errors.push(`${tag} (id=${id}): id が重複しています。`);
    seenIds.add(idKey);

    const type = q.type === 'multi' ? 'multi' : 'single';
    const options = (q.options && typeof q.options === 'object' && !Array.isArray(q.options)) ? q.options : {};
    const optKeys = Object.keys(options);
    if (!optKeys.length) errors.push(`${tag} (id=${id}): options が空です。`);

    let selectCount = q.selectCount;
    if (type === 'multi') {
      if (!Number.isInteger(selectCount) || selectCount < 1) {
        selectCount = Array.isArray(q.correct) ? q.correct.length : 2;
      }
    } else {
      selectCount = 1;
    }

    let correct = q.correct;
    if (type === 'multi') {
      if (!Array.isArray(correct)) {
        errors.push(`${tag} (id=${id}): multi の correct は配列である必要があります。`);
        correct = [];
      } else {
        correct = correct.map(String);
        correct.forEach((k) => {
          if (!optKeys.includes(k)) errors.push(`${tag} (id=${id}): correct の "${k}" が options に存在しません。`);
        });
        if (correct.length !== selectCount) {
          errors.push(`${tag} (id=${id}): correct の要素数(${correct.length})が selectCount(${selectCount})と一致しません。`);
        }
      }
    } else {
      if (correct === undefined || correct === null || correct === '') {
        errors.push(`${tag} (id=${id}): correct が指定されていません。`);
      } else if (!optKeys.includes(String(correct))) {
        errors.push(`${tag} (id=${id}): correct "${correct}" が options に存在しません。`);
      } else {
        correct = String(correct);
      }
    }

    if (!q.question) errors.push(`${tag} (id=${id}): question が空です。`);

    questions.push({
      id, type, selectCount,
      question: q.question || '',
      options,
      correct,
      explanation: q.explanation || '',
      study_area: q.study_area || '',
      question_ja: q.question_ja || '',
      options_ja: (q.options_ja && typeof q.options_ja === 'object' && !Array.isArray(q.options_ja)) ? q.options_ja : {},
      explanation_ja: q.explanation_ja || '',
    });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, set: base, questions, notes: rawNotes || {} };
}

/* ================= copy-for-explanation (timed-exam.html から流用・動的キー化) ================= */
function formatAnswerLabel(ans) {
  if (!isAnswered(ans)) return '未解答';
  const keys = Array.isArray(ans) ? ans.slice().sort() : [ans];
  return keys.join(', ');
}

function buildExplainPrompt(q, ans, withJa) {
  const L = [];
  L.push('この質問を解説してください。');
  L.push('');
  L.push(`【出典】${(q.study_area || '').replace(/_/g, '')}`);
  L.push('');
  L.push('【問題】');
  L.push(q.question);
  L.push('');
  optionKeys(q).forEach((k) => L.push(`${k}. ${q.options[k]}`));
  L.push('');
  const ok = isCorrect(q, ans);
  L.push(isAnswered(ans) ? `【あなたの解答】${formatAnswerLabel(ans)}（${ok ? '正解' : '不正解'}）` : '【あなたの解答】未解答');
  const correctLabel = Array.isArray(q.correct) ? q.correct.slice().sort().join(', ') : q.correct;
  L.push(`【正解】${correctLabel}`);
  L.push('');
  L.push('【解説】');
  L.push(q.explanation || '');
  if (withJa && q.question_ja) {
    L.push('');
    L.push('【問題（和訳）】');
    L.push(q.question_ja);
    optionKeys(q).forEach((k) => L.push(`${k}. ${(q.options_ja || {})[k] || ''}`));
    if (q.explanation_ja) { L.push(''); L.push('【解説（和訳）】'); L.push(q.explanation_ja); }
  }
  return L.join('\n');
}

async function copyToClipboard(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e1) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { ok = false; }
  }
  if (btn) {
    const orig = btn.dataset.origLabel || btn.textContent;
    btn.dataset.origLabel = orig;
    btn.textContent = ok ? '✅ コピーしました' : '⚠️ コピー失敗';
    setTimeout(() => { btn.textContent = orig; }, 1600);
  }
  return ok;
}

/* ================= Storage: IndexedDB → localStorage → memory の段階フォールバック =================
   file:// で origin が null になる iOS Safari 等では IndexedDB / localStorage の
   どちらも例外を投げうるため、必ず try/catch で捕まえて次の層へ落とす。
   全メソッドは Promise を返す（IndexedDB が非同期なため、他の層も揃えて非同期にしている）。 */
const Storage = (function () {
  let mode = 'unknown';
  let db = null;
  let idbBroken = false;
  let lsBroken = false;
  const mem = {}; // localStorage が使えないときの最終フォールバック
  let degradeHandler = null;

  function setOnDegrade(fn) { degradeHandler = fn; }
  function announceDegrade() {
    mode = idbBroken && lsBroken ? 'memory' : (idbBroken ? 'localStorage' : mode);
    if (degradeHandler) degradeHandler(mode);
  }

  function memGet(key, fallback) {
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : fallback;
  }
  function memSet(key, val) { mem[key] = val; }

  function lsGet(key, fallback) {
    if (!lsBroken) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { lsBroken = true; announceDegrade(); }
    }
    return memGet(key, fallback);
  }
  function lsSet(key, val) {
    if (!lsBroken) {
      try { localStorage.setItem(key, JSON.stringify(val)); return; }
      catch (e) { lsBroken = true; announceDegrade(); }
    }
    memSet(key, val);
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window) || !window.indexedDB) { reject(new Error('no-idb')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_SETS)) d.createObjectStore(STORE_SETS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb-open-error'));
      req.onblocked = () => reject(new Error('idb-blocked'));
    });
  }
  function idbStore(type) { return db.transaction(STORE_SETS, type).objectStore(STORE_SETS); }
  function idbPing() {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_SETS, 'readonly');
        tx.objectStore(STORE_SETS);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('idb-tx-error'));
        tx.onabort = () => reject(new Error('idb-tx-abort'));
      } catch (e) { reject(e); }
    });
  }

  async function init() {
    let idbOk = false;
    try { db = await openIDB(); await idbPing(); idbOk = true; }
    catch (e) { idbOk = false; db = null; }
    idbBroken = !idbOk;

    let lsOk = false;
    try {
      const k = '__sa_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      lsOk = true;
    } catch (e) { lsOk = false; }
    lsBroken = !lsOk;

    mode = idbOk ? 'indexeddb' : (lsOk ? 'localStorage' : 'memory');
    return mode;
  }

  async function listSets() {
    if (!idbBroken && db) {
      try {
        return await new Promise((resolve, reject) => {
          const req = idbStore('readonly').getAll();
          req.onsuccess = () => resolve((req.result || []).map((r) => ({ set: r.set, questions: r.questions })));
          req.onerror = () => reject(req.error);
        });
      } catch (e) { idbBroken = true; announceDegrade(); }
    }
    const all = lsGet(LS_SETS_FALLBACK, {});
    return Object.values(all);
  }

  async function getSet(id) {
    if (!idbBroken && db) {
      try {
        return await new Promise((resolve, reject) => {
          const req = idbStore('readonly').get(id);
          req.onsuccess = () => resolve(req.result ? { set: req.result.set, questions: req.result.questions } : null);
          req.onerror = () => reject(req.error);
        });
      } catch (e) { idbBroken = true; announceDegrade(); }
    }
    const all = lsGet(LS_SETS_FALLBACK, {});
    return all[id] || null;
  }

  async function putSet(id, data) {
    if (!idbBroken && db) {
      try {
        await new Promise((resolve, reject) => {
          const req = idbStore('readwrite').put({ id, set: data.set, questions: data.questions });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        return;
      } catch (e) { idbBroken = true; announceDegrade(); }
    }
    const all = lsGet(LS_SETS_FALLBACK, {});
    all[id] = data;
    lsSet(LS_SETS_FALLBACK, all);
  }

  async function getNotesForSet(setId) {
    const all = lsGet(LS_NOTES, {});
    return all[setId] || {};
  }
  async function setNote(setId, qid, partial) {
    const all = lsGet(LS_NOTES, {});
    const setNotes = all[setId] || {};
    const prev = setNotes[qid] || {};
    const next = Object.assign({}, prev, partial, { updatedAt: new Date().toISOString() });
    setNotes[qid] = next;
    all[setId] = setNotes;
    lsSet(LS_NOTES, all);
    return next;
  }

  async function getHistory(setId) {
    const all = lsGet(LS_HISTORY, {});
    return all[setId] || [];
  }
  async function appendHistory(setId, record) {
    const all = lsGet(LS_HISTORY, {});
    const list = all[setId] || [];
    list.push(record);
    all[setId] = list;
    lsSet(LS_HISTORY, all);
  }

  async function getSession() { return lsGet(LS_SESSION, null); }
  async function setSession(sess) { lsSet(LS_SESSION, sess); }
  async function clearSession() { lsSet(LS_SESSION, null); }

  async function getPrefs() { return lsGet(LS_PREFS, {}); }
  async function setPrefs(partial) {
    const cur = lsGet(LS_PREFS, {});
    const next = Object.assign({}, cur, partial);
    lsSet(LS_PREFS, next);
    return next;
  }

  return {
    init, setOnDegrade,
    get mode() { return mode; },
    listSets, getSet, putSet,
    getNotesForSet, setNote,
    getHistory, appendHistory,
    getSession, setSession, clearSession,
    getPrefs, setPrefs,
  };
})();

/* ================= toast / modal ================= */
let toastTimer = null;
function showToast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

// シンプルな確認モーダル（ボタン押下 = そのまま resolve）。
// フォーム入力を伴うモーダル（askSetMeta / openMemoEditor）は個別に実装している
// （resolve 後に modal-body を消してしまうと入力値が読めなくなるため）。
function openModal(opts) {
  return new Promise((resolve) => {
    $('modal-title').textContent = opts.title || '';
    $('modal-body').innerHTML = opts.bodyHTML || '';
    const actions = $('modal-actions');
    actions.innerHTML = '';
    (opts.buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.className || '');
      btn.textContent = b.label;
      btn.onclick = () => {
        $('modal-overlay').classList.add('hidden');
        $('modal-body').innerHTML = '';
        resolve(b.value);
      };
      actions.appendChild(btn);
    });
    $('modal-overlay').classList.remove('hidden');
  });
}

function askSetMeta(prefill) {
  return new Promise((resolve) => {
    const p = prefill || {};
    $('modal-title').textContent = 'セット情報の入力';
    $('modal-body').innerHTML = `
      <p class="hint">この問題データにはセット情報(set)が無いか、IDが指定されていません。手動で入力してください。</p>
      <div class="modal-field"><label>セットID（半角英数・ハイフン・アンダースコア、必須）</label>
        <input type="text" id="meta-id" value="${esc(p.id || '')}" placeholder="ccdv-f"></div>
      <div class="modal-field"><label>名前</label>
        <input type="text" id="meta-name" value="${esc(p.name || '')}" placeholder="CCDV-F 模擬問題"></div>
      <div class="modal-field"><label>試験コード（任意）</label>
        <input type="text" id="meta-code" value="${esc(p.examCode || '')}" placeholder="CCDV-F"></div>
      <div class="modal-field"><label>本番の出題数（任意・既定は問題数）</label>
        <input type="number" id="meta-count" min="1" value="${p.officialCount || ''}"></div>
      <div class="modal-field"><label>本番の制限時間（分・任意）</label>
        <input type="number" id="meta-minutes" min="1" value="${p.officialMinutes || ''}"></div>
      <div class="modal-field"><label>合格ライン（0〜1・任意・既定0.7）</label>
        <input type="number" id="meta-pass" min="0" max="1" step="0.01" value="${p.passRate || ''}"></div>
    `;
    const actions = $('modal-actions');
    actions.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary'; okBtn.textContent = 'これでインポート';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn'; cancelBtn.textContent = 'キャンセル';
    actions.appendChild(okBtn); actions.appendChild(cancelBtn);

    function finishClose(value) {
      $('modal-overlay').classList.add('hidden');
      $('modal-body').innerHTML = '';
      resolve(value);
    }
    cancelBtn.onclick = () => finishClose(null);
    okBtn.onclick = () => {
      const body = $('modal-body');
      const id = (body.querySelector('#meta-id').value || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        showToast('セットIDは半角英数・ハイフン・アンダースコアのみで入力してください');
        return; // モーダルは閉じずに再入力させる
      }
      const name = (body.querySelector('#meta-name').value || '').trim();
      const examCode = (body.querySelector('#meta-code').value || '').trim();
      const countV = Number(body.querySelector('#meta-count').value);
      const minutesV = Number(body.querySelector('#meta-minutes').value);
      const passV = Number(body.querySelector('#meta-pass').value);
      finishClose({
        id,
        name: name || undefined,
        examCode: examCode || undefined,
        officialCount: countV > 0 ? countV : undefined,
        officialMinutes: minutesV > 0 ? minutesV : undefined,
        passRate: passV > 0 ? passV : undefined,
      });
    };
    $('modal-overlay').classList.remove('hidden');
  });
}

function openMemoEditor(qid) {
  return new Promise((resolve) => {
    const note = notesCache[qid] || {};
    $('modal-title').textContent = `メモ（問題 id: ${qid}）`;
    $('modal-body').innerHTML = `
      <div class="modal-field">
        <label>分類</label>
        <select id="memo-flag">
          ${NOTE_FLAGS.map((f) => `<option value="${esc(f.value)}" ${note.flag === f.value ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-field">
        <label>メモ</label>
        <textarea id="memo-text" placeholder="気づいたことを書いておく（ブラッシュアップ時に参照）">${esc(note.memo || '')}</textarea>
      </div>
      ${note.updatedAt ? `<p class="hint">最終更新: ${esc(new Date(note.updatedAt).toLocaleString('ja-JP'))}</p>` : ''}
    `;
    const actions = $('modal-actions');
    actions.innerHTML = '';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary'; saveBtn.textContent = '保存';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger'; delBtn.textContent = '消去';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn'; cancelBtn.textContent = 'キャンセル';
    actions.appendChild(saveBtn); actions.appendChild(delBtn); actions.appendChild(cancelBtn);

    function done(result) {
      $('modal-overlay').classList.add('hidden');
      $('modal-body').innerHTML = '';
      resolve(result);
    }
    cancelBtn.onclick = () => done(null);
    saveBtn.onclick = async () => {
      const body = $('modal-body');
      const flag = body.querySelector('#memo-flag').value;
      const memo = body.querySelector('#memo-text').value;
      const saved = await Storage.setNote(currentSetId, qid, { flag, memo });
      notesCache[qid] = saved;
      scheduleSave();
      done(saved);
    };
    delBtn.onclick = async () => {
      const saved = await Storage.setNote(currentSetId, qid, { flag: '', memo: '' });
      notesCache[qid] = saved;
      scheduleSave();
      done(saved);
    };
    $('modal-overlay').classList.remove('hidden');
  });
}

function hasMemo(qid) {
  const n = notesCache[qid];
  return !!(n && ((n.memo && n.memo.trim()) || n.flag));
}

/* ================= app state ================= */
let sets = [];                    // Storage.listSets() のキャッシュ（ホーム画面表示用）
let currentSetId = null;
let currentSetMeta = null;
let currentQuestions = null;      // 配列
let currentQuestionsById = new Map();
let notesCache = {};              // { [qid]: {flag, memo, updatedAt} }（currentSetId のもの）

let session = null;                // 進行中の受験セッション（sa-session-v1 にそのまま保存される形）
let resultRecord = null;           // 直前に採点した結果（結果・復習画面で使う）
let pendingResume = null;          // ホーム画面の再開バナー用
let tickHandle = null;
let saveTimer = null;

let listFilter = 'all';
let reviewList = [];               // resultRecord.questions への index の配列
let reviewIdx = 0;
let revLang = 'en';

function setCurrentQuestions(list) {
  currentQuestions = list;
  currentQuestionsById = new Map(list.map((q) => [q.id, q]));
}
function questionById(id) { return currentQuestionsById.get(id); }
function currentQ() { return questionById(session.qids[session.idx]); }

/* ================= screen management ================= */
const SCREEN_IDS = ['screen-home', 'screen-setup', 'screen-question', 'screen-list', 'screen-result', 'screen-review'];
function show(id) {
  SCREEN_IDS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
  $('app-main').classList.toggle('with-bottom-nav', id === 'screen-question' || id === 'screen-list');
  window.scrollTo(0, 0);
}
function setHeaderTitle(text) { $('header-title').textContent = text; }

function goHome() {
  session = null;
  resultRecord = null;
  $('header-timer').textContent = '';
  $('header-timer').classList.remove('warn', 'danger');
  $('progress-fill').style.width = '0';
  setHeaderTitle('模擬試験シミュレーター');
  refreshSetList();
  show('screen-home');
}

/* ================= home: set list ================= */
async function refreshSetList() {
  sets = await Storage.listSets();
  renderSetList();
}

function renderSetList() {
  const wrap = $('set-list');
  if (!sets.length) {
    wrap.innerHTML = '<p class="hint">まだ問題セットがありません。下の「インポート」から読み込んでください。</p>';
    return;
  }
  const sorted = sets.slice().sort((a, b) => String(b.set.updatedAt || '').localeCompare(String(a.set.updatedAt || '')));
  wrap.innerHTML = sorted.map((rec) => {
    const s = rec.set;
    const count = rec.questions.length;
    const updated = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    return `
      <div class="set-item">
        <div class="set-item-head">
          <span class="set-item-name">${esc(s.name || s.id)}</span>
          <span class="set-item-meta">${esc(s.examCode || '')} ・ ${count}問 ・ 最終更新 ${esc(updated)}</span>
        </div>
        <div class="btn-row tight">
          <button class="btn btn-primary" data-action="start" data-set-id="${esc(s.id)}">試験を始める</button>
          <button class="btn" data-action="toggle-history" data-set-id="${esc(s.id)}">受験履歴</button>
          <button class="btn" data-action="export-questions" data-set-id="${esc(s.id)}">問題+メモを書き出す</button>
          <button class="btn" data-action="export-results" data-set-id="${esc(s.id)}">成績を書き出す</button>
        </div>
        <div class="set-history-wrap hidden" data-history-for="${esc(s.id)}"></div>
      </div>`;
  }).join('');
}

function findSetRecord(id) { return sets.find((r) => r.set.id === id) || null; }

async function onSetListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.setId;
  const action = btn.dataset.action;
  if (action === 'start') await openSetupFor(id);
  else if (action === 'toggle-history') await toggleHistoryPanel(id);
  else if (action === 'export-questions') await exportQuestions(id);
  else if (action === 'export-results') await exportResults(id);
}

async function toggleHistoryPanel(id) {
  let panel = null;
  $('set-list').querySelectorAll('[data-history-for]').forEach((p) => { if (p.dataset.historyFor === id) panel = p; });
  if (!panel) return;
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }

  const rec = findSetRecord(id);
  const passRate = (rec && typeof rec.set.passRate === 'number') ? rec.set.passRate : DEFAULT_PASS_RATE;
  const hist = await Storage.getHistory(id);
  if (!hist.length) {
    panel.innerHTML = '<p class="hint">まだ受験履歴がありません。</p>';
  } else {
    const rows = hist.slice(-10).reverse().map((h) => {
      const rate = h.total ? Math.round((h.correct / h.total) * 100) : 0;
      const cls = rate >= Math.round(passRate * 100) ? 'score-pass' : 'score-fail';
      return `<tr><td>${esc(h.date || '')}</td><td class="${cls}">${h.correct}/${h.total}（${rate}%）</td><td>${hhmmss(h.totalMs || 0)}</td></tr>`;
    }).join('');
    panel.innerHTML = `<table class="history"><tr><th>日時</th><th>スコア</th><th>所要時間</th></tr>${rows}</table>`;
  }
  panel.classList.remove('hidden');
}

/* ================= export ================= */
function timestampSlug() { return new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-'); }

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function exportQuestions(id) {
  const rec = findSetRecord(id);
  if (!rec) return;
  const notes = await Storage.getNotesForSet(id);
  downloadJSON(`${id}-questions-${timestampSlug()}.json`, { schemaVersion: 2, set: rec.set, questions: rec.questions, notes });
  showToast('問題+メモを書き出しました');
}

async function exportResults(id) {
  const rec = findSetRecord(id);
  if (!rec) return;
  const hist = await Storage.getHistory(id);
  const qstats = {};
  hist.forEach((h) => {
    (h.questions || []).forEach((qh) => {
      if (!qh.answered) return;
      const s = qstats[qh.id] || { attempts: 0, correct: 0, wrong: 0, totalMs: 0, lastResult: null };
      s.attempts++;
      s[qh.ok ? 'correct' : 'wrong']++;
      s.totalMs += qh.ms || 0;
      s.lastResult = qh.ok ? 'correct' : 'wrong';
      qstats[qh.id] = s;
    });
  });
  // questionMeta は既存の <試験>/exams/results/*.json と同じ「配列」で出す
  // （オブジェクトにすると既存の分析スクリプトの走査が壊れる）
  const questionMeta = rec.questions.map((q) => ({
    id: q.id,
    correct: q.correct,
    study_area: q.study_area || '',
    head: (q.question || '').slice(0, 80),
  }));
  const payload = {
    exportedAt: new Date().toISOString(),
    history: hist.map((h) => ({ date: h.date, mode: 'exam', correct: h.correct, total: h.total, totalMs: h.totalMs })),
    qstats,
    questionMeta,
  };
  downloadJSON(`${id}-results-${timestampSlug()}.json`, payload);
  showToast('成績を書き出しました');
}

/* ================= import ================= */
function showImportErrors(errors) {
  const el = $('import-errors');
  if (!errors || !errors.length) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = errors.join('\n');
}

function suggestNewId(id) {
  const ids = new Set(sets.map((r) => r.set.id));
  let n = 2;
  while (ids.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

async function handleImportText(text) {
  showImportErrors([]);
  let raw;
  try { raw = JSON.parse(text); }
  catch (err) { showImportErrors([`JSON の形式が正しくありません: ${err.message}`]); return; }

  const hasEmbeddedSetId = !Array.isArray(raw) && !!(raw && raw.set && raw.set.id);
  let providedMeta;
  if (!hasEmbeddedSetId) {
    providedMeta = await askSetMeta({});
    if (!providedMeta) return; // キャンセル
  }

  const result = normalizeSet(raw, providedMeta);
  if (!result.ok) { showImportErrors(result.errors); return; }

  // 重複解決ループ: 「別セットとして追加」で入力した新IDが *別の* 既存セットと
  // 衝突するケースもあるため、衝突が解消されるまで再入力を求める（無確認上書きを防ぐ）。
  let targetId = result.set.id;
  let existing = await Storage.getSet(targetId);
  let askingForNewId = false;
  while (existing) {
    if (!askingForNewId) {
      const choice = await openModal({
        title: 'セットIDが既存と重複しています',
        bodyHTML: `<p>「${esc(targetId)}」は既に存在します（${existing.questions.length}問）。どうしますか？<br>上書きしても受験履歴とメモは問題IDで維持されます。</p>`,
        buttons: [
          { label: '上書きする', value: 'overwrite', className: 'btn-primary' },
          { label: '別セットとして追加', value: 'add-new' },
          { label: 'キャンセル', value: 'cancel', className: 'btn-danger' },
        ],
      });
      if (!choice || choice === 'cancel') return;
      if (choice === 'overwrite') break; // 既存の targetId のまま上書き確定
    } else {
      showToast('そのIDも既に使われています。別のIDを入力してください。');
    }
    const meta2 = await askSetMeta(Object.assign({}, result.set, { id: suggestNewId(targetId) }));
    if (!meta2) return;
    targetId = meta2.id;
    result.set.id = meta2.id;
    result.set.name = meta2.name || result.set.name;
    result.set.examCode = meta2.examCode || result.set.examCode;
    result.set.officialCount = meta2.officialCount || result.set.officialCount;
    result.set.officialMinutes = meta2.officialMinutes || result.set.officialMinutes;
    result.set.passRate = meta2.passRate || result.set.passRate;
    askingForNewId = true;
    existing = await Storage.getSet(targetId);
  }
  result.set.updatedAt = new Date().toISOString();
  await Storage.putSet(targetId, { set: result.set, questions: result.questions });

  const importedNotes = result.notes || {};
  const noteKeys = Object.keys(importedNotes);
  for (let i = 0; i < noteKeys.length; i++) {
    const qid = noteKeys[i];
    await Storage.setNote(targetId, qid, importedNotes[qid]);
  }

  $('import-paste-textarea').value = '';
  $('import-file-input').value = '';
  showImportErrors([]);
  await refreshSetList();
  showToast(`「${result.set.name}」を読み込みました（${result.questions.length}問）`);
}

function wireImportEvents() {
  $('import-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await handleImportText(text);
    } catch (err) {
      showImportErrors([`ファイルの読み込みに失敗しました: ${err.message || err}`]);
    } finally {
      e.target.value = '';
    }
  });
  $('import-paste-btn').addEventListener('click', async () => {
    const text = $('import-paste-textarea').value.trim();
    if (!text) { showImportErrors(['貼り付け欄が空です。']); return; }
    await handleImportText(text);
  });
}

/* ================= setup screen ================= */
async function openSetupFor(id) {
  const rec = await Storage.getSet(id);
  if (!rec) { showToast('問題セットの読み込みに失敗しました'); return; }
  currentSetId = id;
  currentSetMeta = rec.set;
  setCurrentQuestions(rec.questions);
  notesCache = await Storage.getNotesForSet(id);
  await renderSetupScreen();
  show('screen-setup');
}

async function renderSetupScreen() {
  const total = currentQuestions.length;
  $('setup-set-name').textContent = `${currentSetMeta.name}（全${total}問収録）`;

  const officialCount = clamp(Number(currentSetMeta.officialCount) || total, 1, total);
  const presetsRaw = [
    { count: officialCount, label: `${officialCount}問（本番相当）` },
    { count: 10, label: '10問' },
    { count: 20, label: '20問' },
    { count: total, label: `全${total}問` },
  ];
  const seenCounts = new Set();
  const presets = presetsRaw.filter((p) => {
    if (p.count < 1 || p.count > total || seenCounts.has(p.count)) return false;
    seenCounts.add(p.count);
    return true;
  });

  const seg = $('setup-count-seg');
  seg.innerHTML = presets.map((p) => `<button data-count="${p.count}">${esc(p.label)}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('setup-count-input').value = b.dataset.count;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onSetupCountChange();
    };
  });

  const countInput = $('setup-count-input');
  countInput.max = String(total);
  countInput.value = String(clamp(officialCount, 1, total));
  seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', Number(x.dataset.count) === Number(countInput.value)));
  $('setup-count-hint').textContent = `全${total}問中から出題します。`;
  countInput.oninput = () => {
    seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    onSetupCountChange();
  };

  onSetupCountChange();

  $('setup-lang-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('setup-lang-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  const prefs = await Storage.getPrefs();
  const lang = LANG_CYCLE.includes(prefs.lang) ? prefs.lang : 'en';
  $('setup-lang-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.lang === lang));
  $('setup-shuffle-checkbox').checked = prefs.shuffle !== false; // 既定 true
}

function onSetupCountChange() {
  const total = currentQuestions.length;
  const count = clamp(Math.round(Number($('setup-count-input').value)) || 1, 1, total);
  $('setup-count-input').value = String(count);
  const minutes = calcLimitMinutes(currentSetMeta.officialMinutes, currentSetMeta.officialCount, count);
  $('setup-time-input').value = String(minutes);
  $('setup-time-hint').textContent =
    `本番想定: ${currentSetMeta.officialCount}問で${currentSetMeta.officialMinutes}分。出題数に応じて自動計算されます（手動で上書きできます）。`;
}

async function startSession() {
  const total = currentQuestions.length;
  const count = clamp(Math.round(Number($('setup-count-input').value)) || 1, 1, total);
  const minutes = clamp(Math.round(Number($('setup-time-input').value)) || 1, 1, 24 * 60);
  const langBtn = $('setup-lang-seg').querySelector('button.active');
  const lang = langBtn ? langBtn.dataset.lang : 'en';
  const shuffle = $('setup-shuffle-checkbox').checked;

  let pool = currentQuestions.map((q) => q.id);
  if (shuffle) pool = shuffled(pool);
  const qids = pool.slice(0, count);

  const now = Date.now();
  session = {
    setId: currentSetId,
    setName: currentSetMeta.name,
    passRate: (typeof currentSetMeta.passRate === 'number') ? currentSetMeta.passRate : DEFAULT_PASS_RATE,
    qids,
    answers: {},
    strikes: {},
    flags: {},
    times: {},
    idx: 0,
    startedAt: now,
    qStartedAt: now,
    limitMs: minutes * 60 * 1000,
    lang,
    finished: false,
  };

  await Storage.setPrefs({ lang, shuffle, lastSetId: currentSetId });
  await Storage.setSession(session);

  setHeaderTitle(currentSetMeta.name);
  show('screen-question');
  renderQuestion();
  tick(); // 次の tick（最大500ms後）まで残り時間が空欄になるのを防ぐ
}

/* ================= question screen ================= */
function renderQuestion() {
  const q = currentQ();
  const qid = q.id;

  $('q-number').textContent = `問 ${session.idx + 1} / ${session.qids.length}`;
  $('q-text').innerHTML = bi(q.question, q.question_ja, session.lang);

  const keys = optionKeys(q);
  const ansRaw = session.answers[qid];
  const selected = new Set(Array.isArray(ansRaw) ? ansRaw : (isAnswered(ansRaw) ? [ansRaw] : []));
  const struck = new Set(session.strikes[qid] || []);

  if (q.type === 'multi') {
    $('q-select-hint').classList.remove('hidden');
    $('q-select-hint').textContent = `${keys.length}択から${q.selectCount}つ選んでください（${selected.size}/${q.selectCount} 選択中）`;
  } else {
    $('q-select-hint').classList.add('hidden');
  }

  const wrap = $('q-options');
  wrap.innerHTML = keys.map((k) => `
    <div class="option-row">
      <button class="option" data-key="${esc(k)}"><span class="letter">${esc(k)}</span><span class="opt-text">${bi(q.options[k], (q.options_ja || {})[k], session.lang)}</span></button>
      <button class="strike-btn" data-key="${esc(k)}" title="取り消し線">✕</button>
    </div>`).join('');
  wrap.querySelectorAll('.option').forEach((btn) => {
    const k = btn.dataset.key;
    btn.classList.toggle('picked', selected.has(k));
    btn.classList.toggle('struck', struck.has(k));
    btn.onclick = () => toggleAnswer(k);
  });
  wrap.querySelectorAll('.strike-btn').forEach((btn) => {
    const k = btn.dataset.key;
    btn.classList.toggle('active', struck.has(k));
    btn.onclick = (e) => { e.stopPropagation(); toggleStrike(k); };
  });

  $('flag-btn').classList.toggle('flagged', !!session.flags[qid]);
  $('lang-btn').textContent = langBtnLabel(session.lang);
  $('memo-btn').classList.toggle('has-memo', hasMemo(qid));

  $('prev-btn').disabled = session.idx === 0;
  $('next-btn').disabled = session.idx === session.qids.length - 1;

  renderPalette();
  updateProgressBar();
}

function renderPalette() {
  const pal = $('palette');
  pal.innerHTML = '';
  session.qids.forEach((qid, i) => {
    const b = document.createElement('button');
    b.textContent = String(i + 1);
    if (isAnswered(session.answers[qid])) b.classList.add('answered');
    if (session.flags[qid]) b.classList.add('flagged');
    if (i === session.idx) b.classList.add('current');
    b.onclick = () => gotoQuestion(i);
    pal.appendChild(b);
  });
}

function updateProgressBar() {
  const answeredCount = session.qids.filter((qid) => isAnswered(session.answers[qid])).length;
  $('progress-fill').style.width = (session.qids.length ? (answeredCount / session.qids.length * 100) : 0) + '%';
}

function toggleAnswer(k) {
  const q = currentQ();
  const qid = q.id;
  if (q.type === 'multi') {
    const cur = Array.isArray(session.answers[qid]) ? session.answers[qid].slice() : [];
    const at = cur.indexOf(k);
    if (at >= 0) {
      cur.splice(at, 1);
    } else {
      if (cur.length >= q.selectCount) {
        showToast(`最大${q.selectCount}つまで選択できます。他を選ぶには一度選択を外してください。`);
        return;
      }
      cur.push(k);
    }
    session.answers[qid] = cur;
  } else {
    session.answers[qid] = k;
  }
  renderQuestion();
  scheduleSave();
}

function toggleStrike(k) {
  const q = currentQ();
  const qid = q.id;
  const cur = new Set(session.strikes[qid] || []);
  if (cur.has(k)) cur.delete(k); else cur.add(k);
  session.strikes[qid] = Array.from(cur);
  renderQuestion();
  scheduleSave();
}

function commitQuestionTime() {
  if (!session || session.finished) return;
  const qid = session.qids[session.idx];
  const now = Date.now();
  const delta = Math.max(0, now - (session.qStartedAt || now));
  session.times[qid] = (session.times[qid] || 0) + delta;
  session.qStartedAt = now;
}

function gotoQuestion(i) {
  if (!session || i < 0 || i >= session.qids.length) return;
  commitQuestionTime();
  session.idx = i;
  renderQuestion();
  scheduleSave();
}

/* ================= global tick (残り時間の表示・0での自動提出) ================= */
function startGlobalTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(tick, 500);
  tick();
}

function tick() {
  if (!session || session.finished) return;
  const remain = session.limitMs - (Date.now() - session.startedAt);
  const el = $('header-timer');
  el.textContent = '残り ' + hhmmss(Math.max(0, remain));
  el.classList.toggle('warn', remain < session.limitMs * 0.2 && remain >= 5 * 60 * 1000);
  el.classList.toggle('danger', remain < 5 * 60 * 1000);
  if (remain <= 0) finishSession(true);
}

/* ================= answer list (解答一覧 / 提出前) ================= */
function renderList() {
  const rows = session.qids
    .map((qid, i) => ({ qid, i }))
    .filter(({ qid }) => {
      if (listFilter === 'flagged') return !!session.flags[qid];
      if (listFilter === 'unanswered') return !isAnswered(session.answers[qid]);
      return true;
    });

  const wrap = $('list-rows');
  if (!rows.length) {
    wrap.innerHTML = '<p class="hint">該当する問題はありません。</p>';
    return;
  }
  wrap.innerHTML = rows.map(({ qid, i }) => {
    const ans = session.answers[qid];
    const answered = isAnswered(ans);
    const label = answered ? (Array.isArray(ans) ? ans.slice().sort().join(', ') : ans) : '未解答';
    return `
      <div class="list-row" data-idx="${i}">
        <span class="idx">${i + 1}</span>
        <span class="badge flag-mark">${session.flags[qid] ? '🚩' : ''}</span>
        <span class="answer-summary ${answered ? '' : 'unanswered'}">${esc(label)}</span>
      </div>`;
  }).join('');
  wrap.querySelectorAll('.list-row').forEach((row) => {
    row.onclick = () => { gotoQuestion(Number(row.dataset.idx)); show('screen-question'); };
  });
}

/* ================= finish & results ================= */
async function finishSession(auto) {
  if (!session || session.finished) return;
  const unansweredCount = session.qids.filter((qid) => !isAnswered(session.answers[qid])).length;
  if (!auto && unansweredCount > 0) {
    const choice = await openModal({
      title: '提出の確認',
      bodyHTML: `<p>未解答が ${unansweredCount} 問あります。提出して採点しますか？</p>`,
      buttons: [
        { label: '提出する', value: true, className: 'btn-primary' },
        { label: 'キャンセル', value: false },
      ],
    });
    if (!choice) return;
  }
  if (auto) showToast('制限時間になりました。自動的に提出します。');

  commitQuestionTime();
  session.finished = true;
  session.finishedAt = Date.now();
  session.totalMs = session.finishedAt - session.startedAt;

  const total = session.qids.length;
  const correct = session.qids.filter((qid) => isCorrect(questionById(qid), session.answers[qid])).length;

  const record = {
    date: new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    dateISO: new Date().toISOString(),
    mode: 'exam',
    lang: session.lang,
    correct,
    total,
    totalMs: session.totalMs,
    timeUp: !!auto,
    questions: session.qids.map((qid) => {
      const q = questionById(qid);
      const ans = session.answers[qid];
      return {
        id: qid,
        answer: isAnswered(ans) ? ans : null,
        correct: q.correct,
        ok: isCorrect(q, ans),
        answered: isAnswered(ans),
        ms: session.times[qid] || 0,
        flagged: !!session.flags[qid],
      };
    }),
  };

  await Storage.appendHistory(session.setId, record);
  await Storage.clearSession();

  resultRecord = record;
  renderResult();
  show('screen-result');
  $('header-timer').textContent = '';
  $('header-timer').classList.remove('warn', 'danger');
  $('progress-fill').style.width = '100%';
}

function renderResult() {
  const record = resultRecord;
  const rate = record.total ? Math.round((record.correct / record.total) * 100) : 0;
  const passRate = (session && typeof session.passRate === 'number') ? session.passRate : DEFAULT_PASS_RATE;
  const pass = rate >= Math.round(passRate * 100);
  $('result-score').innerHTML = `<span class="${pass ? 'score-pass' : 'score-fail'}">${rate}%</span>　${record.correct} / ${record.total} 問正解`;
  const need = Math.max(0, Math.ceil(record.total * passRate) - record.correct);
  $('result-sub').textContent =
    `${pass ? `🎉 合格ライン(${Math.round(passRate * 100)}%)クリア！` : `合格ライン(${Math.round(passRate * 100)}%)まであと${need}問`}　` +
    `所要時間 ${hhmmss(record.totalMs)}（平均 ${mmss(record.totalMs / (record.total || 1))}/問）`;

  const avgMs = record.totalMs / (record.total || 1);
  const wrap = $('result-rows');
  wrap.innerHTML = record.questions.map((rq, i) => {
    const badge = !rq.answered ? '—' : (rq.ok ? '<span class="score-pass">○</span>' : '<span class="score-fail">✕</span>');
    const yourLabel = rq.answered ? (Array.isArray(rq.answer) ? rq.answer.slice().sort().join(', ') : rq.answer) : '未解答';
    const correctLabel = Array.isArray(rq.correct) ? rq.correct.slice().sort().join(', ') : rq.correct;
    const slow = rq.ms > avgMs * 1.5;
    return `
      <div class="result-row" data-idx="${i}">
        <span class="idx">${i + 1}</span>
        <span class="badge">${badge}</span>
        <span class="answers">${esc(yourLabel)}（正解 ${esc(String(correctLabel))}）</span>
        <span class="time ${slow ? 'slow' : ''}">${mmss(rq.ms)}${slow ? ' ⏱' : ''}</span>
      </div>`;
  }).join('');
  wrap.querySelectorAll('.result-row').forEach((row) => {
    row.onclick = () => { reviewList = record.questions.map((_, i) => i); openReview(Number(row.dataset.idx)); };
  });

  $('result-review-wrong-btn').onclick = () => {
    const wrongs = record.questions.map((_, i) => i).filter((i) => !record.questions[i].ok);
    if (!wrongs.length) { showToast('間違えた問題はありません！🎉'); return; }
    reviewList = wrongs;
    openReview(0); // openReview は reviewList 内の位置を取る（問題番号ではない）
  };
  $('result-export-btn').onclick = () => exportResults(session.setId);
  $('result-home-btn').onclick = () => goHome();
}

/* ================= review (提出後) ================= */
function openReview(idxInReviewList) {
  reviewIdx = idxInReviewList;
  revLang = session.lang;
  renderReview();
  show('screen-review');
}

function renderReview() {
  const record = resultRecord;
  const i = reviewList[reviewIdx];
  const rq = record.questions[i];
  const q = questionById(rq.id);
  const ans = rq.answer;

  $('rev-number').textContent = `問 ${i + 1} / ${record.total}（レビュー ${reviewIdx + 1}/${reviewList.length}）`;
  $('rev-area').textContent = areaOf(q) + (topicOf(q) ? ' / ' + topicOf(q) : '');
  $('rev-time').textContent = '⏱ ' + mmss(rq.ms);
  $('rev-text').innerHTML = bi(q.question, q.question_ja, revLang);

  const correctSet = new Set(Array.isArray(q.correct) ? q.correct : [q.correct]);
  const yourSet = new Set(Array.isArray(ans) ? ans : (isAnswered(ans) ? [ans] : []));
  const wrap = $('rev-options');
  wrap.innerHTML = optionKeys(q).map((k) =>
    `<button class="option" data-key="${esc(k)}" disabled><span class="letter">${esc(k)}</span><span class="opt-text">${bi(q.options[k], (q.options_ja || {})[k], revLang)}</span></button>`
  ).join('');
  wrap.querySelectorAll('.option').forEach((btn) => {
    const k = btn.dataset.key;
    const isYours = yourSet.has(k);
    const isRight = correctSet.has(k);
    if (isYours) btn.classList.add('selected', isRight ? 'correct' : 'incorrect');
    else if (isRight) btn.classList.add('reveal-correct');
  });

  const correctLabel = Array.from(correctSet).sort().join(', ');
  const verdictHTML = !rq.answered
    ? `— 未解答（正解: ${esc(correctLabel)}）`
    : (rq.ok ? '✅ 正解' : `❌ 不正解（正解: ${esc(correctLabel)}）`);
  $('rev-feedback').innerHTML =
    `<div class="verdict ${rq.ok ? 'correct' : 'incorrect'}">${verdictHTML}</div>` +
    `<div class="explanation"><strong>解説:</strong> ${bi(q.explanation, q.explanation_ja, revLang)}</div>`;

  $('rev-lang-btn').textContent = langBtnLabel(revLang);
  $('rev-memo-btn').classList.toggle('has-memo', hasMemo(q.id));
  $('rev-prev-btn').disabled = reviewIdx === 0;
  $('rev-next-btn').disabled = reviewIdx === reviewList.length - 1;

  $('rev-copy-btn').onclick = () => copyToClipboard(buildExplainPrompt(q, ans, true), $('rev-copy-btn'));
  $('rev-memo-btn').onclick = async () => {
    await openMemoEditor(q.id);
    $('rev-memo-btn').classList.toggle('has-memo', hasMemo(q.id));
  };

  window.scrollTo(0, 0);
}

/* ================= resume (中断からの再開) ================= */
async function checkResumableSession() {
  const saved = await Storage.getSession();
  if (!saved || saved.finished) { $('resume-banner').classList.add('hidden'); pendingResume = null; return; }

  const rec = await Storage.getSet(saved.setId);
  $('resume-banner').classList.remove('hidden');
  if (!rec) {
    $('resume-text').textContent = `中断した試験（${saved.setName || saved.setId}）がありますが、問題データが見つからないため再開できません。破棄してください。`;
    $('resume-continue-btn').classList.add('hidden');
    pendingResume = saved;
    return;
  }
  $('resume-continue-btn').classList.remove('hidden');
  const remain = saved.limitMs - (Date.now() - saved.startedAt);
  $('resume-text').textContent = remain > 0
    ? `「${saved.setName || saved.setId}」を中断しています。残り時間 ${hhmmss(remain)}。`
    : `「${saved.setName || saved.setId}」は制限時間を過ぎています。再開すると自動的に採点されます。`;
  pendingResume = saved;
}

async function onResumeContinue() {
  if (!pendingResume) return;
  const rec = await Storage.getSet(pendingResume.setId);
  if (!rec) { showToast('問題データが見つかりません'); return; }

  currentSetId = pendingResume.setId;
  currentSetMeta = rec.set;
  setCurrentQuestions(rec.questions);
  notesCache = await Storage.getNotesForSet(currentSetId);
  session = pendingResume;
  $('resume-banner').classList.add('hidden');
  setHeaderTitle(currentSetMeta.name);

  const remain = session.limitMs - (Date.now() - session.startedAt);
  if (remain <= 0) {
    await finishSession(true);
    return;
  }
  session.qStartedAt = Date.now(); // 再開時点からこの問題の計測を再スタート
  show('screen-question');
  renderQuestion();
  tick();
}

async function onResumeDiscard() {
  const choice = await openModal({
    title: '中断した試験を破棄',
    bodyHTML: '<p>破棄すると、この試験の解答内容は失われます（受験履歴には残りません）。よろしいですか？</p>',
    buttons: [
      { label: '破棄する', value: true, className: 'btn-danger' },
      { label: 'キャンセル', value: false },
    ],
  });
  if (!choice) return;
  await Storage.clearSession();
  pendingResume = null;
  $('resume-banner').classList.add('hidden');
}

/* ================= 逐次永続化（300ms デバウンス + 強制フラッシュ） ================= */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
async function flushSave() {
  saveTimer = null;
  if (session && !session.finished) {
    try { await Storage.setSession(session); } catch (e) { console.warn('session save failed', e); }
  }
}
function forceFlush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flushSave();
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden' && session && !session.finished) {
    commitQuestionTime();
    forceFlush();
  }
}
function onPageHide() {
  if (session && !session.finished) { commitQuestionTime(); forceFlush(); }
}

/* ================= keyboard shortcuts (PC用) ================= */
function onKeyDown(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!$('modal-overlay').classList.contains('hidden')) return;

  if (!$('screen-question').classList.contains('hidden')) {
    const q = currentQ();
    const upper = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (optionKeys(q).includes(upper)) { toggleAnswer(upper); return; }
    if (e.key === 'ArrowRight') { gotoQuestion(session.idx + 1); return; }
    if (e.key === 'ArrowLeft') { gotoQuestion(session.idx - 1); return; }
    if (e.key.toLowerCase() === 'l') { $('lang-btn').click(); return; }
    if (e.key.toLowerCase() === 'f') { $('flag-btn').click(); return; }
    if (e.key.toLowerCase() === 'm') { $('memo-btn').click(); return; }
  } else if (!$('screen-review').classList.contains('hidden')) {
    if (e.key === 'ArrowRight') { $('rev-next-btn').click(); return; }
    if (e.key === 'ArrowLeft') { $('rev-prev-btn').click(); return; }
    if (e.key.toLowerCase() === 'l') { $('rev-lang-btn').click(); return; }
    if (e.key.toLowerCase() === 'c') { $('rev-copy-btn').click(); return; }
    if (e.key.toLowerCase() === 'm') { $('rev-memo-btn').click(); return; }
  } else if (!$('screen-list').classList.contains('hidden')) {
    if (e.key === 'Escape') { $('list-back-btn').click(); return; }
  }
}

/* ================= boot ================= */
function wireStaticEvents() {
  $('set-list').addEventListener('click', onSetListClick);
  wireImportEvents();

  $('resume-continue-btn').onclick = onResumeContinue;
  $('resume-discard-btn').onclick = onResumeDiscard;

  $('setup-back-btn').onclick = () => goHome();
  $('setup-start-btn').onclick = startSession;

  $('prev-btn').onclick = () => gotoQuestion(session.idx - 1);
  $('next-btn').onclick = () => gotoQuestion(session.idx + 1);
  $('to-list-btn').onclick = () => { commitQuestionTime(); scheduleSave(); renderList(); show('screen-list'); };
  $('flag-btn').onclick = () => {
    const qid = currentQ().id;
    session.flags[qid] = !session.flags[qid];
    renderQuestion();
    scheduleSave();
  };
  $('lang-btn').onclick = () => { session.lang = nextLang(session.lang); renderQuestion(); scheduleSave(); };
  $('memo-btn').onclick = async () => { await openMemoEditor(currentQ().id); renderQuestion(); };

  $('list-filter-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      listFilter = b.dataset.filter;
      $('list-filter-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      renderList();
    };
  });
  $('list-back-btn').onclick = () => show('screen-question');
  $('list-submit-btn').onclick = () => finishSession(false);

  $('rev-prev-btn').onclick = () => { if (reviewIdx > 0) { reviewIdx--; renderReview(); } };
  $('rev-next-btn').onclick = () => { if (reviewIdx < reviewList.length - 1) { reviewIdx++; renderReview(); } };
  $('rev-back-btn').onclick = () => show('screen-result');

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  // file:// 等ではオリジンが安定しないため登録自体をスキップする（SPEC.md 参照）
}

function reportStorageDegraded(mode) {
  if (mode === 'memory') {
    $('storage-banner').classList.remove('hidden');
    $('storage-banner-text').textContent =
      '⚠️ この端末ではデータを保存できません（プライベートブラウズや file:// の制限が原因の場合があります）。このタブを閉じると入力内容は失われます。';
  } else if (mode === 'localStorage') {
    $('storage-banner').classList.remove('hidden');
    $('storage-banner-text').textContent =
      '⚠️ IndexedDB が使えないため localStorage に切り替えました。大きな問題セットの保存に失敗する場合があります。';
  }
}

async function boot() {
  wireStaticEvents();
  Storage.setOnDegrade(reportStorageDegraded);

  await Storage.init();
  reportStorageDegraded(Storage.mode);

  registerServiceWorker();

  await refreshSetList();
  await checkResumableSession();
  show('screen-home');
  startGlobalTick();
}

boot();
