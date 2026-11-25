"use strict";

// ---------------------------------------------------------------- constants

const STORE_KEY = "cadence:v1";
const TICK_MS = 250;
const SEEK_STEP_SECONDS = 5;
const VOLUME_STEP = 5;
const RESTART_AFTER_SECONDS = 3;
const MAX_SKIPS_IN_A_ROW = 6;
const QUEUE_RENDER_LIMIT = 150;
const SUGGEST_DELAY_MS = 160;
const TOAST_MS = 3200;
const POSITION_SAVE_MS = 5000;
const MAX_TICK_GAP_MS = 1000;
const PLAY_COUNT_MIN_SECONDS = 30;
const PLAY_COUNT_SHARE = 0.5;
const PLAY_COUNT_CAP_SECONDS = 240;
const LYRIC_LEAD_SECONDS = 0.25;
const SKIP_GRACE_SECONDS = 0.5;
const LISTEN_AGAIN_COUNT = 12;
const HOME_CHIP_COUNT = 14;
const BLOCKED_EMBED_CODES = [101, 150, 152];
const IN_APP = Boolean(window.__TAURI__);
const SEARCH_KINDS = [
  ["songs", "Songs"], ["videos", "Videos"], ["albums", "Albums"],
  ["artists", "Artists"], ["playlists", "Playlists"], ["podcasts", "Podcasts"],
].filter(([kind]) => !(IN_APP && kind === "podcasts")); // the Android app's Rust client has no podcast support
const TRACK_KINDS = new Set(["songs", "videos"]);
const STARTER_SEARCHES = [
  "Arijit Singh", "Lo-fi beats", "Anirudh Ravichander", "Indie rock", "90s hip hop",
  "Coke Studio", "Synthwave", "Classical piano",
];

// ---------------------------------------------------------------- helpers

