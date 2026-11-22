// ==UserScript==
// @name         YouTube Danmaku Comments
// @version      1.0.0
// @description  YouTube動画のコメント欄のコメントを、ニコニコ動画風に動画上へ流す。タイムスタンプ付きコメントはその時刻に、その返信は直後に表示する。
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * @file YouTubeの動画コメントを取得し、再生時刻に合わせて弾幕として表示する。
 */

(() => {
  "use strict";

  const REPLY_GAP = 0.5; // 返信を親コメントの何秒後から順に流すか
  const STORE_KEY = "ytdm-settings";

  /**
   * 設定パネルの1項目。最小値・最大値・刻み幅は数値入力とスライダーで使う。
   * @typedef {[key: string, label: string, type: "checkbox" | "number" | "range" | "color" | "text", defaultValue: string | number | boolean, min?: number, max?: number, step?: number]} SettingField
   */

  /** @type {SettingField[]} */
  const FIELDS = [
    ["enabled", "コメントを流す", "checkbox", true],
    ["fontSize", "文字サイズ (画面の高さに対する%)", "number", 5.5, 1, 20, 0.5],
    ["opacity", "不透明度", "range", 0.9, 0.1, 1, 0.05],
    ["color", "文字色", "color", "#ffffff"],
    ["strokeColor", "縁取りの色", "color", "#000000"],
    ["strokeWidth", "縁取りの太さ (px)", "number", 1, 0, 5, 0.5],
    ["bold", "太字", "checkbox", true],
    ["fontFamily", "フォント", "text", '"Hiragino Kaku Gothic ProN", "Meiryo", sans-serif'],
    ["duration", "画面を横切る秒数", "number", 5, 1, 20, 0.5],
    ["area", "表示範囲 (上から何%)", "number", 100, 10, 100, 5],
    ["maxChars", "1コメントの最大文字数", "number", 80, 5, 500, 5],
    ["maxComments", "取得するコメント数 (次の動画から反映)", "number", 500, 20, 5000, 20],
    ["replies", "タイムスタンプ付きコメントの返信も流す (次の動画から反映)", "checkbox", true],
    ["maxReplies", "1コメントあたりの返信の上限 (次の動画から反映)", "number", 20, 1, 200, 1],
  ];
  const DEFAULTS = Object.fromEntries(FIELDS.map(([k, , , d]) => [k, d]));

  /**
   * 保存済みの設定を読み込み、既定値と許容範囲に従って正規化する。
   * @returns {Record<string, any>} 設定項目のキーと正規化済みの値。
   */
  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
    } catch {}
    const s = {};
    for (const [k, , type, d, min, max] of FIELDS) {
      const v = saved[k];
      if (type === "checkbox") s[k] = typeof v === "boolean" ? v : d;
      else if (type === "number" || type === "range") s[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
      else if (type === "color") s[k] = /^#[0-9a-f]{6}$/i.test(v) ? v : d;
      else s[k] = typeof v === "string" && v.trim() ? v : d;
    }
    return s;
  }
  let S = loadSettings();
  /** 現在の設定をYouTubeオリジンのローカルストレージに保存する。 */
  const saveSettings = () => localStorage.setItem(STORE_KEY, JSON.stringify(S));

  // 1:23 / 12:34 / 1:02:03 形式。数字や「数字:」の続きになっているものは除外 (「4:52:」の後ろのコロンは可)
  const TS_RE = /(?<!\d|\d:)(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?!\d|:\d)/;

  const style = document.createElement("style");
  style.textContent = `
    .ytdm-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:30}
    .ytdm-c{position:absolute;left:0;top:0;white-space:pre;line-height:1.2;will-change:transform}
    .ytdm-btn{display:inline-flex !important;align-items:center;justify-content:center;padding:0 !important}
    .ytdm-btn svg{width:100%;height:100%;display:block}
    .ytdm-btn .ytdm-badge{fill:#535353}
    .ytdm-btn[aria-pressed="true"] .ytdm-badge{fill:#087d52}
    .ytdm-btn[aria-pressed="false"] .ytdm-state-on,
    .ytdm-btn[aria-pressed="true"] .ytdm-state-off{display:none}
    .ytdm-panel{position:absolute;right:12px;bottom:64px;z-index:70;width:320px;max-width:calc(100% - 24px);
      max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;padding:12px 14px;border-radius:8px;
      background:rgba(28,28,28,.92);color:#eee;font:13px/1.4 Roboto,Arial,sans-serif;text-shadow:none}
    .ytdm-panel h2{margin:0 0 8px;font-size:14px}
    .ytdm-panel label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
    .ytdm-panel input[type=number]{width:72px}
    .ytdm-panel input[type=text]{width:150px}
    .ytdm-panel input[type=range]{width:110px}
    .ytdm-panel .ytdm-row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    .ytdm-panel button{padding:4px 10px;border-radius:4px;border:0;cursor:pointer}
  `;
  document.head.append(style);

  /**
   * @typedef {object} CommentEntry
   * @property {string | undefined} id YouTubeのコメントID。
   * @property {string} text コメント本文。
   * @property {number} replyLevel 親コメントは0、返信は正の値。
   */

  /**
   * @typedef {object} CommentPage
   * @property {CommentEntry[]} entries 取得したページ内のコメントまたは返信。
   * @property {Map<string, string>} replyTokens 親コメントIDごとの返信取得トークン。
   * @property {string | undefined} next 次のページの取得トークン。
   */

  /**
   * @typedef {object} VideoComment
   * @property {string | undefined} id YouTubeの親コメントID。
   * @property {string} text 親コメントの本文。
   * @property {string[]} replies 取得順に並んだ返信の本文。
   */

  /**
   * @typedef {object} TimedComment
   * @property {number} t 表示開始時刻（動画の先頭からの秒数）。
   * @property {string} text 表示する本文。
   */

  /** @type {VideoComment[]} */
  let comments = [];
  /** @type {TimedComment[]} 表示開始時刻の昇順。 */
  let schedule = [];
  let cursor = 0; // 次に流す schedule の位置
  let lastT = 0;
  let layoutKey = "";
  /** @type {{el: HTMLDivElement, t0: number, w: number}[]} 表示中の要素と開始時刻（秒）、幅（px）。 */
  let active = [];
  /** @type {{t0: number, w: number, v: number}[]} 行ごとの直近コメントの開始時刻（秒）、幅（px）、速度（px/秒）。 */
  let lanes = [];
  let loadGen = 0;
  let frameNo = 0;

  /** 現在のYouTubeプレイヤーを探す。 */
  const player = () => document.querySelector("#movie_player");
  /** プレイヤー内の動画要素を探す。 */
  const video = () => document.querySelector("#movie_player video");
  /** プレイヤー内の弾幕レイヤーを探す。 */
  const layer = () => document.querySelector("#movie_player .ytdm-layer");

  // ---- コメント取得 (YouTubeのページ自身が使う innertube API) ----

  /**
   * YouTubeのページが使うInnertubeの next エンドポイントへリクエストを送る。
   * @param {{videoId: string} | {continuation: string}} body 動画IDまたは継続取得トークン。
   * @returns {Promise<Record<string, any>>} YouTubeから返されたJSON。
   * @throws {Error} HTTPレスポンスが成功ステータスでない場合。
   */
  async function innertube(body) {
    const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT") ?? {
      client: { clientName: "WEB", clientVersion: "2.20261001.00.00", hl: "ja", gl: "JP" },
    };
    // 公開コメントの読み取りだけなので Cookie は送らない
    const res = await fetch("/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`youtubei/v1/next ${res.status}`);
    return res.json();
  }

  /**
   * JSONのオブジェクトと配列を深さ優先でたどる。
   * @param {unknown} o 探索の起点。
   * @yields {Record<string, any>} 探索中のオブジェクトまたは配列。
   */
  function* walk(o) {
    if (!o || typeof o !== "object") return;
    yield o;
    for (const v of Object.values(o)) yield* walk(v);
  }

  /**
   * JSON内で最初に見つかった継続取得トークンを返す。
   * @param {unknown} o 探索の起点。
   * @returns {string | undefined} 見つかったトークン。
   */
  const findToken = (o) => {
    for (const x of walk(o)) if (x.continuationCommand?.token) return x.continuationCommand.token;
  };

  /**
   * 継続取得トークンからコメントまたは返信を1ページ取得する。
   * @param {string} token 取得するページを示すトークン。
   * @returns {Promise<CommentPage>} コメント本文と継続取得用のトークン。
   */
  async function fetchPage(token) {
    const data = await innertube({ continuation: token });
    const items = (data.onResponseReceivedEndpoints ?? []).flatMap((e) => (e.reloadContinuationItemsCommand ?? e.appendContinuationItemsAction)?.continuationItems ?? []);
    // 新形式: 本文は frameworkUpdates 側の commentEntityPayload にある
    let entries = (data.frameworkUpdates?.entityBatchUpdate?.mutations ?? [])
      .map((m) => m.payload?.commentEntityPayload?.properties)
      .filter((p) => p?.content?.content)
      .map((p) => ({ id: p.commentId, text: p.content.content, replyLevel: p.replyLevel ?? 0 }));
    if (!entries.length) {
      // 旧形式: commentRenderer.contentText.runs (返信は未対応)
      entries = items
        .map((i) => i.commentThreadRenderer?.comment?.commentRenderer)
        .filter((r) => r?.contentText?.runs)
        .map((r) => ({ id: r.commentId, text: r.contentText.runs.map((x) => x.text).join(""), replyLevel: 0 }));
    }
    const replyTokens = new Map();
    for (const i of items) {
      const t = i.commentThreadRenderer;
      const id = t?.commentViewModel?.commentViewModel?.commentId;
      const rt = t?.replies && findToken(t.replies);
      if (id && rt) replyTokens.set(id, rt);
    }
    return { entries, replyTokens, next: findToken(items.findLast((i) => i.continuationItemRenderer)) };
  }

  /**
   * 親コメントを取得し、設定に応じてタイムスタンプ付きコメントの返信を追加する。
   * @param {string} videoId YouTubeの動画ID。
   * @yields {VideoComment[]} ページ取得ごとに更新される同一のコメント配列。
   * @throws {Error} コメント欄の最初の取得トークンが見つからない場合。
   */
  async function* fetchComments(videoId) {
    const opts = { ...S }; // 読み込み中の設定変更は次の動画から
    const first = await innertube({ videoId });
    let token;
    for (const x of walk(first)) {
      if (x.sectionIdentifier === "comment-item-section") {
        token = findToken(x);
        break;
      }
    }
    if (!token) throw new Error("コメント欄の継続トークンが見つからない (コメント無効の動画の可能性)");

    const list = [];
    const replyTokens = new Map();
    while (token && list.length < opts.maxComments) {
      const page = await fetchPage(token);
      for (const e of page.entries) if (!e.replyLevel) list.push({ id: e.id, text: e.text, replies: [] });
      for (const [k, v] of page.replyTokens) replyTokens.set(k, v);
      yield list;
      token = page.next;
    }
    if (!opts.replies) return;

    // タイムスタンプ付きコメントのスレッドだけ返信を取得
    for (const c of list) {
      let rt = TS_RE.test(c.text) && replyTokens.get(c.id);
      while (rt && c.replies.length < opts.maxReplies) {
        const page = await fetchPage(rt);
        for (const e of page.entries) {
          if (e.replyLevel > 0 && e.id?.split(".")[0] === c.id && c.replies.length < opts.maxReplies) c.replies.push(e.text);
        }
        yield list;
        rt = page.next;
      }
    }
  }

  // ---- 表示時刻の決定 ----

  /**
   * コメント本文を、タイムスタンプのないコメントの配置に使う値へ変換する。
   * @param {string} s ハッシュ化する本文。
   * @returns {number} 0以上1未満の値。
   */
  const hash = (s) => {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
    return (h >>> 0) / 2 ** 32;
  };

  /**
   * タイムスタンプの時・分・秒を通算秒へ変換する。
   * @param {RegExpMatchArray} m タイムスタンプのマッチ結果。
   * @returns {number} 動画の先頭からの秒数。
   */
  const toSec = (m) => (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
  const TS_RE_G = new RegExp(TS_RE.source, "g");
  /**
   * 本文の前後の区切り記号を落とし、本文中の連続する空白をまとめる。
   * @param {string} s 整形する本文。
   * @returns {string} 整形後の本文。
   */
  const tidy = (s) => s.replace(/^[\s~〜\-–—:：、,，・|｜/]+|[\s~〜\-–—:：、,，・|｜/@＠]+$/g, "").replace(/\s+/g, " ");

  /**
   * 本文をタイムスタンプごとに分割し、時刻とその時刻に表示する本文を取り出す。
   * 時刻の前後にある本文や、「0:30〜1:20 ここ」のような範囲指定にも対応する。
   * @param {string} text コメントの原文。
   * @returns {TimedComment[]} タイムスタンプの出現順の結果。時刻がなければ空配列。
   */
  function splitByStamps(text) {
    const ms = [...text.matchAll(TS_RE_G)];
    if (!ms.length) return [];
    const raw = [];
    let pos = 0;
    for (const m of ms) {
      raw.push(text.slice(pos, m.index));
      pos = m.index + m[0].length;
    }
    raw.push(text.slice(pos));
    const p = raw.map(tidy); // p[i] は i 個目のタイムスタンプの直前の文、p[n] は最後の後ろ
    if (ms.length === 1) return [{ t: toSec(ms[0]), text: tidy(`${p[0]} ${p[1]}`) }]; // 文中の1つは前後をつなぐ
    // 最後のタイムスタンプの後ろが空で先頭に文がある → 「文 時刻」の後置き形式
    const trailing = !p[ms.length] && p[0];
    return ms.map((m, i) => ({
      t: toSec(m),
      // 文のない時刻(範囲指定や並び)は隣の文を使う
      text: trailing ? (p.slice(0, i + 1).findLast(Boolean) ?? "") : (p.slice(i + 1).find(Boolean) ?? ""),
    }));
  }

  /**
   * 親コメントと返信の表示時刻を決め、動画内で表示できる本文を時刻順に並べる。
   * @param {VideoComment[]} list 取得した親コメントと返信。
   * @param {number} duration 動画の長さ（秒）。
   * @param opts 表示設定。横切る時間（duration、秒）と本文の最大文字数（maxChars）を使う。
   * @returns {TimedComment[]} 表示開始時刻の昇順のスケジュール。
   */
  function buildSchedule(list, duration, opts) {
    const clip = (s) => {
      s = s.replace(/\s+/g, " ").trim();
      return s.length > opts.maxChars ? s.slice(0, opts.maxChars) + "…" : s;
    };
    const out = [];
    for (const c of list) {
      const parts = splitByStamps(c.text);
      if (!parts.length) {
        // タイムスタンプなし: 本文から決まる固定の位置へ散らす
        out.push({ t: hash(c.text) * Math.max(0, duration - opts.duration), text: clip(c.text) });
        continue;
      }
      for (const x of parts) out.push({ t: x.t, text: clip(x.text) });
      // 返信は親コメント(最初のタイムスタンプ)の直後に順番に流す。返信内のタイムスタンプも除去
      const base = Math.min(...parts.map((x) => x.t));
      c.replies.forEach((r, i) => out.push({ t: base + REPLY_GAP * (i + 1), text: clip(tidy(r.replace(TS_RE_G, " "))) }));
    }
    return out.filter((x) => x.t <= duration && x.text).sort((a, b) => a.t - b.t);
  }

  /**
   * スケジュールから、指定時刻を超える最初の表示位置を二分探索する。
   * @param {number} t 比較する再生時刻（秒）。
   * @returns {number} 該当する添字。該当がなければスケジュールの長さ。
   */
  const lowerBound = (t) => {
    let lo = 0;
    let hi = schedule.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (schedule[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  /** 現在の動画と設定で表示スケジュールを再構築し、次の表示位置を更新する。 */
  function rebuild() {
    const v = video();
    if (!v || player()?.classList.contains("ad-showing")) return;
    // ライブ配信(duration=Infinity)は対象外
    schedule = Number.isFinite(v.duration) ? buildSchedule(comments, v.duration, S) : [];
    cursor = lowerBound(lastT);
  }

  // ---- 描画 ----

  /** 弾幕レイヤーに文字の表示設定を反映し、次のフレームで再配置する。 */
  function applyStyle() {
    const box = layer();
    if (!box) return;
    const w = S.strokeWidth;
    const shadows = [];
    if (w > 0)
      for (let a = 0; a < 360; a += 45) {
        const r = (a * Math.PI) / 180;
        shadows.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 ${S.strokeColor}`);
      }
    Object.assign(box.style, {
      color: S.color,
      opacity: S.opacity,
      fontWeight: S.bold ? "bold" : "normal",
      fontFamily: S.fontFamily,
      textShadow: shadows.join(",") || "none",
    });
    layoutKey = ""; // 次のフレームで配置し直す
  }

  /** 表示中の弾幕を取り除き、行の使用状況を初期化する。 */
  function clear() {
    for (const a of active) a.el.remove();
    active = [];
    lanes = [];
  }

  /**
   * シークやリサイズ後に、指定時刻で画面上に残る弾幕から表示し直す。
   * @param {number} now 現在の再生時刻（秒）。
   */
  function reset(now) {
    clear();
    cursor = lowerBound(now - S.duration);
  }

  /**
   * 弾幕の表示要素を作成し、先行コメントとの重なりを考慮して行を選ぶ。
   * @param {TimedComment} c 表示するコメント。
   * @param {Element} box 弾幕を追加するレイヤー。
   * @param {number} W 弾幕レイヤーの幅（px）。
   * @param {number} laneH 1行の高さ（px）。
   * @param {number} nLanes 利用できる行数。
   */
  function emit(c, box, W, laneH, nLanes) {
    const el = document.createElement("div");
    el.className = "ytdm-c";
    el.textContent = c.text;
    box.append(el);
    const w = el.offsetWidth;
    const v = (W + w) / S.duration;
    // 前のコメントが完全に画面に入っていて、かつ追い付かない行を選ぶ
    let lane = lanes.findIndex((p, i) => i < nLanes && c.t >= p.t0 + p.w / p.v && c.t + W / v >= p.t0 + S.duration);
    if (lane < 0 && lanes.length < nLanes) lane = lanes.length;
    if (lane < 0) lane = lanes.reduce((best, p, i) => (i < nLanes && p.t0 < lanes[best].t0 ? i : best), 0); // 満杯なら最古の行に重ねる
    lanes[lane] = { t0: c.t, w, v };
    el.style.top = `${lane * laneH}px`;
    active.push({ el, t0: c.t, w });
  }

  /** 再生時刻に合わせて弾幕を追加・移動・削除し、次の描画を予約する。 */
  function frame() {
    requestAnimationFrame(frame);
    if (++frameNo % 60 === 0) setupPlayer(); // コントロールが作り直された場合にボタンを戻す
    const v = video();
    const box = layer();
    if (!v || !box) return;
    const now = v.currentTime;

    if (!S.enabled || player()?.classList.contains("ad-showing")) {
      if (active.length) clear();
      cursor = lowerBound(now);
      lastT = now;
      return;
    }

    const W = box.clientWidth;
    const H = box.clientHeight;
    const fontPx = (H * S.fontSize) / 100;
    const laneH = fontPx * 1.2;
    const nLanes = Math.max(1, Math.floor((H * S.area) / 100 / laneH));
    const key = `${W}x${H}`;
    if (key !== layoutKey) {
      layoutKey = key;
      box.style.fontSize = `${fontPx}px`;
      reset(now);
    } else if (now < lastT || now - lastT > 1) {
      reset(now); // シーク検出
    }
    lastT = now;

    while (cursor < schedule.length && schedule[cursor].t <= now) emit(schedule[cursor++], box, W, laneH, nLanes);

    active = active.filter((a) => {
      const x = W - ((W + a.w) * (now - a.t0)) / S.duration;
      if (x < -a.w || now < a.t0) {
        a.el.remove();
        return false;
      }
      a.el.style.transform = `translateX(${x}px)`;
      return true;
    });
  }

  // ---- 設定パネル・ボタン ----

  /** 設定を保存し、弾幕ボタンと表示に反映する。 */
  function onSettingsChanged() {
    saveSettings();
    document.querySelectorAll(".ytdm-btn").forEach((b) => b.setAttribute("aria-pressed", String(S.enabled)));
    applyStyle();
    rebuild();
  }

  /**
   * 入力欄と初期化・閉じるボタンを備えた設定パネルを作成する。
   * @returns {HTMLDivElement} 初期状態では非表示の設定パネル。
   */
  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "ytdm-panel";
    panel.hidden = true;
    // パネル内の操作を YouTube のショートカットや再生/停止に渡さない
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "keydown", "keyup", "keypress", "wheel", "contextmenu"]) {
      panel.addEventListener(ev, (e) => e.stopPropagation());
    }
    const h = document.createElement("h2");
    h.textContent = "コメント弾幕の設定";
    panel.append(h);

    const inputs = {};
    const sync = () => {
      for (const [k, , type] of FIELDS) {
        if (type === "checkbox") inputs[k].checked = S[k];
        else inputs[k].value = S[k];
      }
    };
    for (const [k, label, type, , min, max, step] of FIELDS) {
      const row = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      if (min !== undefined) Object.assign(input, { min, max, step });
      input.addEventListener(type === "checkbox" ? "change" : "input", () => {
        if (type === "checkbox") S[k] = input.checked;
        else if (type === "number" || type === "range") {
          const n = parseFloat(input.value);
          if (!Number.isFinite(n)) return; // 入力途中の空欄などは無視
          S[k] = Math.min(max, Math.max(min, n));
        } else S[k] = input.value.trim() || DEFAULTS[k];
        onSettingsChanged();
      });
      inputs[k] = input;
      row.append(span, input);
      panel.append(row);
    }

    const buttons = document.createElement("div");
    buttons.className = "ytdm-row";
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "初期値に戻す";
    resetBtn.addEventListener("click", () => {
      S = { ...DEFAULTS };
      sync();
      onSettingsChanged();
    });
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "閉じる";
    closeBtn.addEventListener("click", () => (panel.hidden = true));
    buttons.append(resetBtn, closeBtn);
    panel.append(buttons);
    sync();
    return panel;
  }

  /**
   * 左クリックで弾幕、右クリックで設定パネルを切り替えるボタンを作成する。
   * @param panel ボタンから開閉する設定パネル。
   * @returns {HTMLButtonElement} プレイヤーの操作欄に追加するボタン。
   */
  function buildButton(panel) {
    const btn = document.createElement("button");
    btn.className = "ytp-button ytdm-btn";
    btn.title = "クリック: コメント弾幕 ON/OFF / 右クリック: 設定";
    btn.setAttribute("aria-label", "コメント弾幕");
    btn.setAttribute("aria-pressed", String(S.enabled));
    // 他のボタンと同じく SVG で描き、ボタンの大きさに合わせて中央に置く
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("aria-hidden", "true");
    const badge = document.createElementNS(NS, "rect");
    badge.setAttribute("class", "ytdm-badge");
    Object.entries({
      x: 2,
      y: 3,
      width: 28,
      height: 26,
      rx: 5,
    }).forEach(([k, v]) => badge.setAttribute(k, v));
    svg.append(badge);
    const labels = document.createElementNS(NS, "g");
    Object.entries({
      "text-anchor": "middle",
      fill: "#fff",
      "font-family": "sans-serif",
      "font-weight": "bold",
    }).forEach(([k, v]) => labels.setAttribute(k, v));
    for (const [label, y, size, className] of [
      ["弾", 15, 12, ""],
      ["ON", 25, 9, "ytdm-state-on"],
      ["OFF", 25, 9, "ytdm-state-off"],
    ]) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", 16);
      text.setAttribute("y", y);
      text.setAttribute("font-size", size);
      if (className) text.setAttribute("class", className);
      text.textContent = label;
      labels.append(text);
    }
    svg.append(labels);
    btn.append(svg);
    btn.addEventListener("click", () => {
      S.enabled = !S.enabled;
      panel.querySelector("input[type=checkbox]").checked = S.enabled; // 先頭は enabled
      onSettingsChanged();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    return btn;
  }

  /**
   * 現在のプレイヤーに弾幕レイヤー、設定パネル、操作ボタンを取り付ける。
   * @returns {boolean} プレイヤーが見つかったかどうか。
   */
  function setupPlayer() {
    const p = player();
    if (!p) return false;
    if (!layer()) {
      const box = document.createElement("div");
      box.className = "ytdm-layer";
      p.append(box, buildPanel());
      video()?.addEventListener("loadedmetadata", rebuild);
      applyStyle();
    }
    const controls = p.querySelector(".ytp-right-controls");
    if (controls && !controls.querySelector(".ytdm-btn")) controls.prepend(buildButton(p.querySelector(".ytdm-panel")));
    return true;
  }

  /** 動画切り替え時に前の弾幕を消し、現在の動画のコメントを順次読み込む。 */
  async function load() {
    const gen = ++loadGen;
    comments = [];
    schedule = [];
    clear();
    const id = new URLSearchParams(location.search).get("v");
    if (location.pathname !== "/watch" || !id) return;
    // プレイヤー生成待ち
    for (let i = 0; i < 50 && !setupPlayer(); i++) await new Promise((r) => setTimeout(r, 200));
    try {
      for await (const list of fetchComments(id)) {
        if (gen !== loadGen) return; // 別の動画へ移動済み
        comments = list;
        rebuild();
      }
    } catch (e) {
      console.warn("[YouTube Danmaku]", e);
    }
  }

  // YouTube は SPA なので画面遷移ごとに読み直す
  document.addEventListener("yt-navigate-finish", load);
  load();
  requestAnimationFrame(frame);
})();
