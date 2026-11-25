"use strict";

// Library features layered on the core player: your playlists, Local Mix, listening stats,
// settings (crossfade, region, shortcuts, backup) and the floating mini player.

const CROSSFADE_MAX_SECONDS = 12;
const MIX_MODES = [
  ["foryou", "For you", "Weighted toward what you've played most in the last 60 days."],
  ["time", "This time of day", "What you usually play within two hours of now."],
  ["rediscover", "Rediscover", "Songs you used to play a lot but haven't heard in 60 days."],
];
const STAT_RANGES = [
  ["week", "Last 7 days", { days: 7 }],
  ["month", "Last 30 days", { days: 30 }],
  ["year", "This year", { year: new Date().getFullYear() }],
  ["all", "All time", {}],
];
const REGIONS = ["", "IN", "US", "GB", "CA", "AU", "DE", "FR", "ES", "IT", "NL", "SE", "BR", "MX", "AR", "JP", "KR",
  "ID", "PH", "SG", "MY", "PK", "BD", "AE", "SA", "NG", "KE", "ZA", "TR", "RU"];
const LANGUAGES = ["en", "hi", "ur", "ar", "de", "es", "fr", "it", "ja", "ko", "nl", "pt", "ru", "tr", "zh_CN", "zh_TW"];
const MINI_SIZE = { width: 360, height: 112 };

const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return (code) => (code ? names.of(code) : "Automatic (where you are)");
  } catch {
    return (code) => code || "Automatic (where you are)";
  }
})();
const languageName = (() => {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    return (code) => names.of(code.replace("_", "-"));
  } catch {
    return (code) => code;
  }
})();

function totalDuration(tracks) {
  const seconds = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

// ---------------------------------------------------------------- dialog and menu

const dialog = document.getElementById("dialog");
const menu = document.getElementById("menu");

function askDialog({ title, body = "", value = null, ok = "OK", danger = false }) {
  $("#dialog-title").textContent = title;
  $("#dialog-body").textContent = body;
  $("#dialog-body").hidden = !body;
  const input = $("#dialog-input");
  input.hidden = value === null;
  input.value = value ?? "";
  const okBtn = $("#dialog-ok");
  okBtn.textContent = ok;
  okBtn.classList.toggle("danger", danger);
  dialog.returnValue = "";
  dialog.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "ok") return resolve(null);
      resolve(value === null ? true : input.value.trim());
    }, { once: true });
  });
}

function closeMenu() {
  menu.hidden = true;
  menu.innerHTML = "";
}

function openMenu(anchor, html, onPick) {
  menu.innerHTML = html;
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(8, box.right - width), innerWidth - width - 8);
  const top = box.bottom + height + 8 < innerHeight ? box.bottom + 6 : Math.max(8, box.top - height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.onclick = (e) => {
    const item = e.target.closest("[data-pick]");
    if (!item) return;
    const { pick } = item.dataset;
    closeMenu();
    // Run after this click finishes, so a follow-up menu isn't closed by the same click.
    setTimeout(() => onPick(pick));
  };
  $("button", menu)?.focus();
}

function openPlaylistMenu(anchor, tracks) {
  const items = state.playlists.map((p) => (
    `<button role="menuitem" type="button" data-pick="${esc(p.id)}">${I.playlist}<span>${esc(p.name)}</span></button>`
  )).join("");
  openMenu(anchor, `<p class="pop-title">Add to playlist</p><button role="menuitem" type="button" data-pick="__new">${I.plus}<span>New playlist…</span></button>${items}`, async (pick) => {
    if (pick === "__new") return createPlaylist(tracks);
    try {
      applyLibrary(await api("/api/playlists", { action: "add", id: pick, tracks }));
      const name = state.playlists.find((p) => p.id === pick)?.name || "the playlist";
      toast(tracks.length === 1 ? `Added to ${name}` : `Added ${tracks.length} songs to ${name}`);
      if (route.name === "my" && route.parts[0] === pick) renderMyPlaylist(pick);
    } catch (err) {
      toast(`Couldn't add that: ${err.message}`);
    }
  });
}