// Google's image servers refuse some album art when the request names another site as its
// referrer, so artwork is always fetched without one. (The page itself keeps its referrer:
// YouTube's embedded player won't play without it.)
function artImg(src, cls = "", { lazy = true } = {}) {
  if (!src) return `<span class="${cls} art-blank" aria-hidden="true"></span>`;
  return `<img class="${cls}" src="${esc(src)}" alt="" referrerpolicy="no-referrer"${lazy ? ' loading="lazy"' : ""}>`;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const enc = encodeURIComponent;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "–:––";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hueOf(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Library calls are answered on this device (store.js); music calls go to the Python API on the
// web, or straight to the Rust core inside the Android app. Sign-in secrets travel in headers.
const SECRET_HEADERS = { token: "X-Cadence-Token", refresh: "X-Cadence-Refresh", device: "X-Cadence-Device" };

async function api(path, body, secrets = {}) {
  const [route, query = ""] = path.split("?");
  const params = Object.fromEntries(new URLSearchParams(query));
  const local = localRoute(body === undefined ? "GET" : "POST", route, body === undefined ? params : body);
  if (local) {
    try {
      return local();
    } catch (err) {
      throw new Error(err?.message || "Couldn't save that on this device.");
    }
  }
  if (state.settings.language) params.hl = state.settings.language;
  if (state.settings.region) params.gl = state.settings.region;
  if (state.account && !route.startsWith("/api/auth/") && !secrets.token) {
    const token = await accessToken();
    if (token) secrets = { ...secrets, token };
  }
  try {
    return await remote(route, params, body, secrets);
  } catch (err) {
    if (err.status !== 401 || !secrets.token || !state.account) throw err;
    // Google rejected the token: refresh once; if that fails too, carry on signed out.
    state.account.expiresAt = 0;
    const fresh = await accessToken();
    const { token: _stale, ...rest } = secrets;
    return remote(route, params, body, fresh ? { ...rest, token: fresh } : rest);
  }
}

async function remote(route, params, body, secrets) {
  const tauri = window.__TAURI__?.core;
  if (tauri) {
    try {
      return await tauri.invoke("api", { path: route, params, body: body ?? null, secrets });
    } catch (err) {
      throw new Error(typeof err === "string" ? err : err?.message || "The music service didn't answer.");
    }
  }
  const headers = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [SECRET_HEADERS[k], v]));
  const init = body === undefined
    ? { headers }
    : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`${route}?${new URLSearchParams(params)}`, init);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(data.error || `The server answered ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- Google account

const ACCOUNT_KEY = "cadence:account:v1";
const TOKEN_REFRESH_MARGIN_SECONDS = 120;

function loadAccount() {
  try {
    const account = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null");
    // "app" accounts (Android in-app sign-in) keep their session in the Rust core, not here.
    if (account?.mode === "app") return IN_APP ? account : null;
    return account?.accessToken && account?.refreshToken ? account : null;
  } catch {
    return null;
  }
}

function saveAccount(account) {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* storage blocked: the sign-in lasts until the page closes */ }
}

let refreshing = null;
function accessToken() {
  const account = state.account;
  if (!account || account.mode === "app") return Promise.resolve(null);
  if (account.expiresAt - Date.now() / 1000 > TOKEN_REFRESH_MARGIN_SECONDS) return Promise.resolve(account.accessToken);
  refreshing ||= (async () => {
    try {
      const res = await remote("/api/auth/refresh", {}, undefined, { refresh: account.refreshToken });
      if (res.status !== "ok") {
        signedOut("Your Google sign-in ended. Sign in again in Settings.");
        return null;
      }
      state.account = { ...state.account, ...res.token, refreshToken: res.token.refreshToken || account.refreshToken };
      saveAccount(state.account);
      return state.account.accessToken;
    } catch (err) {
      toast(`Couldn't refresh your Google sign-in: ${err.message}`);
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function signedOut(message) {
  state.account = null;
  state.remoteLiked = [];
  state.remoteLikedIds = new Set();
  state.accountPlaylists = [];
  saveAccount(null);
  homeCache = null;
  renderNavPlaylists();
  renderAccountChip();
  renderLikes();
  if (message) toast(message);
}

// Your YouTube Music likes and playlists, fetched after sign-in and on "Sync now".
async function loadAccountLibrary({ announce = false } = {}) {
  if (!state.account) return;
  try {
    const [liked, playlists] = await Promise.all([api("/api/liked"), api("/api/account-playlists")]);
    state.remoteLiked = liked.items;
    state.remoteLikedIds = new Set(liked.items.map((t) => t.id));
    state.accountPlaylists = playlists.items;
    renderNavPlaylists();
    renderLikes();
    if (route.name === "liked") renderLiked();
    if (route.name === "library") renderLibrary();
    if (announce) toast(`Synced ${liked.items.length} liked songs and ${playlists.items.length} playlists`);
  } catch (err) {
    toast(`Couldn't load your YouTube Music library: ${err.message}`);
  }
}

// Liked songs: your account's likes first, then likes kept only on this device.
function likedTracks() {
  return [...state.remoteLiked, ...state.liked.filter((t) => !state.remoteLikedIds.has(t.id))];
}

// ---------------------------------------------------------------- icons

const stroke = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const solid = (d) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
const HEART = '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z"/>';
const I = {
  logo: `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="var(--accent)"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="var(--accent-ink)" stroke-opacity=".35" stroke-width="1.2"/><circle cx="16" cy="16" r="4" fill="var(--accent-ink)"/><path d="M16 4.5A11.5 11.5 0 0 1 27.5 16" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round"/></svg>`,
  home: stroke('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11h5v-6h4v6h5V9"/>'),
  search: stroke('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  compass: stroke('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  heart: stroke(HEART),
  heartFill: solid(HEART),
  clock: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  play: solid('<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/>'),
  pause: solid('<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>'),
  next: solid('<path d="M5 6.3v11.4a.9.9 0 0 0 1.38.76l8.5-5.7a.9.9 0 0 0 0-1.52l-8.5-5.7A.9.9 0 0 0 5 6.3z"/><rect x="16.5" y="5" width="2.6" height="14" rx="1.1"/>'),
  prev: solid('<path d="M19 6.3v11.4a.9.9 0 0 1-1.38.76l-8.5-5.7a.9.9 0 0 1 0-1.52l8.5-5.7A.9.9 0 0 1 19 6.3z"/><rect x="4.9" y="5" width="2.6" height="14" rx="1.1"/>'),
  shuffle: stroke('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>'),
  repeat: stroke('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  repeatOne: stroke('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10.5 12.5 9.5v5"/>'),
  volume: stroke('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  volumeLow: stroke('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  mute: stroke('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
  queue: stroke('<path d="M4 6h11"/><path d="M4 12h11"/><path d="M4 18h7"/><path d="M19 8v9"/><circle cx="17" cy="17" r="2"/>'),
  addQueue: stroke('<path d="M4 6h12"/><path d="M4 12h8"/><path d="M4 18h8"/><path d="M18 13v7"/><path d="M14.5 16.5h7"/>'),
  playNext: stroke('<path d="M4 6h16"/><path d="M4 12h8"/><path d="M4 18h8"/><path d="m15.5 13.5 5 3-5 3z"/>'),
  radio: stroke('<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/>'),
  sparkle: stroke('<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9-5.7-1.8L10.2 9z"/><path d="M19 3v3"/><path d="M17.5 4.5h3"/>'),
  lyrics: stroke('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M9 10h6"/><path d="M9 13.5h4"/>'),
  moon: stroke('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  x: stroke('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  up: stroke('<path d="m6 15 6-6 6 6"/>'),
  dots: solid('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  library: stroke('<path d="M5 4v16"/><path d="M10 4v16"/><path d="m15 4.5 4.5 15"/>'),
  album: stroke('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
  person: stroke('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  listAdd: stroke('<path d="M4 6h12"/><path d="M4 12h12"/><path d="M4 18h7"/><path d="M18 14v7"/><path d="M14.5 17.5h7"/>'),
  plus: stroke('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  playlist: stroke('<path d="M4 6h12"/><path d="M4 12h12"/><path d="M4 18h7"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M20 17.5V9"/>'),
  chart: stroke('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  gear: stroke('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  pip: stroke('<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/>'),
  expand: stroke('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  edit: stroke('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: stroke('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  down: stroke('<path d="m6 9 6 6 6-6"/>'),
};

// ---------------------------------------------------------------- elements and state

const els = Object.fromEntries([
  "app", "view", "q", "suggest", "search-form", "np", "np-close", "np-title", "np-artist", "np-like",
  "tab-queue", "tab-lyrics", "panel-queue", "panel-lyrics", "lyrics-side", "queue", "q-count", "q-clear",
  "autoplay", "scrim", "bar-art", "bar-title", "bar-artist", "bar-like", "shuffle", "prev", "play", "next",
  "repeat", "t-cur", "seek", "t-dur", "lyrics-btn", "sleep-btn", "sleep-left", "sleep-pop", "np-toggle",
  "mute", "vol", "lyrics-full", "lf-art", "lf-title", "lf-artist", "lf-close", "lyrics-full-body", "toast",
  "liked-count", "bd-a", "bd-b", "np-quality", "np-cover",
].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));

const state = {
  queue: [],
  index: -1,
  shuffle: false,
  repeat: "off",
  autoplay: true,
  volume: 80,
  muted: false,
  position: 0,
  playing: false,
  liked: [],
  recent: [],
  playlists: [],
  searches: [],
  settings: {},
  account: null,
  remoteLiked: [],
  remoteLikedIds: new Set(),
  accountPlaylists: [],
  skipsInARow: 0,
  triedAlt: new Set(),
  segments: [],
  skippedSegments: new Set(),
  lyrics: { id: null, status: "idle", synced: null, plain: null },
  lyricIndex: -1,
  sleep: null,
  listen: { track: null, seconds: 0, last: 0 },
};

const current = () => state.queue[state.index] || null;
const isLiked = (id) => state.remoteLikedIds.has(id) || state.liked.some((t) => t.id === id);

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      queue: state.queue.slice(0, 500),
      index: state.index,
      shuffle: state.shuffle,
      repeat: state.repeat,
      autoplay: state.autoplay,
      volume: state.volume,
      muted: state.muted,
      position: Math.floor(state.position || 0),
    }));
  } catch { /* storage full or blocked: playback still works */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!saved) return;
    state.queue = Array.isArray(saved.queue) ? saved.queue : [];
    state.index = Number.isInteger(saved.index) ? Math.min(saved.index, state.queue.length - 1) : -1;
    state.shuffle = !!saved.shuffle;
    state.repeat = ["off", "all", "one"].includes(saved.repeat) ? saved.repeat : "off";
    state.autoplay = saved.autoplay !== false;
    state.volume = Number.isFinite(saved.volume) ? saved.volume : 80;
    state.muted = !!saved.muted;
    state.position = Number.isFinite(saved.position) ? saved.position : 0;
  } catch { /* corrupt or blocked storage: start fresh */ }
}

// ---------------------------------------------------------------- YouTube player

let players = [];
let player = null;
let playerReady = false;
let pendingLoad = null;
let tickTimer = null;
let seeking = false;
let lastPositionSave = 0;

const isUsable = (p) => typeof p?.setVolume === "function";

// The Android and desktop apps play each song's direct audio (engine.js) and fall back to YouTube's
// embedded player for a song that can't be streamed; the web version always uses the embed.
function loadYouTube() {
  if (DIRECT_AUDIO) {
    const handlers = {
      onReady: onPlayerReady,
      onStateChange: onPlayerState,
      onError: onPlayerError,
      onQuality: showQuality,
      onAdvance: adoptAdvance,
      onSleep: onNativeSleep,
    };
    const direct = (events) => (NATIVE_AUDIO ? new NativePlayer(events) : new ElementPlayer(events));
    // Desktop gets two players so crossfade can overlap songs; Android's single player queues the
    // next songs itself instead.
    const slots = NATIVE_AUDIO ? ["yt-a"] : ["yt-a", "yt-b"];
    players = slots.map((slot) => new HybridPlayer(handlers, direct, slot));
    player = players[0];
    els.app.classList.add("direct-audio");
    return;
  }
  window.onYouTubeIframeAPIReady = () => {
    // Two players let one song fade out while the next fades in.
    players = ["yt-a", "yt-b"].map((id) => new YT.Player(id, {
      width: "100%",
      height: "100%",
      playerVars: { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0, origin: location.origin },
      events: { onReady: onPlayerReady, onStateChange: onPlayerState, onError: onPlayerError },
    }));
    player = players[0];
  };
  const script = document.createElement("script");
  script.src = "https://www.youtube.com/iframe_api";
  script.onerror = () => toast("Couldn't reach YouTube. Check your connection, then reload.");
  document.head.append(script);
}

function frontPlayer(active) {
  players.forEach((p) => p.getIframe?.()?.classList.toggle("front", p === active));
}

function onPlayerReady(event) {
  event.target.setVolume(state.volume);
  if (state.muted) event.target.mute();
  if (event.target !== players[0]) return;
  playerReady = true;
  frontPlayer(player);
  if (pendingLoad) {
    const run = pendingLoad;
    pendingLoad = null;
    run();
  } else if (current()) {
    player.cueVideoById({ videoId: current().id, startSeconds: state.position || 0 });
  }
}

function load(track, { autoplay = true, start = 0 } = {}) {
  const run = () => (autoplay
    ? player.loadVideoById({ videoId: track.id, startSeconds: start })
    : player.cueVideoById({ videoId: track.id, startSeconds: start }));
  if (playerReady) run();
  else pendingLoad = run;
}

function duration() {
  const fromPlayer = playerReady ? player.getDuration() : 0;
  return fromPlayer || current()?.duration || 0;
}

function onPlayerState(event) {
  if (event.target !== player) return;
  const S = YT_STATE;
  if (event.data === S.PLAYING) {
    state.playing = true;
    state.skipsInARow = 0;
    state.listen.last = performance.now();
    startTick();
  } else if (event.data === S.PAUSED || event.data === S.CUED) {
    state.playing = false;
    stopTick();
    tick();
    save();
  } else if (event.data === S.ENDED) {
    state.playing = false;
    stopTick();
    handleEnded();
  }
  renderPlayState();
}

async function onPlayerError(event) {
  if (event.target !== player) return;
  if (fade) endFade();
  const track = current();
  if (!track) return;
  state.playing = false;
  renderPlayState();
  state.skipsInARow += 1;
  if (state.skipsInARow > MAX_SKIPS_IN_A_ROW) {
    toast("Several songs in a row wouldn't play, so playback stopped.");
    return;
  }
  if (BLOCKED_EMBED_CODES.includes(event.data) && !state.triedAlt.has(track.id)) {
    state.triedAlt.add(track.id);
    try {
      const q = `${track.title} ${track.artist || ""}`.trim();
      const { track: alt } = await api(`/api/alternate?q=${enc(q)}&exclude=${enc(track.id)}`);
      if (alt && current() === track) {
        state.triedAlt.add(alt.id);
        state.queue[state.index] = alt;
        load(alt);
        onTrackChange();
        toast(`“${track.title}” can't play outside YouTube, so Cadence switched to another upload.`);
        return;
      }
    } catch { /* fall through to skipping */ }
  }
  if (current() !== track) return;
  toast(`“${track.title}” can't play here. Skipping.`);
  next(true);
}

function startTick() {
  stopTick();
  tickTimer = setInterval(tick, TICK_MS);
  tick();
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

function tick() {
  if (!playerReady) return;
  const now = performance.now();
  if (state.playing && state.listen.track) {
    state.listen.seconds += Math.min(now - state.listen.last, MAX_TICK_GAP_MS) / 1000;
  }
  state.listen.last = now;
  const t = player.getCurrentTime() || 0;
  const d = duration();
  state.position = t;
  if (!seeking) {
    els.tCur.textContent = fmt(t);
    els.seek.value = d ? Math.round((t / d) * 1000) : 0;
    setFill(els.seek);
  }
  els.tDur.textContent = fmt(d);
  checkSegments(t);
  highlightLyrics(t);
  maybeCrossfade(t, d);
  if (now - lastPositionSave > POSITION_SAVE_MS) {
    lastPositionSave = now;
    save();
  }
}

function setFill(range) {
  const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
  range.style.setProperty("--fill", `${pct}%`);
}

// ---------------------------------------------------------------- queue and playback

function playAt(i) {
  if (i < 0 || i >= state.queue.length) return;
  if (fade) endFade();
  flushListen();
  state.index = i;
  state.position = 0;
  load(state.queue[i]);
  onTrackChange();
}

function playList(list, i = 0) {
  if (!list.length) return;
  let queue = list.slice();
  let index = i;
  if (state.shuffle) {
    const [first] = queue.splice(i, 1);
    queue = [first, ...shuffled(queue)];
    index = 0;
  }
  state.queue = queue;
  playAt(index);
}

function playRadio(track) {
  state.queue = [track];
  playAt(0);
}

function playNext(track) {
  if (!current()) return playList([track]);
  state.queue.splice(state.index + 1, 0, { ...track });
  renderQueue();
  save();
  toast(`“${track.title}” plays next`);
}

function addToQueue(track) {
  if (!current()) return playList([track]);
  state.queue.push({ ...track });
  renderQueue();
  save();
  toast(`Added “${track.title}” to the queue`);
}

async function next(auto = false) {
  if (!state.queue.length) return;
  if (state.index < state.queue.length - 1) return playAt(state.index + 1);
  if (state.repeat === "all") return playAt(0);
  if (state.autoplay) {
    const added = await extendWithRadio();
    if (added) return playAt(state.index + 1);
  }
  if (!auto) toast("That's the end of the queue.");
}

function prev() {
  if (!current() || !playerReady) return;
  if (player.getCurrentTime() > RESTART_AFTER_SECONDS || state.index === 0) {
    player.seekTo(0, true);
    return;
  }
  playAt(state.index - 1);
}

function togglePlay() {
  const track = current();
  if (!track) {
    toast("Pick a song first.");
    return;
  }
  if (!playerReady) return;
  if (fade) endFade();
  const S = YT_STATE;
  const st = player.getPlayerState();
  if (st === S.PLAYING || st === S.BUFFERING) player.pauseVideo();
  else if (st === S.PAUSED || st === S.CUED || st === S.ENDED) player.playVideo();
  else load(track, { start: state.position || 0 });
}

function seekBy(seconds) {
  if (!playerReady || !current()) return;
  player.seekTo(Math.max(0, Math.min(duration(), player.getCurrentTime() + seconds)), true);
  tick();
}

function handleEnded() {
  flushListen();
  if (state.sleep?.endOfSong) {
    setSleep("off", false);
    toast("Sleep timer finished. Playback stopped.");
    return;
  }
  if (state.repeat === "one") {
    resetListen(current());
    player.seekTo(0, true);
    player.playVideo();
    return;
  }
  next(true);
}

let radioBusy = null;
function extendWithRadio() {
  const seed = state.queue[state.queue.length - 1];
  if (!seed) return Promise.resolve(0);
  if (radioBusy) return radioBusy;
  radioBusy = (async () => {
    renderQueue();
    try {
      const { items } = await api(`/api/radio?id=${enc(seed.id)}`);
      const have = new Set(state.queue.map((t) => t.id));
      const fresh = items.filter((t) => !have.has(t.id));
      state.queue.push(...fresh);
      save();
      return fresh.length;
    } catch (err) {
      toast(`Couldn't find more songs: ${err.message}`);
      return 0;
    } finally {
      radioBusy = null;
      renderQueue();
    }
  })();
  return radioBusy;
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.shuffle && state.queue.length > state.index + 2) {
    state.queue = [...state.queue.slice(0, state.index + 1), ...shuffled(state.queue.slice(state.index + 1))];
    renderQueue();
  }
  renderControls();
  save();
  toast(state.shuffle ? "Shuffle on" : "Shuffle off");
}

function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  renderControls();
  save();
  syncUpcoming();
  toast({ off: "Repeat off", all: "Repeating the queue", one: "Repeating this song" }[state.repeat]);
}

function applyVolume() {
  for (const p of players.filter(isUsable)) {
    if (state.muted) p.mute();
    else p.unMute();
    if (!fade) p.setVolume(state.volume);
  }
}

function setVolume(value) {
  state.volume = Math.max(0, Math.min(100, Math.round(value)));
  state.muted = state.volume === 0;
  applyVolume();
  renderVolume();
  save();
}

function toggleMute() {
  state.muted = !state.muted;
  if (!state.muted && state.volume === 0) state.volume = 50;
  applyVolume();
  renderVolume();
  save();
}

// ---------------------------------------------------------------- crossfade

let fade = null;
const FADE_STEP_MS = 100;
const MIN_FADE_TRACK_RATIO = 3;

function upcomingIndex() {
  if (state.repeat === "one") return -1;
  if (state.index < state.queue.length - 1) return state.index + 1;
  if (state.repeat === "all" && state.queue.length > 1) return 0;
  return -1;
}

function maybeCrossfade(t, d) {
  const seconds = Number(state.settings.crossfade) || 0;
  if (!seconds || fade || !state.playing || !d || d < seconds * MIN_FADE_TRACK_RATIO) return;
  if (d - t > seconds || state.sleep?.endOfSong) return;
  const spare = players.find((p) => p !== player);
  const i = upcomingIndex();
  if (i < 0 || !isUsable(spare)) return;
  const from = player;
  flushListen();
  spare.setVolume(0);
  if (!state.muted) spare.unMute();
  spare.loadVideoById({ videoId: state.queue[i].id });
  player = spare;
  frontPlayer(spare);
  fade = { from, to: spare, started: performance.now(), ms: seconds * 1000 };
  fade.timer = setInterval(stepFade, FADE_STEP_MS);
  state.index = i;
  state.position = 0;
  onTrackChange();
}

function stepFade() {
  if (!fade) return;
  const progress = Math.min(1, (performance.now() - fade.started) / fade.ms);
  fade.from.setVolume(Math.round(state.volume * (1 - progress)));
  fade.to.setVolume(Math.round(state.volume * progress));
  if (progress >= 1) endFade();
}

function endFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  const { from, to } = fade;
  fade = null;
  from.stopVideo();
  from.setVolume(state.volume);
  to.setVolume(state.volume);
}

function onTrackChange() {
  const track = current();
  state.segments = [];
  state.skippedSegments.clear();
  state.lyricIndex = -1;
  resetListen(track);
  renderNowPlaying();
  renderQueue();
  markCurrentRows();
  save();
  updateMediaSession(track);
  setBackdrop(track?.art);
  document.title = track ? `${track.title} · ${track.artist || "Cadence"}` : "Cadence";
  if (track) {
    loadLyrics(track);
    loadSegments(track);
  }
  if (track && state.autoplay && state.index >= state.queue.length - 1) extendWithRadio();
}

// ---------------------------------------------------------------- what the direct player does by itself

const LOOKAHEAD = 6;
const RADIO_TOPUP_BELOW = 3;
const SYNC_DELAY_MS = 300;

// The songs after the current one, as they will really play: the queue wraps for "repeat all", and
// nothing follows when this song repeats or the sleep timer waits for it to end.
function upcomingTracks(limit = LOOKAHEAD) {
  if (state.repeat === "one" || state.sleep?.endOfSong) return [];
  const out = state.queue.slice(state.index + 1, state.index + 1 + limit);
  if (state.repeat === "all" && out.length < limit) out.push(...state.queue.slice(0, state.index + 1).slice(0, limit - out.length));
  return out;
}

// Tells the player which songs come next, so on Android it can carry on (gaplessly) while the page
// sleeps with the screen off, and on desktop the next song is looked up ahead of time.
let syncTimer = null;
function syncUpcoming() {
  if (!DIRECT_AUDIO) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (!playerReady || !current()) return;
    topUpRadio();
    player.setUpcoming?.(upcomingTracks(), state.repeat === "one" && !state.sleep?.endOfSong);
  }, SYNC_DELAY_MS);
}

// With the screen off nothing can fetch similar songs once the queue runs dry, so do it early.
const radioTried = new Set();
function topUpRadio() {
  if (!NATIVE_AUDIO || !state.autoplay || state.repeat !== "off" || state.sleep?.endOfSong || radioBusy) return;
  const seed = state.queue[state.queue.length - 1];
  if (!seed || state.queue.length - state.index - 1 >= RADIO_TOPUP_BELOW || radioTried.has(seed.id)) return;
  radioTried.add(seed.id);
  extendWithRadio();
}

// The Android player started the next queued song by itself.
function adoptAdvance(track) {
  let i = state.queue.indexOf(track);
  if (i < 0) i = state.queue.findIndex((t) => t.id === track.id);
  if (i < 0) {
    // It was removed from the queue after being handed over; show what is really playing.
    state.queue.splice(state.index + 1, 0, track);
    i = state.index + 1;
  }
  flushListen();
  state.index = i;
  state.position = 0;
  state.skipsInARow = 0;
  onTrackChange();
}

function onNativeSleep() {
  if (!state.sleep?.until) return;
  setSleep("off", false);
  toast("Sleep timer finished. Paused.");
}

// "Opus · 160 kbps": what the current song is really playing at.
function showQuality(source, label) {
  if (players.length > 1 && source !== player) return;
  els.npQuality.textContent = label || "";
  els.npQuality.hidden = !label;
}

// ---------------------------------------------------------------- play history

function resetListen(track) {
  state.listen = { track: track || null, seconds: 0, last: performance.now() };
}

function flushListen() {
  const { track, seconds } = state.listen;
  resetListen(null);
  if (!track) return;
  const dur = track.duration || 0;
  const needed = dur
    ? Math.min(Math.max(PLAY_COUNT_MIN_SECONDS, dur * PLAY_COUNT_SHARE), PLAY_COUNT_CAP_SECONDS, dur * 0.9)
    : PLAY_COUNT_MIN_SECONDS;
  if (seconds < needed) return;
  // The history is stored on this device and written synchronously, so this is safe on page close.
  api("/api/played", { track, seconds: Math.round(seconds) })
    .then((lib) => {
      applyLibrary(lib);
      if (route.name === "recent") renderRecent();
    })
    .catch(() => { /* a missed history entry isn't worth interrupting playback */ });
  // Signed in: also tell YouTube Music, which improves its recommendations (can be turned off).
  if (state.account && state.account.mode !== "app" && state.settings.syncHistory !== false) {
    api("/api/history", { id: track.id }).catch(() => { /* recommendations are a nicety */ });
  }
}

function applyLibrary(lib) {
  state.liked = lib.liked || [];
  state.recent = lib.recent || [];
  state.playlists = lib.playlists || [];
  state.searches = lib.searches || [];
  state.settings = lib.settings || {};
  audioFx.configure(state.settings);
  renderNavPlaylists();
}

// ---------------------------------------------------------------- SponsorBlock

let segmentsSeq = 0;
async function loadSegments(track) {
  if (!track.video || state.settings.sponsorblock === false) return;
  const seq = ++segmentsSeq;
  try {
    const { segments } = await api(`/api/skips?id=${enc(track.id)}`);
    if (seq === segmentsSeq && current()?.id === track.id) state.segments = segments;
  } catch { /* skipping is a nicety; play the whole video if SponsorBlock is unreachable */ }
}

function checkSegments(t) {
  if (!state.playing) return;
  state.segments.forEach((seg, i) => {
    if (t >= seg.start && t < seg.end - SKIP_GRACE_SECONDS && !state.skippedSegments.has(i)) {
      state.skippedSegments.add(i);
      player.seekTo(seg.end, true);
      toast(seg.category === "music_offtopic" ? "Skipped a non-music part" : "Skipped a sponsor segment");
    }
  });
}

// ---------------------------------------------------------------- lyrics

let lyricsSeq = 0;
async function loadLyrics(track) {
  const seq = ++lyricsSeq;
  state.lyrics = { id: track.id, status: "loading", synced: null, plain: null };
  renderLyrics();
  try {
    const q = new URLSearchParams({
      title: track.title, artist: track.artist || "", duration: track.duration || "", video: track.video ? "1" : "0",
    });
    const data = await api(`/api/lyrics?${q}`);
    if (seq !== lyricsSeq) return;
    const status = data.synced || data.plain ? "ready" : data.instrumental ? "instrumental" : "none";
    state.lyrics = { id: track.id, status, synced: data.synced, plain: data.plain };
  } catch (err) {
    if (seq !== lyricsSeq) return;
    state.lyrics = { id: track.id, status: "error", error: err.message };
  }
  state.lyricIndex = -1;
  renderLyrics();
}

function lyricsNote(title, body = "") {
  return `<div class="lyrics-note"><p class="empty-title">${esc(title)}</p>${body ? `<p>${esc(body)}</p>` : ""}</div>`;
}

function lyricsHTML() {
  const lyr = state.lyrics;
  if (!current()) return lyricsNote("Nothing playing", "Play a song to see its lyrics here.");
  if (lyr.status === "loading") return lyricsNote("Looking for lyrics…");
  if (lyr.status === "instrumental") return lyricsNote("This one's instrumental.");
  if (lyr.status === "none") return lyricsNote("No lyrics for this song yet.", "LRCLIB doesn't have them.");
  if (lyr.status === "error") return lyricsNote("Couldn't load lyrics.", lyr.error);
  const source = '<p class="lyrics-source">Lyrics from LRCLIB</p>';
  if (lyr.synced) {
    return lyr.synced.map((line, i) => (
      `<button class="lyric" type="button" data-i="${i}" data-t="${line.t}" title="Jump to ${fmt(line.t)}">${esc(line.text) || "♪"}</button>`
    )).join("") + source;
  }
  return (lyr.plain || "").split("\n").map((line) => `<p class="lyric">${esc(line) || "&nbsp;"}</p>`).join("") + source;
}

function renderLyrics() {
  const html = lyricsHTML();
  for (const box of [els.lyricsSide, els.lyricsFullBody]) {
    box.innerHTML = html;
    box.classList.toggle("plain", !state.lyrics.synced);
  }
  highlightLyrics(state.position, true);
}

function highlightLyrics(t, force = false) {
  const lines = state.lyrics.synced;
  if (!lines) return;
  const target = t + LYRIC_LEAD_SECONDS;
  let lo = 0;
  let hi = lines.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= target) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === state.lyricIndex && !force) return;
  state.lyricIndex = idx;
  for (const box of [els.lyricsSide, els.lyricsFullBody]) {
    $$(".lyric", box).forEach((el, i) => {
      el.classList.toggle("on", i === idx);
      el.classList.toggle("past", i < idx);
    });
    const on = $(".lyric.on", box);
    if (on && box.clientHeight) {
      box.scrollTo({ top: on.offsetTop - box.clientHeight * 0.35, behavior: force ? "auto" : "smooth" });
    }
  }
}

