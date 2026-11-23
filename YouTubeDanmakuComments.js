// ==UserScript==
// @name         YouTube Danmaku Comments
// @version      1.0.1
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
   * @typedef {object} SettingField
   * @property {string} label 設定パネルの表示名。
   * @property {"checkbox" | "number" | "range" | "color" | "text"} type 入力欄の種類。
   * @property {string | number | boolean} defaultValue 初期値。
   * @property {number} [min] 数値入力とスライダーの最小値。
   * @property {number} [max] 数値入力とスライダーの最大値。
   * @property {number} [step] 数値入力とスライダーの刻み幅。
   */

  /** @type {Record<string, SettingField>} */
  const FIELDS = {
    enabled: { label: "コメントを流す", type: "checkbox", defaultValue: true },
    matchCaptions: { label: "字幕・文字起こしに合わせて流す（試験）", type: "checkbox", defaultValue: false },
    fontSize: { label: "文字サイズ (画面の高さに対する%)", type: "number", defaultValue: 5.5, min: 1, max: 20, step: 0.5 },
    opacity: { label: "不透明度", type: "range", defaultValue: 0.9, min: 0.1, max: 1, step: 0.05 },
    color: { label: "文字色", type: "color", defaultValue: "#ffffff" },
    strokeColor: { label: "縁取りの色", type: "color", defaultValue: "#000000" },
    strokeWidth: { label: "縁取りの太さ (px)", type: "number", defaultValue: 1, min: 0, max: 5, step: 0.5 },
    bold: { label: "太字", type: "checkbox", defaultValue: true },
    fontFamily: { label: "フォント", type: "text", defaultValue: '"Hiragino Kaku Gothic ProN", "Meiryo", sans-serif' },
    duration: { label: "画面を横切る秒数", type: "number", defaultValue: 5, min: 1, max: 20, step: 0.5 },
    area: { label: "表示範囲 (上から何%)", type: "number", defaultValue: 100, min: 10, max: 100, step: 5 },
    maxChars: { label: "1コメントの最大文字数", type: "number", defaultValue: 80, min: 5, max: 500, step: 5 },
    maxComments: { label: "取得するコメント数 (次の動画から反映)", type: "number", defaultValue: 500, min: 20, max: 5000, step: 20 },
    replies: { label: "タイムスタンプ付きコメントの返信も流す (次の動画から反映)", type: "checkbox", defaultValue: true },
    maxReplies: { label: "1コメントあたりの返信の上限 (次の動画から反映)", type: "number", defaultValue: 20, min: 1, max: 200, step: 1 },
  };
  const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([key, { defaultValue }]) => [key, defaultValue]));

  /**
   * 数値設定を許容範囲に収める。
   * @param {number} value 設定値。
   * @param {number} min 最小値。
   * @param {number} max 最大値。
   * @returns {number} 許容範囲内の値。
   */
  const clampSettingNumber = (value, min, max) => Math.min(max, Math.max(min, value));

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
    for (const [key, { type, defaultValue, min, max }] of Object.entries(FIELDS)) {
      const value = saved[key];
      if (type === "checkbox") s[key] = typeof value === "boolean" ? value : defaultValue;
      else if (type === "number" || type === "range") s[key] = Number.isFinite(value) ? clampSettingNumber(value, min, max) : defaultValue;
      else if (type === "color") s[key] = /^#[0-9a-f]{6}$/i.test(value) ? value : defaultValue;
      else s[key] = typeof value === "string" && value.trim() ? value : defaultValue;
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
  let captionState = null;

  /** 現在のYouTubeプレイヤーを探す。 */
  const player = () => document.querySelector("#movie_player");
  /** プレイヤー内の動画要素を探す。 */
  const video = () => document.querySelector("#movie_player video");
  /** プレイヤー内の弾幕レイヤーを探す。 */
  const layer = () => document.querySelector("#movie_player .ytdm-layer");

  // ---- コメント取得 (YouTubeのページ自身が使う innertube API) ----

  /**
   * YouTubeのページが使うInnertubeへリクエストを送る。
   * @param {Record<string, string>} body エンドポイントに渡す値。
   * @param {string} [endpoint] 取得先のエンドポイント。
   * @param {AbortSignal} [signal] リクエストの中断シグナル。
   * @returns {Promise<Record<string, any>>} YouTubeから返されたJSON。
   * @throws {Error} HTTPレスポンスが成功ステータスでない場合。
   */
  async function innertube(body, endpoint = "next", signal) {
    const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT") ?? {
      client: { clientName: "WEB", clientVersion: "2.20261001.00.00", hl: "ja", gl: "JP" },
    };
    // 公開コメント・文字起こしの読み取りだけなので Cookie は送らない
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      credentials: "omit",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`youtubei/v1/${endpoint} ${res.status}`);
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
   * @param {Promise<Record<string, any>>} watchData 動画の初回レスポンス。
   * @yields {VideoComment[]} ページ取得ごとに更新される同一のコメント配列。
   * @throws {Error} コメント欄の最初の取得トークンが見つからない場合。
   */
  async function* fetchComments(watchData) {
    const opts = { ...S }; // 読み込み中の設定変更は次の動画から
    const first = await watchData;
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

  // ---- 字幕・文字起こしの取得 ----

  function captionCue(t, text) {
    return Number.isFinite(t) && t >= 0 && typeof text === "string" && text.trim()
      ? [{ t, text: text.trim() }]
      : [];
  }

  function readTranscriptPanel(id) {
    const watch = document.querySelector("ytd-watch-flexy:not([hidden])");
    if (watch?.getAttribute("video-id") !== id) return [];
    const rows = watch.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model");
    return [...rows].flatMap((row) => {
      const time = row.querySelector(".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp");
      const stamp = time?.textContent.trim().match(TS_RE);
      const text = row.querySelector('.segment-text, span[role="text"]')?.textContent;
      return captionCue(stamp ? toSec(stamp) : NaN, text);
    });
  }

  function parseTranscript(data) {
    const cues = [];
    for (const node of walk(data)) {
      const segment = node.transcriptSegmentRenderer ?? node.transcriptCueRenderer;
      if (segment) {
        const snippet = segment.snippet ?? segment.cue;
        const text = snippet?.simpleText ?? snippet?.runs?.map((run) => run.text).join("");
        const ms = segment.startMs ?? segment.startOffsetMs;
        cues.push(...captionCue(ms == null ? NaN : Number(ms) / 1000, text));
      }
      const modern = node.transcriptSegmentViewModel;
      const stamp = typeof modern?.timestamp === "string" && modern.timestamp.match(TS_RE);
      if (stamp) cues.push(...captionCue(toSec(stamp), modern.simpleText));
    }
    return cues;
  }

  async function fetchCaptionTrack(id, signal) {
    const response = [player()?.getPlayerResponse?.(), window.ytInitialPlayerResponse]
      .find((candidate) => candidate?.videoDetails?.videoId === id && candidate.captions);
    const tracks = response?.captions.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const lang = (document.documentElement.lang || navigator.language).split("-")[0];
    const track = tracks.find((item) => item.languageCode?.split("-")[0] === lang)
      ?? tracks.find((item) => item.kind !== "asr") ?? tracks[0];
    if (!track?.baseUrl) return [];
    const url = new URL(track.baseUrl, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/api/timedtext") return [];
    url.searchParams.set("fmt", "json3");
    const res = await fetch(url, { credentials: "omit", redirect: "error", signal });
    if (!res.ok) throw new Error(`字幕の取得に失敗 (${res.status})`);
    const data = await res.json();
    return (data.events ?? []).flatMap((event) =>
      captionCue(event.tStartMs / 1000, event.segs?.map((seg) => seg.utf8 ?? "").join("")));
  }

  async function fetchCaptionCues(state, signal) {
    try {
      const cues = await fetchCaptionTrack(state.id, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      if (cues.length) return cues;
    } catch {
      signal.throwIfAborted();
      // 字幕トラックを取得できない場合は文字起こしを試す
    }
    if (/^[A-Za-z0-9_-]{11}$/.test(state.id)) {
      try {
        // get_panel の params は protobuf の field 149 に動画 ID と種類 2 を格納する
        const params = btoa(String.fromCharCode(0xaa, 0x09, 15, 0x0a, 11) + state.id + String.fromCharCode(0x18, 2));
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const data = await innertube({ panelId: "PAmodern_transcript_view", params }, "get_panel", timeout);
        const cues = parseTranscript(data);
        if (cues.length) return cues;
      } catch {
        signal.throwIfAborted();
        // 現行パネルが取れない場合は、旧形式の文字起こしを確認する
      }
    }
    const data = await state.watchData;
    signal.throwIfAborted();
    const panels = data.engagementPanels ?? [];
    for (const panel of panels) {
      const renderer = panel.engagementPanelSectionListRenderer;
      if (!renderer?.targetId?.includes("transcript")) continue;
      const cues = parseTranscript(renderer.content);
      if (cues.length) return cues;
      for (const node of walk(renderer.content)) {
        const params = node.getTranscriptEndpoint?.params;
        if (typeof params !== "string" || !params) continue;
        const result = await innertube({ params }, "get_transcript", AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        return parseTranscript(result);
      }
    }
    return [];
  }

  // ---- 字幕とコメントのベクトル照合 ----

  const COMMON_WORDS = new Set((
    "the a an is are was to of in on and or it this that there you i we be so for at with as " +
    "の に は が を で と も へ から まで て た だ です ます する いる ある なる れる こと もの " +
    "これ それ あれ ここ そこ そう こう なん 何 さん ね よ な か ぞ う ん w www 笑"
  ).split(" "));

  function wordsOf(text, segmenter) {
    const normalized = text.slice(0, 1000).normalize("NFKC").toLowerCase();
    return new Set(Array.from(segmenter.segment(normalized))
      .filter(({ segment, isWordLike }) => isWordLike && /\p{L}/u.test(segment) && !COMMON_WORDS.has(segment))
      .map(({ segment }) => segment));
  }

  // まとまった連続処理を小分けにし、再生と設定操作に制御を戻す
  async function* inBatches(items, signal) {
    signal.throwIfAborted();
    let deadline = performance.now() + 8;
    for (const item of items) {
      if (performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        deadline = performance.now() + 8;
      }
      yield item;
    }
  }

  async function buildCaptionIndex(cues, signal) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    const terms = new Map();
    let size = 0;
    let window;
    let windowWords;
    for await (const cue of inBatches(cues.sort((a, b) => a.t - b.t), signal)) {
      const words = wordsOf(cue.text, segmenter);
      if (!words.size) continue;
      if (!window || cue.t - window.t >= 8) {
        window = { t: cue.t, normSq: 0 };
        windowWords = new Set();
        size++;
      }
      for (const word of words) {
        if (windowWords.has(word)) continue;
        windowWords.add(word);
        if (!terms.has(word)) terms.set(word, { hits: [], weight: 0 });
        terms.get(word).hits.push({ window, t: cue.t });
      }
    }
    // 各単語の有無をベクトルの成分にし、出現する区間が少ない単語を重くする
    for await (const term of inBatches(terms.values(), signal)) {
      if (term.hits.length > Math.max(4, size * 0.2)) continue;
      term.weight = 1 + Math.log((size + 1) / (term.hits.length + 1));
      for (const { window } of term.hits) window.normSq += term.weight ** 2;
    }
    return { segmenter, terms, size };
  }

  function matchCaption(text, { segmenter, terms, size }) {
    const words = wordsOf(text, segmenter);
    const scores = new Map();
    let normSq = 0;
    for (const word of words) {
      const term = terms.get(word);
      if (!term) {
        normSq += (1 + Math.log1p(size) / 2) ** 2;
        continue;
      }
      if (!term.weight) continue;
      const weightSq = term.weight ** 2;
      normSq += weightSq;
      for (const { window, t } of term.hits) {
        const score = scores.get(window) ?? { dot: 0, count: 0, t, distinctive: false };
        score.dot += weightSq;
        score.count++;
        score.t = Math.min(score.t, t);
        score.distinctive ||= word.length >= 3 && term.hits.length === 1;
        scores.set(window, score);
      }
    }
    let bestScore = 0;
    let bestTime;
    for (const [window, score] of scores) {
      const cosine = score.dot / Math.sqrt(normSq * window.normSq);
      const minScore = score.count >= 2 ? 0.22 : score.distinctive ? 0.34 : Infinity;
      if (cosine >= minScore && (cosine > bestScore || (cosine === bestScore && score.t < bestTime))) {
        bestScore = cosine;
        bestTime = score.t;
      }
    }
    return bestTime;
  }

  function showCaptionStatus() {
    const element = player()?.querySelector(".ytdm-caption-status");
    if (!element) return;
    element.hidden = !S.matchCaptions;
    const text = captionState?.status ?? "";
    if (element.textContent !== text) element.textContent = text;
  }

  async function updateCaptionMatches(state, panelCues, signal) {
    if (!state.index) {
      state.status = "字幕・文字起こしを読み込み中…";
      showCaptionStatus();
      let cues = panelCues;
      if (!state.waitingForPanel) {
        try {
          const fullCues = await fetchCaptionCues(state, signal);
          if (fullCues.length) cues = fullCues;
        } catch (error) {
          signal.throwIfAborted();
          console.debug("[YouTube Danmaku] 字幕を取得できませんでした", error.message);
        }
      }
      signal.throwIfAborted();
      if (!cues.length) {
        state.waitingForPanel = true;
        state.status = "字幕を取得できませんでした。概要欄に「文字起こしを表示」があれば開いてください。";
        showCaptionStatus();
        return;
      }
      state.waitingForPanel = false;
      state.fromPanel = cues === panelCues;
      const index = await buildCaptionIndex(cues, signal);
      signal.throwIfAborted();
      state.index = index;
    }
    state.status = "コメントと照合中…";
    showCaptionStatus();
    const previouslyMatched = state.matches.size;
    // コメント取得中に配列が伸びても、前回の続きから照合する
    for await (const comment of inBatches(comments.slice(state.processed), signal)) {
      signal.throwIfAborted();
      if (!TS_RE.test(comment.text) && !state.matches.has(comment.text)) {
        const t = matchCaption(comment.text, state.index);
        if (t !== undefined) state.matches.set(comment.text, t);
      }
      state.processed++;
    }
    if (state.matches.size !== previouslyMatched) {
      layoutKey = "";
      rebuild();
    }
    const source = state.fromPanel ? "読み込まれた文字起こし" : "字幕・文字起こし";
    state.status = `${source}に合わせたコメント本文 ${state.matches.size} 件`;
    showCaptionStatus();
  }

  function refreshCaptionMatching() {
    const state = captionState;
    showCaptionStatus();
    if (!state) return;
    if (!S.matchCaptions) {
      state.controller?.abort();
      state.controller = null;
      state.waitingForPanel = false;
      state.failed = false;
      return;
    }
    if (state.controller || state.failed || (state.index && state.processed >= comments.length)) return;
    const panelCues = state.index ? [] : readTranscriptPanel(state.id);
    if (state.waitingForPanel && !panelCues.length) return;
    const controller = new AbortController();
    state.controller = controller;
    updateCaptionMatches(state, panelCues, controller.signal).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("[YouTube Danmaku] 字幕との照合に失敗", error);
      state.waitingForPanel = false;
      state.failed = true;
      state.status = "字幕との照合に失敗しました。";
      showCaptionStatus();
    }).finally(() => {
      if (captionState !== state || state.controller !== controller) return;
      state.controller = null;
      if (!state.failed && !state.waitingForPanel && state.index && state.processed < comments.length) refreshCaptionMatching();
    });
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
   * @param {Map<string, number>} [matches] 字幕に一致したコメント本文と表示開始時刻。
   * @returns {TimedComment[]} 表示開始時刻の昇順のスケジュール。
   */
  function buildSchedule(list, duration, opts, matches) {
    const clip = (s) => {
      s = s.replace(/\s+/g, " ").trim();
      return s.length > opts.maxChars ? s.slice(0, opts.maxChars) + "…" : s;
    };
    const out = [];
    for (const c of list) {
      const parts = splitByStamps(c.text);
      if (!parts.length) {
        const match = matches?.get(c.text);
        const t = match >= 0 && match < duration
          ? match
          : hash(c.text) * Math.max(0, duration - opts.duration);
        out.push({ t, text: clip(c.text) });
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
    const matches = S.matchCaptions ? captionState?.matches : undefined;
    schedule = Number.isFinite(v.duration) ? buildSchedule(comments, v.duration, S, matches) : [];
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
    if (++frameNo % 60 === 0) {
      setupPlayer(); // コントロールが作り直された場合にボタンを戻す
      if (captionState?.waitingForPanel) refreshCaptionMatching();
    }
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
    refreshCaptionMatching();
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
      for (const [key, { type }] of Object.entries(FIELDS)) {
        if (type === "checkbox") inputs[key].checked = S[key];
        else inputs[key].value = S[key];
      }
    };
    for (const [key, { label, type, defaultValue, min, max, step }] of Object.entries(FIELDS)) {
      const row = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      input.name = key;
      if (min !== undefined) Object.assign(input, { min, max, step });
      input.addEventListener(type === "checkbox" ? "change" : "input", () => {
        if (type === "checkbox") S[key] = input.checked;
        else if (type === "number" || type === "range") {
          const n = parseFloat(input.value);
          if (!Number.isFinite(n)) return; // 入力途中の空欄などは無視
          S[key] = clampSettingNumber(n, min, max);
        } else S[key] = input.value.trim() || defaultValue;
        onSettingsChanged();
      });
      inputs[key] = input;
      row.append(span, input);
      panel.append(row);
      if (key === "matchCaptions") {
        const status = document.createElement("p");
        status.className = "ytdm-caption-status";
        status.setAttribute("role", "status");
        status.textContent = captionState?.status ?? "";
        status.hidden = !S.matchCaptions;
        panel.append(status);
      }
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
      panel.querySelector("input[name=enabled]").checked = S.enabled;
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
    captionState?.controller?.abort();
    captionState = null;
    showCaptionStatus();
    comments = [];
    schedule = [];
    clear();
    const id = new URLSearchParams(location.search).get("v");
    if (location.pathname !== "/watch" || !id) return;
    // プレイヤー生成待ち
    for (let i = 0; i < 50 && !setupPlayer(); i++) await new Promise((r) => setTimeout(r, 200));
    if (gen !== loadGen) return;
    const watchData = innertube({ videoId: id });
    captionState = { id, watchData, matches: new Map(), processed: 0 };
    refreshCaptionMatching();
    try {
      for await (const list of fetchComments(watchData)) {
        if (gen !== loadGen) return; // 別の動画へ移動済み
        comments = list;
        rebuild();
        refreshCaptionMatching();
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