// On phones each song row has one "more" button instead of four small ones.
function openTrackMenu(anchor, track) {
  const liked = isLiked(track.id);
  const items = [
    ["next", I.playNext, "Play next"],
    ["queue", I.addQueue, "Add to queue"],
    ["playlist", I.listAdd, "Add to a playlist…"],
    ["radio", I.radio, "Start radio"],
    ["like", liked ? I.heartFill : I.heart, liked ? "Remove from Liked songs" : "Add to Liked songs"],
    track.artistId ? ["artist", I.person, "Go to artist"] : null,
    track.albumId ? ["album", I.album, "Go to album"] : null,
  ].filter(Boolean);
  const html = `<p class="pop-title">${esc(track.title)}</p>`
    + items.map(([pick, icon, label]) => `<button role="menuitem" type="button" data-pick="${pick}">${icon}<span>${label}</span></button>`).join("");
  openMenu(anchor, html, (pick) => {
    if (pick === "next") playNext(track);
    else if (pick === "queue") addToQueue(track);
    else if (pick === "playlist") openPlaylistMenu(anchor, [track]);
    else if (pick === "radio") playRadio(track);
    else if (pick === "like") toggleLike(track);
    else if (pick === "artist") location.hash = `artist/${enc(track.artistId)}`;
    else if (pick === "album") location.hash = `album/${enc(track.albumId)}`;
  });
}

// The phone layout's Library tab: everything that lives in the sidebar on wide screens.
function renderLibrary() {
  const tiles = [
    ["liked", I.heartFill, "Liked songs", `${state.liked.length} song${state.liked.length === 1 ? "" : "s"}`],
    ["recent", I.clock, "Recently played", `${state.recent.length} song${state.recent.length === 1 ? "" : "s"}`],
    ["mix", I.sparkle, "Local Mix", "Made from your history"],
    ["stats", I.chart, "Your stats", "Minutes, streaks, top songs"],
  ].map(([href, icon, title, sub]) => (
    `<a class="lib-tile" href="#${href}"><span class="lib-icon">${icon}</span><span><span class="lib-title">${title}</span><span class="lib-sub">${sub}</span></span></a>`
  )).join("");
  const playlists = state.playlists.map((p) => (
    `<a class="lib-row" href="#my/${enc(p.id)}">${mosaicThumb(p.tracks)}<span><span class="lib-title">${esc(p.name)}</span><span class="lib-sub">${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}</span></span></a>`
  )).join("");
  const fromAccount = state.accountPlaylists.map((p) => (
    `<a class="lib-row" href="#playlist/${enc(p.id)}">${artImg(p.art, "lib-thumb")}<span><span class="lib-title">${esc(p.title)}</span><span class="lib-sub">${esc(p.subtitle || "YouTube Music")}</span></span></a>`
  )).join("");
  setView(`<h1 class="page-title">Library</h1><div class="lib-tiles">${tiles}</div>
    <section class="shelf"><div class="shelf-head"><h2>Your playlists</h2><button class="text-btn" type="button" data-new-playlist>New playlist</button></div>
    ${playlists || emptyHTML("No playlists yet.", "Make one here, or save your queue as a playlist from Now playing.")}</section>
    ${fromAccount ? `<section class="shelf"><div class="shelf-head"><h2>From YouTube Music</h2></div>${fromAccount}</section>` : ""}`);
}

function mosaicThumb(tracks) {
  const art = tracks.find((t) => t.art)?.art;
  return art ? artImg(art, "lib-thumb") : `<span class="lib-thumb lib-icon">${I.playlist}</span>`;
}

async function createPlaylist(tracks = []) {
  const name = await askDialog({ title: "New playlist", value: "", ok: "Create" });
  if (name === null) return;
  try {
    applyLibrary(await api("/api/playlists", { action: "create", name, tracks }));
    const created = state.playlists[0];
    toast(tracks.length ? `Saved ${tracks.length} song${tracks.length === 1 ? "" : "s"} to ${created.name}` : `Created ${created.name}`);
    location.hash = `my/${created.id}`;
  } catch (err) {
    toast(`Couldn't create the playlist: ${err.message}`);
  }
}

// ---------------------------------------------------------------- Google sign-in

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SLOW_DOWN_STEP_MS = 5000;
let authConfig = null; // what /api/auth/config said; null until asked
let signinRun = 0;

function renderAccountChip() {
  const chip = document.getElementById("nav-account");
  if (!chip) return;
  const account = state.account;
  chip.hidden = !account;
  if (!account) return;
  chip.innerHTML = `${account.photo ? artImg(account.photo, "nav-avatar", { lazy: false }) : I.person}<span class="nav-pl-name">${esc(account.name || "Google account")}</span>`;
}

// Android: Google's own sign-in page opens inside the app and the session stays in the Rust core.
async function startAppSignIn() {
  try {
    const me = await window.__TAURI__.core.invoke("google_sign_in");
    state.account = { mode: "app", name: me?.name || null, handle: me?.handle || null, photo: me?.photo || null };
    saveAccount(state.account);
  } catch (err) {
    toast(typeof err === "string" ? err : err?.message || "Sign-in didn't finish.");
    return;
  }
  homeCache = null;
  renderAccountChip();
  toast(state.account.name ? `Signed in as ${state.account.name}` : "Signed in with Google");
  await loadAccountLibrary();
  if (route.name === "settings") renderSettings();
}