function openLyrics() {
  els.lyricsFull.hidden = false;
  renderNowPlaying();
  highlightLyrics(state.position, true);
  els.lfClose.focus();
}

function closeLyrics() {
  els.lyricsFull.hidden = true;
  els.lyricsBtn.focus();
}

// ---------------------------------------------------------------- sleep timer

let sleepTimer = null;
function setSleep(value, announce = true) {
  clearInterval(sleepTimer);
  state.sleep = null;
  if (value === "end") {
    state.sleep = { endOfSong: true };
  } else if (value !== "off") {
    state.sleep = { until: Date.now() + Number(value) * 60000 };
    sleepTimer = setInterval(sleepTick, 1000);
  }
  renderSleep();
  // The timer also runs where the music does, so it still fires while the page sleeps.
  player?.setSleep?.(state.sleep?.until ? Number(value) * 60 : 0);
  syncUpcoming();
  if (!announce) return;
  if (!state.sleep) toast("Sleep timer off");
  else if (state.sleep.endOfSong) toast("Playback stops when this song ends");
  else toast(`Playback stops in ${value} minutes`);
}

function sleepTick() {
  if (!state.sleep?.until) return;
  if (Date.now() >= state.sleep.until) {
    setSleep("off", false);
    if (playerReady) player.pauseVideo();
    toast("Sleep timer finished. Paused.");
    return;
  }
  renderSleep();
}

