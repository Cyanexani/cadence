"use strict";

// Cadence keeps your library on this device: likes, listening history, playlists, searches and
// settings. These functions answer the same /api/* calls the old local server did, so the UI
// doesn't care where the data lives (browser, Vercel deployment, or the Android app's webview).

const LIBRARY_KEY = "cadence:library:v1";
const RECENT_LIMIT = 60;
const LIKED_LIMIT = 5000;
const PLAY_HISTORY_LIMIT = 20000;
const SEARCH_HISTORY_LIMIT = 12;
const MAX_PLAY_SECONDS = 6 * 3600;
const DAY_SECONDS = 86400;
const MIX_SIZE = 25;
const MIX_MIN_SONGS = 10;
const MIX_RECENT_DAYS = 60;
const MIX_TIME_OF_DAY_DAYS = 120;
const MIX_TIME_WINDOW_HOURS = 2;
const REDISCOVER_MIN_PLAYS = 2;
const TOP_SONGS = 10;
const TOP_ARTISTS = 10;
const TOP_ALBUMS = 6;
const NAME_LIMIT = 120;
const TRACK_KEYS = ["id", "title", "artist", "artistId", "album", "albumId", "duration", "art", "video", "explicit"];
const SETTING_KEYS = new Set(["language", "region", "crossfade", "sponsorblock", "shortcuts", "syncHistory", "normalize", "skipSilence", "eq"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SHORT_CODE = /^[A-Za-z_-]{0,8}$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const emptyLibrary = () => ({ tracks: {}, liked: [], plays: [], playlists: [], searches: [], settings: {} });

function loadLibrary() {
  const lib = emptyLibrary();
  try {
    const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "null");
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(lib)) {
        if (raw[key] && Array.isArray(raw[key]) === Array.isArray(lib[key]) && typeof raw[key] === "object") lib[key] = raw[key];
      }
    }
  } catch { /* unreadable storage: start with an empty library */ }
  return lib;
}

function pruneTracks(lib) {
  const used = new Set([...lib.liked, ...lib.plays.map((p) => p.id), ...lib.playlists.flatMap((p) => p.trackIds)]);
  for (const id of Object.keys(lib.tracks)) if (!used.has(id)) delete lib.tracks[id];
}

function saveLibrary(lib) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
  } catch {
    // Storage is full: keep the newer half of the listening history and try once more.
    lib.plays = lib.plays.slice(Math.floor(lib.plays.length / 2));
    pruneTracks(lib);
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
  }
}

function libraryView(lib) {
  const seen = new Set();
  const recent = [];
  for (let i = lib.plays.length - 1; i >= 0 && recent.length < RECENT_LIMIT; i--) {
    const id = lib.plays[i].id;
    if (!seen.has(id) && lib.tracks[id]) {
      seen.add(id);
      recent.push(lib.tracks[id]);
    }
  }
  return {
    liked: lib.liked.map((id) => lib.tracks[id]).filter(Boolean),
    recent,
    playlists: lib.playlists.map(({ trackIds, ...rest }) => ({ ...rest, tracks: trackIds.map((id) => lib.tracks[id]).filter(Boolean) })),
    searches: lib.searches.slice(0, SEARCH_HISTORY_LIMIT),
    settings: lib.settings,
    plays: lib.plays.length,
  };
}

function mutate(change) {
  const lib = loadLibrary();
  change(lib);
  saveLibrary(lib);
  return libraryView(lib);
}

function cleanTrack(raw) {
  if (!raw || typeof raw !== "object" || !VIDEO_ID.test(String(raw.id || ""))) {
    throw new Error("That song is missing a valid YouTube id.");
  }
  return Object.fromEntries(TRACK_KEYS.map((k) => [k, raw[k] ?? null]));
}

function remember(lib, tracks) {
  for (const t of tracks) lib.tracks[t.id] = t;
}