async function startSignIn() {
  if (authConfig?.mode === "app") return startAppSignIn();
  const run = ++signinRun;
  const box = document.getElementById("signin-dialog");
  const status = document.getElementById("signin-status");
  const code = document.getElementById("signin-code");
  const link = document.getElementById("signin-link");
  code.textContent = "…";
  status.textContent = "Getting a code from Google…";
  box.showModal();
  let start;
  try {
    start = await api("/api/auth/start");
  } catch (err) {
    if (run === signinRun) status.textContent = err.message;
    return;
  }
  if (run !== signinRun) return;
  link.href = `${start.verificationUrl}?user_code=${enc(start.userCode)}`;
  link.textContent = start.verificationUrl.replace(/^https?:\/\/(www\.)?/, "");
  code.textContent = start.userCode;
  status.textContent = "Waiting for you to approve on Google's page…";
  let wait = start.interval * 1000;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    if (run !== signinRun) return; // cancelled or closed
    let res;
    try {
      res = await api("/api/auth/poll", undefined, { device: start.deviceCode });
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (run !== signinRun) return;
    if (res.status === "pending") {
      if (res.slowDown) wait += SLOW_DOWN_STEP_MS;
      continue;
    }
    if (res.status === "denied") {
      status.textContent = "You declined on Google's page, so nothing was signed in.";
      return;
    }
    if (res.status === "done") {
      status.textContent = "Approved. Loading your account…";
      await finishSignIn(res.token);
      box.close();
      return;
    }
    break; // expired
  }
  if (run === signinRun) status.textContent = "That code expired. Close this and start again.";
}

async function finishSignIn(token) {
  state.account = { ...token };
  saveAccount(state.account);
  try {
    Object.assign(state.account, await api("/api/account"));
    saveAccount(state.account);
  } catch (err) {
    toast(`Signed in, but couldn't read your account name: ${err.message}`);
  }
  homeCache = null;
  renderAccountChip();
  toast(state.account.name ? `Signed in as ${state.account.name}` : "Signed in with Google");
  await loadAccountLibrary();
  if (route.name === "settings") renderSettings();
}

async function signOut() {
  if (state.account?.mode === "app") {
    await window.__TAURI__.core.invoke("google_sign_out").catch(() => { /* the session is dropped either way */ });
    signedOut("Signed out of Google");
    if (route.name === "settings") renderSettings();
    return;
  }
  const refresh = state.account?.refreshToken;
  signedOut("Signed out of Google");
  // Also cancel Cadence's access on Google's side, so the token is useless if it ever leaked.
  if (refresh) remote("/api/auth/revoke", {}, undefined, { refresh }).catch(() => { /* already invalid */ });
  if (route.name === "settings") renderSettings();
}

function renderAccountSection() {
  const box = document.getElementById("account-section");
  if (!box) return;
  const account = state.account;
  if (account) {
    const avatar = account.photo ? artImg(account.photo, "account-avatar", { lazy: false }) : `<span class="account-avatar lib-icon">${I.person}</span>`;
    const inApp = account.mode === "app";
    const historyRow = inApp ? "" : settingRow("Add what you play to your YouTube Music history", "Helps its recommendations. A song counts once you've heard half of it, or 4 minutes.",
      `<input type="checkbox" class="switch" role="switch" id="set-sync-history"${state.settings.syncHistory !== false ? " checked" : ""}>`, "set-sync-history");
    const note = inApp
      ? "Likes go both ways: hearts here like the song on YouTube Music too. Your Google session is kept privately on this phone; signing out deletes it."
      : "Likes go both ways: hearts here like the song on YouTube Music too. Your sign-in stays on this device; signing out also cancels Cadence's access on Google's side.";
    box.innerHTML = `<div class="account-row">${avatar}<div><p class="account-name">${esc(account.name || "Google account")}</p><p class="set-help">${esc(account.handle || "Signed in with Google")}</p></div></div>
      ${historyRow}
      <div class="hero-actions"><button class="btn" type="button" data-sync-account>Sync now</button><button class="btn" type="button" data-signout>Sign out</button></div>
      <p class="set-help">${note}</p>`;
    return;
  }
  if (authConfig === null) {
    box.innerHTML = '<p class="set-help">Checking whether Google sign-in is set up…</p>';
    api("/api/auth/config")
      .then((res) => { authConfig = res; })
      .catch((err) => { authConfig = { configured: false, reason: err.message }; })
      .finally(renderAccountSection);
    return;
  }
  if (authConfig.configured) {
    const what = authConfig.mode === "app"
      ? "Sign in on Google's own page to bring in your YouTube Music likes and playlists and keep likes in sync both ways."
      : "Sign in to bring in your YouTube Music likes and playlists, keep likes in sync both ways, and get your own Home feed.";
    box.innerHTML = `<p class="set-help">${what}</p>
      <button class="btn primary" type="button" data-signin>${I.person} Sign in with Google</button>`;
    return;
  }
  box.innerHTML = `<p class="set-help">${esc(authConfig.reason || "Google sign-in needs a one-time setup: create a Google Cloud OAuth client and give its ID and secret to Cadence.")}</p>
    <p class="set-help">The README's “Google sign-in” section has the steps (about 5 minutes).</p>`;
}