function renderSleep() {
  let label = "";
  if (state.sleep?.endOfSong) label = "End";
  else if (state.sleep?.until) label = fmt((state.sleep.until - Date.now()) / 1000);
  els.sleepLeft.textContent = label;
  els.sleepBtn.classList.toggle("on", !!state.sleep);
  els.sleepBtn.setAttribute("aria-label", state.sleep ? `Sleep timer: ${label === "End" ? "end of song" : `${label} left`}` : "Sleep timer");
}

// ---------------------------------------------------------------- backdrop, media session, toast

let backdropFront = null;
function setBackdrop(url) {
  if (!url) {
    els.bdA.classList.remove("on");
    els.bdB.classList.remove("on");
    backdropFront = null;
    return;
  }
  if (backdropFront?.dataset.url === url) return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.onload = () => {
    if (current()?.art !== url) return;
    const back = backdropFront === els.bdA ? els.bdB : els.bdA;
    back.replaceChildren(img);
    back.dataset.url = url;
    back.classList.add("on");
    backdropFront?.classList.remove("on");
    backdropFront = back;
  };
  img.src = url;
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || "",
      album: track.album || "",
      artwork: track.art ? [{ src: track.art, sizes: "544x544" }] : [],
    });
  } catch { /* older browsers lack MediaMetadata */ }
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), TOAST_MS);
}