function findPlaylist(lib, id) {
  const pl = lib.playlists.find((p) => p.id === id);
  if (!pl) throw new Error("That playlist no longer exists.");
  return pl;
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- writes

function setLiked({ track, liked }) {
  const t = cleanTrack(track);
  return mutate((lib) => {
    remember(lib, [t]);
    lib.liked = lib.liked.filter((id) => id !== t.id);
    if (liked) lib.liked = [t.id, ...lib.liked].slice(0, LIKED_LIMIT);
    pruneTracks(lib);
  });
}

function addPlay({ track, seconds }) {
  const t = cleanTrack(track);
  const sec = Math.max(0, Math.min(Math.round(Number(seconds) || 0), MAX_PLAY_SECONDS));
  return mutate((lib) => {
    remember(lib, [t]);
    lib.plays.push({ id: t.id, at: nowSeconds(), sec });
    if (lib.plays.length > PLAY_HISTORY_LIMIT) {
      lib.plays = lib.plays.slice(-PLAY_HISTORY_LIMIT);
      pruneTracks(lib);
    }
  });
}

function searchHistory({ q, clear }) {
  return mutate((lib) => {
    if (clear) {
      lib.searches = [];
      return;
    }
    const query = String(q || "").trim().slice(0, 200);
    if (!query) return;
    lib.searches = [query, ...lib.searches.filter((s) => s.toLowerCase() !== query.toLowerCase())].slice(0, SEARCH_HISTORY_LIMIT);
  });
}

function editPlaylist(body) {
  const { action } = body;
  return mutate((lib) => {
    if (action === "create") {
      const tracks = (body.tracks || []).map(cleanTrack);
      remember(lib, tracks);
      const now = nowSeconds();
      lib.playlists.unshift({
        id: newId(),
        name: String(body.name || "").trim().slice(0, NAME_LIMIT) || "New playlist",
        trackIds: tracks.map((t) => t.id),
        created: now,
        updated: now,
      });
      return;
    }
    const pl = findPlaylist(lib, String(body.id));
    if (action === "delete") {
      lib.playlists = lib.playlists.filter((p) => p !== pl);
      pruneTracks(lib);
      return;
    }
    if (action === "rename") {
      pl.name = String(body.name || "").trim().slice(0, NAME_LIMIT) || pl.name;
    } else if (action === "add") {
      const tracks = (body.tracks || []).map(cleanTrack);
      remember(lib, tracks);
      pl.trackIds.push(...tracks.map((t) => t.id));
    } else if (action === "remove") {
      const i = Number(body.index);
      if (i >= 0 && i < pl.trackIds.length) pl.trackIds.splice(i, 1);
      pruneTracks(lib);
    } else if (action === "move") {
      const from = Number(body.from);
      const to = Number(body.to);
      if (from >= 0 && from < pl.trackIds.length && to >= 0 && to < pl.trackIds.length) {
        pl.trackIds.splice(to, 0, pl.trackIds.splice(from, 1)[0]);
      }
    } else {
      throw new Error(`Unknown playlist action "${action}".`);
    }
    pl.updated = nowSeconds();
  });
}

function updateSettings({ settings }) {
  const incoming = Object.fromEntries(Object.entries(settings || {}).filter(([k]) => SETTING_KEYS.has(k)));
  for (const key of ["language", "region"]) {
    if (key in incoming && !SHORT_CODE.test(String(incoming[key] || ""))) throw new Error(`That ${key} code isn't valid.`);
  }
  if ("eq" in incoming) {
    const { on, gains } = incoming.eq || {};
    if (!Array.isArray(gains) || gains.length !== 5 || gains.some((g) => !Number.isFinite(g))) throw new Error("That equalizer setting isn't valid.");
    incoming.eq = { on: Boolean(on), gains: gains.map((g) => Math.max(-12, Math.min(12, Math.round(g)))) };
  }
  for (const key of ["normalize", "skipSilence"]) {
    if (key in incoming) incoming[key] = Boolean(incoming[key]);
  }
  return mutate((lib) => Object.assign(lib.settings, incoming));
}

function importLibrary({ library }) {
  if (!library || typeof library !== "object" || typeof library.tracks !== "object" || Array.isArray(library.tracks)) {
    throw new Error("That file isn't a Cadence backup.");
  }
  const lib = emptyLibrary();
  for (const key of Object.keys(lib)) {
    const value = library[key] ?? lib[key];
    if (Array.isArray(value) !== Array.isArray(lib[key]) || typeof value !== "object") {
      throw new Error(`The backup's "${key}" section is damaged.`);
    }
    lib[key] = value;
  }
  saveLibrary(lib);
  return libraryView(lib);
}

// ---------------------------------------------------------------- listening stats

function period(params) {
  const now = nowSeconds();
  if (params.year) {
    const year = Number(params.year);
    return [new Date(year, 0, 1).getTime() / 1000, new Date(year + 1, 0, 1).getTime() / 1000];
  }
  const days = Number(params.days || 0);
  return [days > 0 ? now - days * DAY_SECONDS : 0, now + 1];
}

function dayNumber(seconds) {
  const d = new Date(seconds * 1000);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (DAY_SECONDS * 1000));
}