// ---------------------------------------------------------------- your playlists

function renderNavPlaylists() {
  const box = document.getElementById("nav-playlists");
  if (!box) return;
  const mine = state.playlists.map((p) => (
    `<a class="nav-link nav-pl" href="#my/${enc(p.id)}" data-nav-pl="${esc(p.id)}">${I.playlist}<span class="nav-pl-name">${esc(p.name)}</span><span class="nav-count">${p.tracks.length || ""}</span></a>`
  )).join("");
  const account = state.accountPlaylists.map((p) => (
    `<a class="nav-link nav-pl" href="#playlist/${enc(p.id)}">${I.playlist}<span class="nav-pl-name">${esc(p.title)}</span></a>`
  )).join("");
  box.innerHTML = (mine || '<p class="nav-empty">Playlists you make show up here.</p>')
    + (account ? `<p class="nav-section nav-subsection">From YouTube Music</p>${account}` : "");
  markNavPlaylist();
}

function markNavPlaylist() {
  const active = route.name === "my" ? route.parts[0] : null;
  $$("[data-nav-pl]").forEach((a) => {
    if (a.dataset.navPl === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function mosaicHTML(tracks) {
  const arts = [...new Set(tracks.map((t) => t.art).filter(Boolean))].slice(0, 4);
  if (arts.length < 4) {
    return arts[0]
      ? artImg(arts[0], "hero-art", { lazy: false })
      : `<div class="hero-art liked-art">${I.playlist}</div>`;
  }
  return `<div class="hero-art mosaic">${arts.map((a) => artImg(a, "", { lazy: false })).join("")}</div>`;
}

function renderMyPlaylist(id) {
  markNavPlaylist();
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) {
    setView(emptyHTML("That playlist isn't here anymore.", "It may have been deleted.", '<a class="btn" href="#home">Go home</a>'));
    return;
  }
  const block = tracksBlock(pl.tracks, { editable: true, count: pl.tracks.length, album: true });
  const buttons = `<button class="btn" type="button" data-pl-rename="${esc(pl.id)}">${I.edit} Rename</button><button class="btn" type="button" data-pl-delete="${esc(pl.id)}">${I.trash} Delete</button>`;
  setView(heroHTML({
    artHTML: mosaicHTML(pl.tracks),
    kind: "Your playlist",
    title: pl.name,
    meta: [`${pl.tracks.length} song${pl.tracks.length === 1 ? "" : "s"}`, totalDuration(pl.tracks)].filter(Boolean),
    listId: pl.tracks.length ? block.id : null,
    extraButtons: buttons,
  }) + (pl.tracks.length
    ? block.html
    : emptyHTML("This playlist is empty.", "Use the playlist button on any song, or Save in the queue, to add songs.")));
}

async function editMyPlaylistRow(act, index) {
  const id = route.parts[0];
  if (route.name !== "my" || !id) return;
  const body = act === "remove"
    ? { action: "remove", id, index }
    : { action: "move", id, from: index, to: act === "up" ? index - 1 : index + 1 };
  try {
    applyLibrary(await api("/api/playlists", body));
    renderMyPlaylist(id);
  } catch (err) {
    toast(`Couldn't change the playlist: ${err.message}`);
  }
}

async function renamePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  const name = await askDialog({ title: "Rename playlist", value: pl.name, ok: "Save" });
  if (!name) return;
  applyLibrary(await api("/api/playlists", { action: "rename", id, name }));
  renderMyPlaylist(id);
}

async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  const sure = await askDialog({ title: `Delete “${pl.name}”?`, body: "The playlist is removed from this device. The songs stay on YouTube Music.", ok: "Delete", danger: true });
  if (!sure) return;
  applyLibrary(await api("/api/playlists", { action: "delete", id }));
  toast(`Deleted ${pl.name}`);
  location.hash = "home";
}

// ---------------------------------------------------------------- Local Mix

function renderMix(mode) {
  if (!MIX_MODES.some(([m]) => m === mode)) mode = "foryou";
  const [, label, about] = MIX_MODES.find(([m]) => m === mode);
  let data;
  try {
    data = localMix(loadLibrary(), mode);
  } catch (err) {
    setView(errorHTML(err.message));
    return;
  }
  const block = tracksBlock(data.items, { album: true });
  const tabs = MIX_MODES.map(([m, l]) => `<a class="tab" role="tab" aria-selected="${m === mode}" href="#mix/${m}">${l}</a>`).join("");
  const extra = data.items.length
    ? `<button class="btn" type="button" data-mix-radio="${block.id}">${I.radio} Mix radio</button><button class="btn" type="button" data-mix-regen>${I.sparkle} Shuffle the picks</button>`
    : "";
  setView(heroHTML({
    artHTML: `<div class="hero-art liked-art mix-art">${I.sparkle}</div>`,
    kind: "Local Mix",
    title: label,
    meta: [about, "Built on this device from your own history"],
    listId: data.items.length ? block.id : null,
    extraButtons: extra,
  }) + `<div class="tabs" role="tablist">${tabs}</div>` + (data.items.length ? block.html : emptyHTML("Nothing to mix yet.", data.note)));
}

// ---------------------------------------------------------------- listening stats

function hourLabel(h) {
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12} ${suffix}`;
}

function hoursChart(hours) {
  const max = Math.max(...hours, 1);
  const peak = hours.indexOf(Math.max(...hours));
  const bars = hours.map((n, h) => (
    `<span class="hour${h === peak && n ? " peak" : ""}" style="--v:${(n / max).toFixed(3)}" title="${hourLabel(h)}: ${n} play${n === 1 ? "" : "s"}"></span>`
  )).join("");
  const axis = [0, 6, 12, 18].map((h) => `<span style="--at:${h}">${hourLabel(h)}</span>`).join("");
  return `<div class="hours" role="img" aria-label="Plays by hour of day. Most around ${hourLabel(peak)}.">${bars}</div><div class="hours-axis">${axis}</div>`;
}

function renderStats(range) {
  const entry = STAT_RANGES.find(([r]) => r === range) || STAT_RANGES[1];
  const [key, label, params] = entry;
  const s = listeningStats(loadLibrary(), params);
  const tabs = STAT_RANGES.map(([r, l]) => `<a class="tab" role="tab" aria-selected="${r === key}" href="#stats/${r}">${l}</a>`).join("");
  const title = key === "year" ? `Your ${params.year} in Cadence` : "Your listening";
  if (!s.plays) {
    setView(`<h1 class="page-title">${esc(title)}</h1><div class="tabs" role="tablist">${tabs}</div>${emptyHTML(`No listening in ${label.toLowerCase()}.`, "A song counts once you've heard half of it, or 4 minutes. Everything stays on this device.")}`);
    return;
  }
  const peak = s.hours.indexOf(Math.max(...s.hours));
  const tiles = [
    [s.minutes.toLocaleString(), "minutes listened"],
    [s.plays.toLocaleString(), "plays"],
    [s.songs.toLocaleString(), "different songs"],
    [s.days.toLocaleString(), s.days === 1 ? "day with music" : "days with music"],
    [s.streak.toLocaleString(), s.streak === 1 ? "day longest streak" : "days longest streak"],
  ].map(([n, l]) => `<div class="tile"><span class="tile-n">${n}</span><span class="tile-l">${l}</span></div>`).join("");
  const songs = tracksBlock(s.topSongs, { numbered: true, plays: true });
  const artists = s.topArtists.map((a, i) => (
    `<li><span class="rank">${i + 1}</span><span class="rank-name">${a.id ? `<a href="#artist/${enc(a.id)}">${esc(a.name)}</a>` : esc(a.name)}</span><span class="rank-n">${a.plays} play${a.plays === 1 ? "" : "s"}</span></li>`
  )).join("");
  const albums = s.topAlbums.map((a) => cardHTML({ kind: "album", id: a.id, title: a.title || "Album", subtitle: `${a.artist || ""} · ${a.plays} plays`, art: a.art })).join("");
  setView(`<h1 class="page-title">${esc(title)}</h1><div class="tabs" role="tablist">${tabs}</div>
    <div class="tiles">${tiles}</div>
    <section class="shelf stat-card glass-inset"><div class="shelf-head"><h2>When you listen</h2><span class="muted">Most around ${hourLabel(peak)}</span></div>${hoursChart(s.hours)}</section>
    <div class="stat-cols">
      <section class="shelf"><div class="shelf-head"><h2>Top songs</h2><button class="text-btn" type="button" data-collect="play" data-list="${songs.id}">Play all</button></div>${songs.html}</section>
      <section class="shelf"><div class="shelf-head"><h2>Top artists</h2></div><ol class="ranks">${artists}</ol></section>
    </div>
    ${albums ? `<section class="shelf"><div class="shelf-head"><h2>Top albums</h2></div><div class="scroller">${albums}</div></section>` : ""}`);
}

// ---------------------------------------------------------------- settings

function settingRow(label, help, control, id = "") {
  return `<div class="set-row"><div class="set-text"><label class="set-label"${id ? ` for="${id}"` : ""}>${label}</label>${help ? `<p class="set-help">${help}</p>` : ""}</div><div class="set-control">${control}</div></div>`;
}

function renderSettings() {
  const s = state.settings;
  const crossfade = Number(s.crossfade) || 0;
  const keys = shortcutKeys();
  const shortcutRows = Object.entries(SHORTCUT_ACTIONS).map(([name, a]) => (
    `<li><span>${esc(a.label)}</span><kbd>${esc(keys[name] || "Off")}</kbd><button class="text-btn" type="button" data-shortcut="${name}">Change</button></li>`
  )).join("");
  const regionOptions = REGIONS.map((r) => `<option value="${r}"${(s.region || "") === r ? " selected" : ""}>${esc(regionName(r))}</option>`).join("");
  const languageOptions = LANGUAGES.map((l) => `<option value="${l}"${(s.language || "en") === l ? " selected" : ""}>${esc(languageName(l))}</option>`).join("");
  const lib = loadLibrary();
  setView(`<h1 class="page-title">Settings</h1>
    <section class="settings glass-inset"><h2>Google account</h2><div id="account-section"></div></section>
    <section class="settings glass-inset"><h2>Playback</h2>
      ${NATIVE_AUDIO
        ? `<p class="set-help">Audio quality: Cadence always plays the highest-bitrate audio stream YouTube offers for each song, and keeps playing in the background.</p>`
        : settingRow("Crossfade", "Fade the next song in while this one fades out. Uses a second YouTube player.",
          `<input type="range" id="set-crossfade" min="0" max="${CROSSFADE_MAX_SECONDS}" step="1" value="${crossfade}"><output id="set-crossfade-out">${crossfade ? `${crossfade} s` : "Off"}</output>`, "set-crossfade")}
      ${settingRow("Keep playing similar songs", "When the queue runs out, start a radio from the last song.",
        `<input type="checkbox" class="switch" role="switch" id="set-autoplay"${state.autoplay ? " checked" : ""}>`, "set-autoplay")}
      ${settingRow("Skip non-music parts", "Uses SponsorBlock to jump over intros, sponsor reads and talking in music videos.",
        `<input type="checkbox" class="switch" role="switch" id="set-sponsorblock"${s.sponsorblock !== false ? " checked" : ""}>`, "set-sponsorblock")}
    </section>
    <section class="settings glass-inset"><h2>Content</h2>
      ${settingRow("Region", "Which country's charts, new releases and recommendations you see.", `<select id="set-region">${regionOptions}</select>`, "set-region")}
      ${settingRow("Language", "Language for YouTube Music titles and shelves.", `<select id="set-language">${languageOptions}</select>`, "set-language")}
    </section>
    <section class="settings glass-inset"><h2>Keyboard shortcuts</h2>
      <p class="set-help">Click Change, then press the new key. Press Backspace to turn a shortcut off, or Escape to cancel.</p>
      <ul class="shortcuts">${shortcutRows}</ul>
      <button class="btn" type="button" data-shortcuts-reset>Restore defaults</button>
    </section>
    <section class="settings glass-inset"><h2>Your data</h2>
      <p class="set-help">Everything below lives only on this device: ${lib.liked.length} liked songs, ${lib.playlists.length} playlists and ${lib.plays.length.toLocaleString()} plays in your history.</p>
      <div class="hero-actions"><button class="btn" type="button" data-export>Save a backup</button><button class="btn" type="button" data-import>Restore a backup</button><button class="btn" type="button" data-clear-searches>Clear search history</button></div>
    </section>
    <section class="settings glass-inset"><h2>How Cadence plays music</h2>
      <p class="set-help">Search and browsing come from YouTube Music, and every song plays through YouTube's own embedded player (in the Android app, as a direct audio stream), so nothing is saved to your device. Lyrics come from LRCLIB and skip segments from SponsorBlock. Songs whose owners block playback outside YouTube are swapped for another upload or skipped.</p>
    </section>`);
  const fadeSlider = document.getElementById("set-crossfade");
  if (fadeSlider) setFill(fadeSlider);
  renderAccountSection();
}

async function saveSettings(patch, message) {
  try {
    applyLibrary(await api("/api/settings", { settings: patch }));
    if (message) toast(message);
  } catch (err) {
    toast(`Couldn't save that setting: ${err.message}`);
  }
}