// ---------------------------------------------------------------- now playing, queue, controls

function artistLink(track) {
  if (!track.artist) return "";
  return track.artistId
    ? `<a href="#artist/${enc(track.artistId)}">${esc(track.artist)}</a>`
    : `<a href="#search/songs/${enc(track.artist.split(",")[0].trim())}">${esc(track.artist)}</a>`;
}

function renderNowPlaying() {
  const track = current();
  els.app.classList.toggle("has-track", !!track);
  els.npTitle.textContent = track?.title || "Nothing playing";
  els.npArtist.innerHTML = track
    ? artistLink(track) + (track.album && track.albumId
      ? `<span class="sep">·</span><a href="#album/${enc(track.albumId)}">${esc(track.album)}</a>`
      : "")
    : "";
  els.barTitle.textContent = track?.title || "Nothing playing";
  els.barArtist.innerHTML = track ? artistLink(track) || "&nbsp;" : "Search for a song to begin";
  els.barArt.innerHTML = track?.art ? artImg(track.art, "", { lazy: false }) : "";
  els.npCover.innerHTML = track?.art ? artImg(track.art, "", { lazy: false }) : "";
  els.lfArt.innerHTML = track?.art ? artImg(track.art, "", { lazy: false }) : "";
  els.lfTitle.textContent = track?.title || "Nothing playing";
  els.lfArtist.textContent = track?.artist || "";
  for (const btn of [els.npLike, els.barLike]) {
    btn.hidden = !track;
    if (track) btn.dataset.like = track.id;
  }
  renderLikes();
  renderMini();
}

function renderQueue() {
  syncUpcoming();
  const upcoming = state.queue.slice(state.index + 1);
  els.qCount.textContent = upcoming.length ? String(upcoming.length) : "";
  if (!upcoming.length) {
    const message = radioBusy
      ? "Finding similar songs…"
      : current()
        ? "Nothing queued. Use + on any song to add it."
        : "Your queue is empty.";
    els.queue.innerHTML = `<li class="q-empty">${message}</li>`;
    return;
  }
  els.queue.innerHTML = upcoming.slice(0, QUEUE_RENDER_LIMIT).map((t, k) => {
    const i = state.index + 1 + k;
    return `<li class="q-item" data-qi="${i}">
      <button class="q-hit" type="button" data-qact="play" aria-label="Play ${esc(t.title)}"></button>
      ${artImg(t.art, "q-art")}
      <span class="q-main"><span class="q-title">${esc(t.title)}</span><span class="q-sub">${esc(t.artist || "")}</span></span>
      <span class="q-time">${t.duration ? fmt(t.duration) : ""}</span>
      <button class="icon-btn" type="button" data-qact="remove" aria-label="Remove ${esc(t.title)} from the queue">${I.x}</button>
    </li>`;
  }).join("");
}

function renderPlayState() {
  els.play.innerHTML = state.playing ? I.pause : I.play;
  els.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  els.app.classList.toggle("is-playing", state.playing);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  renderMini();
}

function renderControls() {
  els.shuffle.classList.toggle("on", state.shuffle);
  els.shuffle.setAttribute("aria-pressed", String(state.shuffle));
  els.repeat.innerHTML = state.repeat === "one" ? I.repeatOne : I.repeat;
  els.repeat.classList.toggle("on", state.repeat !== "off");
  els.repeat.setAttribute("aria-label", `Repeat: ${{ off: "off", all: "whole queue", one: "this song" }[state.repeat]}`);
  els.autoplay.checked = state.autoplay;
  renderVolume();
}

function renderVolume() {
  const level = state.muted ? 0 : state.volume;
  els.vol.value = level;
  setFill(els.vol);
  els.mute.innerHTML = level === 0 ? I.mute : level < 50 ? I.volumeLow : I.volume;
  els.mute.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
}

function renderLikes() {
  $$("[data-like]").forEach((btn) => {
    const on = isLiked(btn.dataset.like);
    btn.classList.toggle("on", on);
    btn.innerHTML = on ? I.heartFill : I.heart;
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Remove from Liked songs" : "Add to Liked songs");
  });
  els.likedCount.textContent = likedTracks().length || "";
}

function markCurrentRows() {
  const id = current()?.id;
  $$(".row[data-id]").forEach((row) => row.classList.toggle("is-current", row.dataset.id === id));
}

async function toggleLike(track) {
  if (!track) return;
  const liked = !isLiked(track.id);
  const before = state.liked;
  state.liked = liked ? [track, ...before.filter((t) => t.id !== track.id)] : before.filter((t) => t.id !== track.id);
  renderLikes();
  try {
    applyLibrary(await api("/api/like", { track, liked }));
  } catch (err) {
    state.liked = before;
    renderLikes();
    toast(`Couldn't save that: ${err.message}`);
    return;
  }
  if (state.account) {
    if (liked) {
      state.remoteLikedIds.add(track.id);
      state.remoteLiked = [track, ...state.remoteLiked.filter((t) => t.id !== track.id)];
    } else {
      state.remoteLikedIds.delete(track.id);
      state.remoteLiked = state.remoteLiked.filter((t) => t.id !== track.id);
    }
  }
  renderLikes();
  if (route.name === "liked") renderLiked();
  if (!state.account) {
    toast(liked ? "Added to Liked songs" : "Removed from Liked songs");
    return;
  }
  try {
    await api("/api/rate", { id: track.id, rating: liked ? "LIKE" : "INDIFFERENT" });
    toast(liked ? "Liked here and on YouTube Music" : "Removed from Liked songs here and on YouTube Music");
  } catch (err) {
    toast(`Saved here, but YouTube Music didn't take it: ${err.message}`);
  }
}

function showPanel(which) {
  const lyrics = which === "lyrics";
  els.tabQueue.setAttribute("aria-selected", String(!lyrics));
  els.tabLyrics.setAttribute("aria-selected", String(lyrics));
  els.panelQueue.hidden = lyrics;
  els.panelLyrics.hidden = !lyrics;
  document.getElementById("q-actions").hidden = lyrics;
  if (lyrics) highlightLyrics(state.position, true);
}

// ---------------------------------------------------------------- view building blocks

const lists = new Map();
let listSeq = 0;
function registerList(tracks) {
  listSeq += 1;
  lists.set(listSeq, tracks);
  return listSeq;
}

const eqBars = () => '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
const likeBtn = (id, on) => (
  `<button class="icon-btn like${on ? " on" : ""}" type="button" data-act="like" data-like="${esc(id)}" aria-pressed="${on}" aria-label="${on ? "Remove from" : "Add to"} Liked songs">${on ? I.heartFill : I.heart}</button>`
);

function rowHTML(t, i, listId, opts) {
  const isCur = current()?.id === t.id;
  const lead = opts.numbered
    ? `<span class="row-n">${eqBars()}<span class="n">${i + 1}</span></span>`
    : `<span class="row-art-wrap">${artImg(t.art, "row-art")}${eqBars()}</span>`;
  const album = opts.album
    ? `<span class="row-album">${t.album ? (t.albumId ? `<a href="#album/${enc(t.albumId)}">${esc(t.album)}</a>` : esc(t.album)) : ""}</span>`
    : "";
  const plays = opts.plays ? `<span class="row-plays">${t.plays} play${t.plays === 1 ? "" : "s"}</span>` : "";
  return `<li class="row${isCur ? " is-current" : ""}" data-list="${listId}" data-i="${i}" data-id="${esc(t.id)}"${opts.radio ? ' data-mode="radio"' : ""}>
    <button class="row-hit" type="button" data-act="play" aria-label="Play ${esc(t.title)}${t.artist ? ` by ${esc(t.artist)}` : ""}"></button>
    ${lead}
    <span class="row-main">
      <span class="row-title">${esc(t.title)}${t.explicit ? '<span class="badge" title="Explicit">E</span>' : ""}</span>
      <span class="row-sub">${t.video ? '<span class="badge">Video</span>' : ""}${artistLink(t) || "Unknown artist"}</span>
    </span>
    ${album}${plays}
    <span class="row-actions">
      ${opts.editable ? `<button class="icon-btn" type="button" data-act="up" aria-label="Move up" title="Move up"${i === 0 ? " disabled" : ""}>${I.up}</button>
      <button class="icon-btn" type="button" data-act="down" aria-label="Move down" title="Move down"${i === opts.count - 1 ? " disabled" : ""}>${I.down}</button>
      <button class="icon-btn" type="button" data-act="remove" aria-label="Remove from this playlist" title="Remove from playlist">${I.x}</button>` : ""}
      <button class="icon-btn" type="button" data-act="next" aria-label="Play next" title="Play next">${I.playNext}</button>
      <button class="icon-btn" type="button" data-act="queue" aria-label="Add to queue" title="Add to queue">${I.addQueue}</button>
      <button class="icon-btn" type="button" data-act="playlist" aria-label="Add to a playlist" title="Add to a playlist" aria-haspopup="menu">${I.listAdd}</button>
      ${likeBtn(t.id, isLiked(t.id))}
      <button class="icon-btn more-btn" type="button" data-act="more" aria-label="More options for ${esc(t.title)}" aria-haspopup="menu">${I.dots}</button>
    </span>
    <span class="row-time">${t.duration ? fmt(t.duration) : ""}</span>
  </li>`;
}