function longestStreak(days) {
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of [...days].sort((a, b) => a - b)) {
    run = previous !== null && day - previous === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function listeningStats(lib, params) {
  const [start, end] = period(params);
  const plays = lib.plays.filter((p) => p.at >= start && p.at < end && lib.tracks[p.id]);
  const hours = Array(24).fill(0);
  for (const p of plays) hours[new Date(p.at * 1000).getHours()] += 1;
  const leadArtist = (t) => (t.artist || "").split(",")[0].trim();
  const artistIds = {};
  const albumInfo = {};
  for (const p of plays) {
    const t = lib.tracks[p.id];
    const lead = leadArtist(t);
    if (lead && !artistIds[lead]) artistIds[lead] = t.artistId;
    if (t.albumId) albumInfo[t.albumId] = { title: t.album, artist: lead, art: t.art };
  }
  return {
    minutes: Math.round(plays.reduce((sum, p) => sum + (p.sec || 0), 0) / 60),
    plays: plays.length,
    songs: new Set(plays.map((p) => p.id)).size,
    days: new Set(plays.map((p) => dayNumber(p.at))).size,
    streak: longestStreak(new Set(plays.map((p) => dayNumber(p.at)))),
    hours,
    topSongs: countBy(plays, (p) => p.id).slice(0, TOP_SONGS).map(([id, n]) => ({ ...lib.tracks[id], plays: n })),
    topArtists: countBy(plays, (p) => leadArtist(lib.tracks[p.id])).slice(0, TOP_ARTISTS)
      .map(([name, n]) => ({ name, id: artistIds[name] || null, plays: n })),
    topAlbums: countBy(plays, (p) => lib.tracks[p.id].albumId).slice(0, TOP_ALBUMS)
      .map(([id, n]) => ({ id, ...albumInfo[id], plays: n })),
    firstPlay: lib.plays.length ? Math.min(...lib.plays.slice(0, 1000).map((p) => p.at)) : null,
  };
}

// ---------------------------------------------------------------- Local Mix

function weightedPick(counts, size) {
  // Square-root weights stop one heavily replayed song from crowding out the rest.
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => [Math.random() ** (1 / Math.sqrt(n)), id])
    .sort((a, b) => b[0] - a[0])
    .slice(0, size)
    .map(([, id]) => id);
}

function tally(plays) {
  const counts = new Map();
  for (const p of plays) counts.set(p.id, (counts.get(p.id) || 0) + 1);
  return counts;
}

function localMix(lib, mode) {
  const plays = lib.plays.filter((p) => lib.tracks[p.id]);
  const now = nowSeconds();
  const recentCutoff = now - MIX_RECENT_DAYS * DAY_SECONDS;
  let counts;
  let note = null;
  if (mode === "time") {
    const here = new Date();
    const hereHours = here.getHours() + here.getMinutes() / 60;
    const near = (at) => {
      const d = new Date(at * 1000);
      const gap = Math.abs(d.getHours() + d.getMinutes() / 60 - hereHours);
      return Math.min(gap, 24 - gap) <= MIX_TIME_WINDOW_HOURS;
    };
    counts = tally(plays.filter((p) => p.at >= now - MIX_TIME_OF_DAY_DAYS * DAY_SECONDS && near(p.at)));
  } else if (mode === "rediscover") {
    const lately = new Set(plays.filter((p) => p.at >= recentCutoff).map((p) => p.id));
    counts = new Map([...tally(plays.filter((p) => p.at < recentCutoff)).entries()]
      .filter(([id, n]) => !lately.has(id) && n >= REDISCOVER_MIN_PLAYS));
    if (!counts.size) note = "Nothing to rediscover yet. Songs you played a lot, but not in the last 60 days, show up here.";
  } else {
    counts = tally(plays.filter((p) => p.at >= recentCutoff));
    if (counts.size < MIX_MIN_SONGS) counts = tally(plays);
    for (const id of lib.liked) {
      if (counts.size >= MIX_MIN_SONGS) break;
      if (!counts.has(id)) counts.set(id, 1);
    }
  }
  const items = weightedPick(counts, MIX_SIZE).map((id) => lib.tracks[id]).filter(Boolean);
  if (!items.length && !note) {
    note = mode === "time"
      ? "Nothing yet for this time of day. Listen around now on a few days and it fills in."
      : "Play a few songs first. Local Mix is built only from what you listen to here.";
  }
  return { items, note };
}

// ---------------------------------------------------------------- routing

const LOCAL_ROUTES = {
  "GET /api/library": () => libraryView(loadLibrary()),
  "GET /api/export": () => loadLibrary(),
  "GET /api/stats": (params) => listeningStats(loadLibrary(), params),
  "GET /api/mix": (params) => localMix(loadLibrary(), params.mode || "foryou"),
  "POST /api/like": setLiked,
  "POST /api/played": addPlay,
  "POST /api/search-history": searchHistory,
  "POST /api/playlists": editPlaylist,
  "POST /api/settings": updateSettings,
  "POST /api/import": importLibrary,
};

function localRoute(method, path, input) {
  const handler = LOCAL_ROUTES[`${method} ${path}`];
  return handler ? () => handler(input || {}) : null;
}