let capture = null;
function startShortcutCapture(button) {
  if (capture) capture.button.textContent = "Change";
  capture = { button, name: button.dataset.shortcut };
  button.textContent = "Press a key…";
}

async function onCaptureKey(e) {
  if (!capture) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === "Escape") {
    capture.button.textContent = "Change";
    capture = null;
    return;
  }
  const clearing = e.key === "Backspace" || e.key === "Delete";
  const combo = clearing ? "" : comboOf(e);
  if (!clearing && !combo) return; // a lone modifier: wait for the real key
  const { name } = capture;
  capture = null;
  const shortcuts = { ...(state.settings.shortcuts || {}) };
  const keys = shortcutKeys();
  let clash = "";
  if (combo) {
    for (const [other, key] of Object.entries(keys)) {
      if (other !== name && key === combo) {
        shortcuts[other] = "";
        clash = SHORTCUT_ACTIONS[other].label;
      }
    }
  }
  shortcuts[name] = combo;
  await saveSettings({ shortcuts }, combo
    ? `${SHORTCUT_ACTIONS[name].label}: ${combo}${clash ? ` (removed from ${clash})` : ""}`
    : `${SHORTCUT_ACTIONS[name].label}: off`);
  renderSettings();
}

async function exportBackup() {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify({ app: "Cadence", version: 1, exported: new Date().toISOString(), library: data }, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `cadence-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast("Backup saved to your downloads");
}

async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast("That file isn't a Cadence backup.");
    return;
  }
  const library = parsed.library || parsed;
  const sure = await askDialog({
    title: "Replace your library?",
    body: `This replaces the likes, playlists and history on this device with the ones in “${file.name}”.`,
    ok: "Replace",
    danger: true,
  });
  if (!sure) return;
  try {
    applyLibrary(await api("/api/import", { library }));
    homeCache = null;
    moodsCache = null;
    renderLikes();
    toast("Backup restored");
    renderRoute(false);
  } catch (err) {
    toast(`Couldn't restore that backup: ${err.message}`);
  }
}