function tracksBlock(tracks, opts = {}) {
  const id = registerList(tracks);
  const cls = ["tracks", opts.grid ? "grid-tracks" : ""].join(" ").trim();
  return { id, html: `<ol class="${cls}">${tracks.map((t, i) => rowHTML(t, i, id, opts)).join("")}</ol>` };
}

const cardHTML = (c) => (
  `<a class="card ${esc(c.kind)}" href="#${esc(c.kind)}/${enc(c.id)}">${artImg(c.art, "card-art")}<span class="card-title">${esc(c.title)}</span>${c.subtitle ? `<span class="card-sub">${esc(c.subtitle)}</span>` : ""}</a>`
);

function shelfHTML(shelf) {
  if (shelf.kind === "tracks") {
    const block = tracksBlock(shelf.items, { grid: true });
    return `<section class="shelf"><div class="shelf-head"><h2>${esc(shelf.title)}</h2><button class="text-btn" type="button" data-collect="play" data-list="${block.id}">Play all</button></div>${block.html}</section>`;
  }
  return `<section class="shelf"><div class="shelf-head"><h2>${esc(shelf.title)}</h2></div><div class="scroller">${shelf.items.map(cardHTML).join("")}</div></section>`;
}

const emptyHTML = (title, body = "", extra = "") => (
  `<div class="empty"><p class="empty-title">${esc(title)}</p>${body ? `<p>${esc(body)}</p>` : ""}${extra}</div>`
);
const errorHTML = (message) => emptyHTML("Something went wrong", message, '<button class="btn" type="button" data-retry>Try again</button>');
const skelRows = (n = 8) => Array.from({ length: n }, () => (
  '<div class="skel-row"><span class="skel" style="width:44px;height:44px"></span><span class="skel-lines"><span class="skel" style="width:46%"></span><span class="skel" style="width:28%"></span></span></div>'
)).join("");
const skelCards = (n = 6) => `<div class="scroller">${Array.from({ length: n }, () => '<span class="skel skel-card"></span>').join("")}</div>`;
const skelShelves = () => Array.from({ length: 3 }, () => `<section class="shelf"><span class="skel skel-h"></span>${skelCards()}</section>`).join("");
const skelHero = () => `<div class="hero"><span class="skel skel-hero"></span><div class="hero-text"><span class="skel" style="width:30%;height:28px"></span><span class="skel" style="width:20%"></span></div></div>${skelRows(6)}`;

function heroHTML({ art, round = false, artHTML = "", kind = "", title, subtitle = "", meta = [], desc = "", listId, extraButtons = "" }) {
  const cover = artHTML || artImg(art, `hero-art${round ? " round" : ""}`, { lazy: false });
  const actions = listId
    ? `<div class="hero-actions"><button class="btn primary" type="button" data-collect="play" data-list="${listId}">${I.play} Play</button><button class="btn" type="button" data-collect="shuffle" data-list="${listId}">${I.shuffle} Shuffle</button>${extraButtons}</div>`
    : extraButtons ? `<div class="hero-actions">${extraButtons}</div>` : "";
  return `<header class="hero">${cover}<div class="hero-text">${kind ? `<p class="hero-kind">${esc(kind)}</p>` : ""}<h1>${esc(title)}</h1>${subtitle ? `<p class="hero-sub">${subtitle}</p>` : ""}${meta.length ? `<p class="hero-meta">${meta.map(esc).join(" · ")}</p>` : ""}${desc ? `<p class="hero-desc">${esc(desc)}</p>` : ""}${actions}</div></header>`;
}

// ---------------------------------------------------------------- router

const route = { name: "home", parts: [] };
let routeToken = 0;

function setView(html) {
  els.view.innerHTML = html;
}

function stillHere(token) {
  return token === routeToken;
}