// ---------------------------------------------------------------- mini player and full screen

let miniWin = null;

async function openMiniPlayer() {
  if (!("documentPictureInPicture" in window)) {
    toast("This browser can't open a floating mini player. Chrome and Edge can.");
    return;
  }
  if (miniWin) {
    miniWin.focus();
    return;
  }
  try {
    miniWin = await documentPictureInPicture.requestWindow(MINI_SIZE);
  } catch (err) {
    toast(`Couldn't open the mini player: ${err.message}`);
    return;
  }
  for (const sheet of document.styleSheets) {
    try {
      const style = miniWin.document.createElement("style");
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      miniWin.document.head.append(style);
    } catch {
      const link = miniWin.document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      miniWin.document.head.append(link);
    }
  }
  miniWin.document.body.className = "mini-body";
  miniWin.document.body.innerHTML = `<div class="mini-bg" id="m-bg"></div><div class="mini">
    <span class="mini-art" id="m-art"></span>
    <div class="mini-text"><div class="mini-title" id="m-title"></div><div class="mini-artist" id="m-artist"></div></div>
    <div class="controls"><button class="icon-btn" id="m-prev" type="button" aria-label="Previous">${I.prev}</button><button class="play-btn" id="m-play" type="button" aria-label="Play"></button><button class="icon-btn" id="m-next" type="button" aria-label="Next">${I.next}</button></div>
  </div>`;
  const doc = miniWin.document;
  doc.getElementById("m-prev").addEventListener("click", prev);
  doc.getElementById("m-play").addEventListener("click", togglePlay);
  doc.getElementById("m-next").addEventListener("click", () => next());
  miniWin.addEventListener("pagehide", () => { miniWin = null; });
  renderMini();
}