function renderRoute(resetScroll = true) {
  const parts = location.hash.slice(1).split("/").map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  route.name = parts[0] || "home";
  route.parts = parts.slice(1);
  lists.clear();
  const token = ++routeToken;
  $$("[data-nav]").forEach((a) => {
    if (a.dataset.nav === route.name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  els.app.classList.remove("np-open");
  if (resetScroll) els.view.scrollTop = 0;
  const [a = "", ...rest] = route.parts;
  switch (route.name) {
    case "search": return renderSearch(a || "songs", rest.join("/"), token);
    case "explore": return renderExplore(token);
    case "mood": return renderMood(a, rest.join("/"), token);
    case "album":
    case "playlist":
    case "podcast": return renderCollection(route.name, a, token);
    case "artist": return renderArtist(a, token);
    case "liked": return renderLiked();
    case "recent": return renderRecent();
    case "my": return renderMyPlaylist(a);
    case "mix": return renderMix(a || "foryou");
    case "stats": return renderStats(a || "month");
    case "settings": return renderSettings();
    case "library": return renderLibrary();
    default: return renderHome(token);
  }
}

// ---------------------------------------------------------------- views

let homeCache = null;
let moodsCache = null;

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

async function renderHome(token) {
  let listenAgain = "";
  if (state.recent.length) {
    const block = tracksBlock(state.recent.slice(0, LISTEN_AGAIN_COUNT), { grid: true });
    listenAgain = `<section class="shelf"><div class="shelf-head"><h2>Listen again</h2><a class="text-btn" href="#recent">See all</a></div>${block.html}</section>`;
  }
  setView(`<h1 class="page-title">${greeting()}</h1><div class="chips scroll home-chips" id="home-chips"></div>${listenAgain}<div id="shelves">${skelShelves()}</div>`);
  loadHomeChips(token);
  try {
    const { shelves } = await (homeCache ||= api("/api/home"));
    if (!stillHere(token)) return;
    $("#shelves").innerHTML = shelves.map(shelfHTML).join("") || emptyHTML("YouTube Music sent an empty home page.", "Try searching instead.");
  } catch (err) {
    homeCache = null;
    if (stillHere(token)) $("#shelves").innerHTML = errorHTML(`Couldn't load the home feed. ${err.message}`);
  }
}

async function loadHomeChips(token) {
  try {
    const { groups } = await (moodsCache ||= api("/api/moods"));
    if (!stillHere(token)) return;
    const genres = groups.find((g) => /genre/i.test(g.title))?.items || [];
    const moodsList = groups.find((g) => /mood/i.test(g.title))?.items || [];
    const picks = [...moodsList.slice(0, 6), ...genres].slice(0, HOME_CHIP_COUNT);
    $("#home-chips").innerHTML = picks.map((m) => `<a class="chip" href="#mood/${enc(m.params)}/${enc(m.title)}">${esc(m.title)}</a>`).join("")
      + '<a class="chip" href="#explore">More…</a>';
  } catch {
    moodsCache = null;
  }
}

async function renderSearch(kind, query, token) {
  if (!SEARCH_KINDS.some(([k]) => k === kind)) kind = "songs";
  els.q.value = query;
  const tabs = SEARCH_KINDS.map(([k, label]) => (
    `<a class="tab" role="tab" aria-selected="${k === kind}" href="#search/${k}/${enc(query)}">${label}</a>`
  )).join("");
  if (!query) {
    const history = state.searches.length
      ? `<section class="shelf"><div class="shelf-head"><h2>Recent searches</h2><button class="text-btn" type="button" data-clear-history>Clear</button></div><div class="chips">${state.searches.map((s) => `<a class="chip history" href="#search/songs/${enc(s)}">${I.clock}${esc(s)}</a>`).join("")}</div></section>`
      : "";
    setView(`<h1 class="page-title">Search</h1>${history}<section class="shelf"><div class="shelf-head"><h2>Try something</h2></div><div class="chips">${STARTER_SEARCHES.map((s) => `<a class="chip" href="#search/songs/${enc(s)}">${esc(s)}</a>`).join("")}</div></section>`);
    els.q.focus();
    return;
  }
  setView(`<h1 class="page-title">Results for “${esc(query)}”</h1><div class="tabs" role="tablist">${tabs}</div><div id="results">${skelRows()}</div>`);
  try {
    const { items } = await api(`/api/search?q=${enc(query)}&type=${kind}`);
    if (!stillHere(token)) return;
    const box = $("#results");
    if (!items.length) {
      box.innerHTML = emptyHTML(`No ${kind} found for “${query}”.`, "Check the spelling or try another tab.");
    } else if (TRACK_KINDS.has(kind)) {
      box.innerHTML = tracksBlock(items, { album: kind === "songs", radio: true }).html;
    } else {
      box.innerHTML = `<div class="card-grid">${items.map(cardHTML).join("")}</div>`;
    }
  } catch (err) {
    if (stillHere(token)) $("#results").innerHTML = errorHTML(`Search failed. ${err.message}`);
  }
}

async function renderExplore(token) {
  setView(`<h1 class="page-title">Explore</h1><div id="moods">${skelRows(6)}</div>`);
  try {
    const { groups } = await (moodsCache ||= api("/api/moods"));
    if (!stillHere(token)) return;
    $("#moods").innerHTML = groups.map((g) => (
      `<section class="shelf"><div class="shelf-head"><h2>${esc(g.title)}</h2></div><div class="mood-grid">${g.items.map((m) => (
        `<a class="mood" style="--h:${hueOf(m.title)}" href="#mood/${enc(m.params)}/${enc(m.title)}">${esc(m.title)}</a>`
      )).join("")}</div></section>`
    )).join("");
  } catch (err) {
    moodsCache = null;
    if (stillHere(token)) $("#moods").innerHTML = errorHTML(`Couldn't load moods and genres. ${err.message}`);
  }
}

async function renderMood(params, title, token) {
  const mixBtn = `<button class="btn primary" type="button" data-mix="${esc(params)}" data-mix-title="${esc(title)}">${I.sparkle} Mix</button>`;
  setView(`${heroHTML({ artHTML: " ", kind: "Mood & genre", title, meta: ["Playlists picked by YouTube Music"], extraButtons: mixBtn })}<div id="mood-body">${skelCards()}</div>`);
  try {
    const { items } = await api(`/api/mood?params=${enc(params)}`);
    if (!stillHere(token)) return;
    $("#mood-body").innerHTML = items.length
      ? `<div class="card-grid">${items.map(cardHTML).join("")}</div>`
      : emptyHTML("No playlists here right now.");
  } catch (err) {
    if (stillHere(token)) $("#mood-body").innerHTML = errorHTML(`Couldn't load this mood. ${err.message}`);
  }
}

async function playMoodMix(button) {
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = "Mixing…";
  try {
    const { items } = await api(`/api/mood-mix?params=${enc(button.dataset.mix)}`);
    if (!items.length) throw new Error("No songs came back.");
    playList(items, 0);
    toast(`Mixed ${items.length} songs from ${button.dataset.mixTitle}`);
  } catch (err) {
    toast(`Couldn't build the mix: ${err.message}`);
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

async function renderCollection(kind, id, token) {
  setView(skelHero());
  try {
    const data = await api(`/api/${kind}?id=${enc(id)}`);
    if (!stillHere(token)) return;
    const block = tracksBlock(data.tracks, { numbered: kind === "album", album: kind === "playlist" });
    const subtitle = data.artistId
      ? `<a href="#artist/${enc(data.artistId)}">${esc(data.subtitle)}</a>`
      : esc(data.subtitle);
    setView(heroHTML({ art: data.art, kind: data.label, title: data.title, subtitle, meta: data.meta, listId: data.tracks.length ? block.id : null })
      + (data.tracks.length ? block.html : emptyHTML("Nothing playable here.", "Every track in this list is unavailable.")));
  } catch (err) {
    if (stillHere(token)) setView(errorHTML(`Couldn't open this ${kind}. ${err.message}`));
  }
}

async function renderArtist(id, token) {
  setView(skelHero());
  try {
    const a = await api(`/api/artist?id=${enc(id)}`);
    if (!stillHere(token)) return;
    const songs = tracksBlock(a.songs, {});
    const radioBtn = a.songs.length
      ? `<button class="btn" type="button" data-radio-list="${songs.id}">${I.radio} Radio</button>`
      : "";
    let html = heroHTML({ art: a.art, round: true, kind: "Artist", title: a.title, meta: a.meta, desc: a.description, listId: a.songs.length ? songs.id : null, extraButtons: radioBtn });
    if (a.songs.length) html += `<section class="shelf"><div class="shelf-head"><h2>Top songs</h2></div>${songs.html}</section>`;
    if (a.albums.length) html += `<section class="shelf"><div class="shelf-head"><h2>Albums</h2></div><div class="scroller">${a.albums.map(cardHTML).join("")}</div></section>`;
    if (a.singles.length) html += `<section class="shelf"><div class="shelf-head"><h2>Singles & EPs</h2></div><div class="scroller">${a.singles.map(cardHTML).join("")}</div></section>`;
    if (a.videos.length) html += `<section class="shelf"><div class="shelf-head"><h2>Videos</h2></div>${tracksBlock(a.videos, { grid: true }).html}</section>`;
    if (a.related.length) html += `<section class="shelf"><div class="shelf-head"><h2>Fans also like</h2></div><div class="scroller">${a.related.map(cardHTML).join("")}</div></section>`;
    setView(html);
  } catch (err) {
    if (stillHere(token)) setView(errorHTML(`Couldn't open this artist. ${err.message}`));
  }
}

function renderLiked() {
  if (route.name !== "liked") return;
  const tracks = likedTracks();
  const block = tracksBlock(tracks, { album: true });
  const count = tracks.length;
  setView(heroHTML({
    artHTML: `<div class="hero-art liked-art">${I.heartFill}</div>`,
    kind: "Playlist",
    title: "Liked songs",
    meta: [`${count} song${count === 1 ? "" : "s"}`, state.account ? "Synced with YouTube Music" : "Saved on this device"],
    listId: count ? block.id : null,
  }) + (count ? block.html : emptyHTML("No liked songs yet.", "Tap the heart on any song and it lands here.")));
}

function renderRecent() {
  if (route.name !== "recent") return;
  const block = tracksBlock(state.recent, { album: true });
  setView(`<h1 class="page-title">Recently played</h1>${state.recent.length
    ? block.html
    : emptyHTML("Nothing here yet.", "Songs show up after you've listened to at least half of them, or 4 minutes.")}`);
}

// ---------------------------------------------------------------- search box and suggestions

let suggestTimer = null;
let suggestSeq = 0;
let suggestItems = [];
let suggestIndex = -1;

function showSuggestions(items) {
  suggestItems = items;
  suggestIndex = -1;
  if (!items.length) return hideSuggestions();
  els.suggest.innerHTML = items.map((s, i) => `<li role="option" id="sg-${i}" data-i="${i}">${I.search}<span>${esc(s)}</span></li>`).join("");
  els.suggest.hidden = false;
  els.q.setAttribute("aria-expanded", "true");
}

function hideSuggestions() {
  els.suggest.hidden = true;
  els.q.setAttribute("aria-expanded", "false");
  els.q.removeAttribute("aria-activedescendant");
  suggestIndex = -1;
}

function moveSuggestion(step) {
  if (els.suggest.hidden || !suggestItems.length) return;
  suggestIndex = (suggestIndex + step + suggestItems.length + 1) % (suggestItems.length + 1) - 1;
  $$("li", els.suggest).forEach((li, i) => li.setAttribute("aria-selected", String(i === suggestIndex)));
  if (suggestIndex >= 0) els.q.setAttribute("aria-activedescendant", `sg-${suggestIndex}`);
  else els.q.removeAttribute("aria-activedescendant");
}

function submitSearch(text) {
  const query = text.trim();
  if (!query) return;
  hideSuggestions();
  const kind = route.name === "search" && route.parts[0] ? route.parts[0] : "songs";
  location.hash = `search/${kind}/${enc(query)}`;
  api("/api/search-history", { q: query }).then(applyLibrary).catch(() => { /* history is optional */ });
}

// ---------------------------------------------------------------- events

function bindEvents() {
  els.play.addEventListener("click", togglePlay);
  els.next.addEventListener("click", () => next());
  els.prev.addEventListener("click", prev);
  els.shuffle.addEventListener("click", toggleShuffle);
  els.repeat.addEventListener("click", cycleRepeat);
  els.mute.addEventListener("click", toggleMute);
  els.vol.addEventListener("input", () => setVolume(Number(els.vol.value)));
  els.seek.addEventListener("input", () => {
    seeking = true;
    els.tCur.textContent = fmt((duration() * els.seek.value) / 1000);
    setFill(els.seek);
  });
  els.seek.addEventListener("change", () => {
    const d = duration();
    if (playerReady && d) player.seekTo((d * els.seek.value) / 1000, true);
    seeking = false;
    state.lyricIndex = -1;
  });
  els.autoplay.addEventListener("change", () => {
    state.autoplay = els.autoplay.checked;
    save();
    if (state.autoplay && current() && state.index >= state.queue.length - 1) extendWithRadio();
    syncUpcoming();
  });
  els.qClear.addEventListener("click", () => {
    state.queue = state.queue.slice(0, state.index + 1);
    renderQueue();
    save();
  });
  els.queue.addEventListener("click", (e) => {
    const item = e.target.closest("[data-qi]");
    const btn = e.target.closest("[data-qact]");
    if (!item || !btn) return;
    const i = Number(item.dataset.qi);
    if (btn.dataset.qact === "remove") {
      state.queue.splice(i, 1);
      renderQueue();
      save();
    } else {
      playAt(i);
    }
  });
  for (const btn of [els.npLike, els.barLike]) btn.addEventListener("click", () => toggleLike(current()));
  els.tabQueue.addEventListener("click", () => showPanel("queue"));
  els.tabLyrics.addEventListener("click", () => showPanel("lyrics"));
  els.lyricsBtn.addEventListener("click", openLyrics);
  els.lfClose.addEventListener("click", closeLyrics);
  for (const box of [els.lyricsSide, els.lyricsFullBody]) {
    box.addEventListener("click", (e) => {
      const line = e.target.closest(".lyric[data-t]");
      if (!line || !playerReady) return;
      player.seekTo(Number(line.dataset.t), true);
      if (!state.playing) player.playVideo();
    });
  }

  els.sleepBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.sleepPop.hidden;
    els.sleepPop.hidden = !open;
    els.sleepBtn.setAttribute("aria-expanded", String(open));
    if (open) $("button", els.sleepPop).focus();
  });
  els.sleepPop.addEventListener("click", (e) => {
    const choice = e.target.closest("[data-sleep]");
    if (!choice) return;
    setSleep(choice.dataset.sleep);
    els.sleepPop.hidden = true;
    els.sleepBtn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (!els.sleepPop.hidden && !e.target.closest(".pop-wrap")) {
      els.sleepPop.hidden = true;
      els.sleepBtn.setAttribute("aria-expanded", "false");
    }
    if (!e.target.closest(".search")) hideSuggestions();
  });

  const toggleSheet = () => els.app.classList.toggle("np-open");
  els.npToggle.addEventListener("click", toggleSheet);
  els.barTitle.addEventListener("click", toggleSheet);
  els.npClose.addEventListener("click", () => els.app.classList.remove("np-open"));
  els.scrim.addEventListener("click", () => els.app.classList.remove("np-open"));

  els.view.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return renderRoute(false);
    if (e.target.closest("[data-clear-history]")) {
      api("/api/search-history", { clear: true }).then((lib) => {
        applyLibrary(lib);
        renderRoute(false);
      }).catch((err) => toast(`Couldn't clear history: ${err.message}`));
      return;
    }
    const mix = e.target.closest("[data-mix]");
    if (mix) return playMoodMix(mix);
    const radioBtn = e.target.closest("[data-radio-list]");
    if (radioBtn) {
      const list = lists.get(Number(radioBtn.dataset.radioList)) || [];
      if (list.length) playRadio(list[0]);
      return;
    }
    const collect = e.target.closest("[data-collect]");
    if (collect) {
      const list = lists.get(Number(collect.dataset.list)) || [];
      if (!list.length) return;
      if (collect.dataset.collect === "shuffle") {
        if (!state.shuffle) {
          state.shuffle = true;
          renderControls();
          save();
        }
        playList(list, Math.floor(Math.random() * list.length));
      } else {
        playList(list, 0);
      }
      return;
    }
    const btn = e.target.closest("[data-act]");
    const row = e.target.closest(".row");
    if (!btn || !row) return;
    const list = lists.get(Number(row.dataset.list));
    const track = list?.[Number(row.dataset.i)];
    if (!track) return;
    const act = btn.dataset.act;
    if (act === "play") {
      if (row.dataset.mode === "radio") playRadio(track);
      else playList(list, Number(row.dataset.i));
    } else if (act === "next") playNext(track);
    else if (act === "queue") addToQueue(track);
    else if (act === "like") toggleLike(track);
    else if (act === "playlist") openPlaylistMenu(btn, [track]);
    else if (act === "more") openTrackMenu(btn, track);
    else if (act === "up" || act === "down" || act === "remove") editMyPlaylistRow(act, Number(row.dataset.i));
  });

  els.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitSearch(suggestIndex >= 0 ? suggestItems[suggestIndex] : els.q.value);
    els.q.blur();
  });
  els.q.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const text = els.q.value.trim();
    if (!text) return hideSuggestions();
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      try {
        const { items } = await api(`/api/suggest?q=${enc(text)}`);
        if (seq === suggestSeq && els.q.value.trim() === text && document.activeElement === els.q) showSuggestions(items);
      } catch { /* suggestions are optional */ }
    }, SUGGEST_DELAY_MS);
  });
  els.q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
    else if (e.key === "Escape") { hideSuggestions(); els.q.blur(); }
  });
  els.q.addEventListener("focus", () => {
    if (route.name !== "search" && !els.q.value) location.hash = "search";
  });
  els.suggest.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    els.q.value = suggestItems[Number(li.dataset.i)];
    submitSearch(els.q.value);
    els.q.blur();
  });

  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", () => renderRoute(true));
  window.addEventListener("pagehide", () => {
    save();
    flushListen();
  });

  if ("mediaSession" in navigator) {
    const handlers = {
      play: () => playerReady && player.playVideo(),
      pause: () => playerReady && player.pauseVideo(),
      nexttrack: () => next(),
      previoustrack: prev,
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }
}