function renderMini() {
  if (!miniWin) return;
  const doc = miniWin.document;
  const track = current();
  const art = track?.art ? artImg(track.art, "", { lazy: false }) : "";
  doc.getElementById("m-art").innerHTML = art;
  doc.getElementById("m-bg").innerHTML = art;
  doc.getElementById("m-title").textContent = track?.title || "Nothing playing";
  doc.getElementById("m-artist").textContent = track?.artist || "";
  const play = doc.getElementById("m-play");
  play.innerHTML = state.playing ? I.pause : I.play;
  play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  els.lyricsFull.requestFullscreen?.().catch(() => toast("Full screen isn't available here."));
}

// ---------------------------------------------------------------- events

function bindFeatureEvents() {
  document.getElementById("new-playlist").addEventListener("click", () => createPlaylist([]));
  document.getElementById("q-save").addEventListener("click", () => {
    const tracks = state.queue.slice(Math.max(0, state.index));
    if (!tracks.length) return toast("The queue is empty.");
    createPlaylist(tracks);
  });
  document.getElementById("mini-btn").addEventListener("click", openMiniPlayer);
  const signinBox = document.getElementById("signin-dialog");
  document.getElementById("signin-cancel").addEventListener("click", () => signinBox.close());
  signinBox.addEventListener("close", () => { signinRun += 1; }); // stops any waiting loop
  document.getElementById("signin-copy").addEventListener("click", async () => {
    const code = document.getElementById("signin-code").textContent;
    try {
      await navigator.clipboard.writeText(code);
      toast("Code copied");
    } catch {
      getSelection().selectAllChildren(document.getElementById("signin-code"));
    }
  });
  document.getElementById("lf-fullscreen").addEventListener("click", toggleFullscreen);
  document.getElementById("import-file").addEventListener("change", (e) => {
    const [file] = e.target.files;
    e.target.value = "";
    if (file) importBackup(file);
  });
  document.addEventListener("keydown", onCaptureKey, true);
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest("#menu, [data-act='playlist'], [data-act='more']")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeMenu();
  });
  window.addEventListener("hashchange", () => {
    closeMenu();
    markNavPlaylist();
  });

  els.view.addEventListener("click", async (e) => {
    const target = e.target.closest("[data-pl-rename], [data-pl-delete], [data-mix-radio], [data-mix-regen], [data-shortcut], [data-shortcuts-reset], [data-export], [data-import], [data-clear-searches], [data-new-playlist], [data-signin], [data-signout], [data-sync-account]");
    if (!target) return;
    const d = target.dataset;
    try {
      if ("signin" in d) startSignIn();
      else if ("signout" in d) await signOut();
      else if ("syncAccount" in d) await loadAccountLibrary({ announce: true });
      else if ("newPlaylist" in d) await createPlaylist([]);
      else if (d.plRename) await renamePlaylist(d.plRename);
      else if (d.plDelete) await deletePlaylist(d.plDelete);
      else if (d.mixRadio) {
        const list = lists.get(Number(d.mixRadio)) || [];
        if (list.length) playRadio(list[Math.floor(Math.random() * list.length)]);
      } else if ("mixRegen" in d) renderMix(route.parts[0] || "foryou");
      else if (d.shortcut) startShortcutCapture(target);
      else if ("shortcutsReset" in d) {
        await saveSettings({ shortcuts: {} }, "Shortcuts back to defaults");
        renderSettings();
      } else if ("export" in d) await exportBackup();
      else if ("import" in d) document.getElementById("import-file").click();
      else if ("clearSearches" in d) await clearSearchHistory();
    } catch (err) {
      toast(err.message);
    }
  });

  els.view.addEventListener("input", (e) => {
    if (e.target.id === "set-crossfade") {
      const n = Number(e.target.value);
      document.getElementById("set-crossfade-out").textContent = n ? `${n} s` : "Off";
      setFill(e.target);
    }
  });

  els.view.addEventListener("change", async (e) => {
    const { id } = e.target;
    if (id === "set-crossfade") {
      const n = Number(e.target.value);
      await saveSettings({ crossfade: n }, n ? `Crossfade: ${n} seconds` : "Crossfade off");
    } else if (id === "set-autoplay") {
      state.autoplay = e.target.checked;
      els.autoplay.checked = state.autoplay;
      save();
      toast(state.autoplay ? "Similar songs play when the queue ends" : "Playback stops when the queue ends");
    } else if (id === "set-sync-history") {
      await saveSettings({ syncHistory: e.target.checked }, e.target.checked
        ? "Plays will be added to your YouTube Music history"
        : "Plays stay on this device only");
    } else if (id === "set-sponsorblock") {
      await saveSettings({ sponsorblock: e.target.checked }, e.target.checked ? "Skipping non-music parts" : "Playing videos in full");
    } else if (id === "set-region" || id === "set-language") {
      const key = id === "set-region" ? "region" : "language";
      await saveSettings({ [key]: e.target.value }, `${key === "region" ? "Region" : "Language"} updated. Home and Explore will reload.`);
      homeCache = null;
      moodsCache = null;
    }
  });
}

async function clearSearchHistory() {
  applyLibrary(await api("/api/search-history", { clear: true }));
  toast("Search history cleared");
}

bindFeatureEvents();
init();