function onKey(e) {
  if (e.key === "Escape") {
    if (!els.lyricsFull.hidden) return closeLyrics();
    if (!els.sleepPop.hidden) {
      els.sleepPop.hidden = true;
      return els.sleepBtn.focus();
    }
    els.app.classList.remove("np-open");
    return;
  }
  if (e.target.closest("input, textarea, select, [contenteditable], dialog")) return;
  if ((e.key === " " || e.key === "Enter") && e.target.closest("button, a")) return;
  const combo = comboOf(e);
  const keys = shortcutKeys();
  const action = Object.keys(SHORTCUT_ACTIONS).find((name) => keys[name] && keys[name] === combo);
  if (!action) return;
  e.preventDefault();
  SHORTCUT_ACTIONS[action].run();
}

// Shortcuts can be changed or turned off in Settings; an empty string means "off".
const SHORTCUT_ACTIONS = {
  playPause: { label: "Play or pause", key: "Space", run: () => togglePlay() },
  next: { label: "Next song", key: "Shift+ArrowRight", run: () => next() },
  prev: { label: "Previous song", key: "Shift+ArrowLeft", run: () => prev() },
  forward: { label: "Forward 5 seconds", key: "ArrowRight", run: () => seekBy(SEEK_STEP_SECONDS) },
  back: { label: "Back 5 seconds", key: "ArrowLeft", run: () => seekBy(-SEEK_STEP_SECONDS) },
  volumeUp: { label: "Volume up", key: "ArrowUp", run: () => setVolume(state.volume + VOLUME_STEP) },
  volumeDown: { label: "Volume down", key: "ArrowDown", run: () => setVolume(state.volume - VOLUME_STEP) },
  mute: { label: "Mute", key: "M", run: () => toggleMute() },
  like: { label: "Like the current song", key: "L", run: () => toggleLike(current()) },
  shuffle: { label: "Shuffle", key: "S", run: () => toggleShuffle() },
  repeat: { label: "Repeat", key: "R", run: () => cycleRepeat() },
  lyrics: { label: "Full-screen lyrics", key: "Y", run: () => (els.lyricsFull.hidden ? openLyrics() : closeLyrics()) },
  mini: { label: "Mini player", key: "P", run: () => openMiniPlayer() },
  search: { label: "Search", key: "/", run: () => els.q.focus() },
};

function comboOf(e) {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return "";
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey && key.length > 1 ? "Shift" : "", key]
    .filter(Boolean).join("+");
}

function shortcutKeys() {
  const defaults = Object.fromEntries(Object.entries(SHORTCUT_ACTIONS).map(([name, a]) => [name, a.key]));
  return { ...defaults, ...(state.settings.shortcuts || {}) };
}

// ---------------------------------------------------------------- start

async function init() {
  $$("[data-icon]").forEach((el) => { el.outerHTML = I[el.dataset.icon] || ""; });
  els.prev.innerHTML = I.prev;
  els.next.innerHTML = I.next;
  els.shuffle.innerHTML = I.shuffle;
  restore();
  state.account = loadAccount();
  renderControls();
  renderPlayState();
  renderNowPlaying();
  renderQueue();
  renderLyrics();
  renderSleep();
  showPanel("queue");
  setBackdrop(current()?.art);
  if (current()) {
    els.tCur.textContent = fmt(state.position);
    els.tDur.textContent = fmt(current().duration);
    els.seek.value = current().duration ? Math.round((state.position / current().duration) * 1000) : 0;
    setFill(els.seek);
    loadLyrics(current());
    resetListen(current());
  }
  bindEvents();
  loadYouTube();
  try {
    applyLibrary(await api("/api/library"));
  } catch (err) {
    toast(`Couldn't load your library: ${err.message}`);
  }
  renderLikes();
  renderAccountChip();
  renderRoute(true);
  loadAccountLibrary();
}
