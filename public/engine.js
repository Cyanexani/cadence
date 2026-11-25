"use strict";

// The audio players behind the page. app.js talks to one "player" object that answers the subset
// of YouTube's iframe player methods and events it uses. Which one it gets depends on where the
// page runs:
//   Android app   NativePlayer   ExoPlayer in a foreground service: plays with the screen off
//   Desktop app   ElementPlayer  <audio> elements (two, so crossfade can overlap songs)
//   Web           YouTube's embedded player (browsers can't fetch YouTube audio themselves)
// The two audio players read each song from the app's own local audio server
// (src-tauri/src/stream.rs), always taking the highest-bitrate stream YouTube offers.

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
// Same code as an embed-blocked video, so a song that can't be streamed tries another upload.
const STREAM_UNAVAILABLE = 150;
const NATIVE_AUDIO = Boolean(window.__TAURI__) && /Android/i.test(navigator.userAgent);
const DESKTOP_AUDIO = Boolean(window.__TAURI__) && !NATIVE_AUDIO;
const DIRECT_AUDIO = NATIVE_AUDIO || DESKTOP_AUDIO;

const NATIVE_POLL_MS = 500;
const STREAM_MARGIN_S = 120;
const STREAM_CACHE_MAX = 64;

// ---------------------------------------------------------------- audio settings

const EQ_BANDS = [60, 230, 910, 3600, 14000];
const EQ_RANGE_DB = 12;
const EQ_PRESETS = {
  flat: { label: "Flat", gains: [0, 0, 0, 0, 0] },
  bass: { label: "Bass boost", gains: [6, 4, 1, 0, 0] },
  treble: { label: "Treble boost", gains: [0, 0, 1, 4, 6] },
  vocal: { label: "Vocal", gains: [-3, -1, 3, 3, 0] },
  rock: { label: "Rock", gains: [4, 2, -1, 2, 4] },
};

const clampGain = (n) => Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, Math.round(Number(n) || 0)));

// What the player does to the sound, from the user's settings. Players listen for changes.
const audioFx = {
  normalize: false,
  skipSilence: false,
  eq: { on: false, gains: [0, 0, 0, 0, 0] },
  listeners: new Set(),
  configure(settings = {}) {
    this.normalize = Boolean(settings.normalize);
    this.skipSilence = Boolean(settings.skipSilence);
    const gains = Array.isArray(settings.eq?.gains) ? settings.eq.gains : [];
    this.eq = { on: Boolean(settings.eq?.on), gains: EQ_BANDS.map((_, i) => clampGain(gains[i])) };
    for (const listener of this.listeners) listener();
  },
};

// ---------------------------------------------------------------- stream info

// What the Rust core says about a song's best audio stream: where to read it, its codec and
// bitrate, and how loud it is. Asking also warms the core's own cache, so the song starts sooner.
const streamCache = new Map();

function streamInfo(id, { fresh = false } = {}) {
  const hit = streamCache.get(id);
  const stale = hit?.info && hit.info.validUntil - STREAM_MARGIN_S < Date.now() / 1000;
  if (hit && !fresh && !stale) return hit.promise;
  const entry = { info: null, promise: null };
  entry.promise = api(`/api/stream?id=${enc(id)}`).then(
    (info) => {
      entry.info = info;
      return info;
    },
    (err) => {
      if (streamCache.get(id) === entry) streamCache.delete(id);
      throw err;
    },
  );
  streamCache.set(id, entry);
  if (streamCache.size > STREAM_CACHE_MAX) streamCache.delete(streamCache.keys().next().value);
  return entry.promise;
}

function qualityLabel(info) {
  if (!info) return "";
  const codec = { opus: "Opus", mp4a: "AAC" }[info.codec] || String(info.codec || "").toUpperCase();
  const kbps = info.bitrate ? `${Math.round(info.bitrate / 1000)} kbps` : "";
  return [codec, kbps].filter(Boolean).join(" · ");
}

// YouTube's own "stable volume": loud songs are turned down, quiet ones are left alone.
function normalizeFactor(info) {
  if (!audioFx.normalize || typeof info?.loudnessDb !== "number") return 1;
  return Math.min(1, 10 ** (-info.loudnessDb / 20));
}

// ---------------------------------------------------------------- shared by both audio players

class DirectPlayer {
  constructor(events) {
    this.events = events;
    this.gen = 0;
    this.id = null;
    this.info = null;
    this.retried = false;
    this.vol = 100;
    this.silent = false;
    this.mapped = YT_STATE.UNSTARTED;
    this.pos = 0;
    this.dur = 0;
  }

  emit(data) {
    if (data === this.mapped) return;
    this.mapped = data;
    this.events.onStateChange({ target: this, data });
  }

  fail() {
    this.gen += 1;
    this.events.onError({ target: this, data: STREAM_UNAVAILABLE });
  }

  announceQuality() {
    this.events.onQuality?.(this, qualityLabel(this.info));
  }

  loadVideoById({ videoId, startSeconds = 0 }) { return this.load(videoId, startSeconds, true); }
  cueVideoById({ videoId, startSeconds = 0 }) { return this.load(videoId, startSeconds, false); }
  getPlayerState() { return this.mapped; }
  getDuration() { return this.dur; }
  setVolume(value) { this.vol = value; this.applyVolume(); }
  mute() { this.silent = true; this.applyVolume(); }
  unMute() { this.silent = false; this.applyVolume(); }
}

// ---------------------------------------------------------------- desktop: <audio> elements

// One shared equalizer: every player's output goes through the same five filters.
const eqChain = {
  ctx: null,
  input: null,
  filters: [],

  context() {
    if (this.ctx) return this.ctx;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    const ctx = new Context();
    this.input = ctx.createGain();
    this.filters = EQ_BANDS.map((frequency, i) => {
      const filter = ctx.createBiquadFilter();
      filter.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = 0;
      return filter;
    });
    let last = this.input;
    for (const filter of this.filters) {
      last.connect(filter);
      last = filter;
    }
    last.connect(ctx.destination);
    this.ctx = ctx;
    return ctx;
  },

  // A context that can't run would make an attached element silent, so only attach to a running one.
  async running() {
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    return ctx.state === "running" ? ctx : null;
  },

  attach(ctx, audio) {
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.input);
    return gain;
  },

  apply() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.filters.forEach((filter, i) => filter.gain.setTargetAtTime(audioFx.eq.on ? audioFx.eq.gains[i] : 0, now, 0.03));
  },
};

class ElementPlayer extends DirectPlayer {
  constructor(events) {
    super(events);
    this.start = 0;
    // True from asking for a song until its first bytes arrive: the element still holds the old one.
    this.fresh = false;
    this.gainNode = null;
    this.norm = 1;
    const audio = new Audio();
    audio.preload = "auto";
    // The audio comes from another origin (the local audio server); the equalizer needs it readable.
    audio.crossOrigin = "anonymous";
    this.audio = audio;
    audio.addEventListener("playing", () => this.emit(YT_STATE.PLAYING));
    audio.addEventListener("pause", () => { if (this.id && !audio.ended) this.emit(YT_STATE.PAUSED); });
    audio.addEventListener("waiting", () => { if (this.id && !audio.paused) this.emit(YT_STATE.BUFFERING); });
    audio.addEventListener("ended", () => { if (this.id) this.emit(YT_STATE.ENDED); });
    audio.addEventListener("error", () => this.onMediaError());
    audio.addEventListener("loadedmetadata", () => {
      this.fresh = false;
      if (this.start > 0) audio.currentTime = this.start;
      this.start = 0;
    });
    audioFx.listeners.add(() => this.applyFx());
    setTimeout(() => events.onReady({ target: this }), 0);
  }

  async load(id, start, autoplay) {
    const gen = ++this.gen;
    this.id = id;
    this.start = start;
    this.pos = start;
    this.dur = 0;
    this.fresh = true;
    this.retried = false;
    this.audio.pause();
    this.emit(autoplay ? YT_STATE.BUFFERING : YT_STATE.PAUSED);
    try {
      this.info = await streamInfo(id);
    } catch {
      if (gen === this.gen) this.fail();
      return;
    }
    if (gen !== this.gen) return;
    await this.open(autoplay, gen);
  }

  async open(autoplay, gen) {
    this.audio.src = this.info.src;
    this.audio.load();
    this.announceQuality();
    this.applyFx();
    if (autoplay) await this.play(gen);
  }

  async play(gen = this.gen) {
    await this.attachChain();
    if (gen !== this.gen) return;
    try {
      await this.audio.play();
    } catch (err) {
      // A newer load replaced this one (AbortError), or the browser wants a click first.
      if (gen === this.gen && err?.name !== "AbortError") this.emit(YT_STATE.PAUSED);
    }
  }

  // Routes this element through the equalizer, once it's wanted and the audio context is running.
  async attachChain() {
    if (!audioFx.eq.on || this.gainNode) return;
    const ctx = await eqChain.running();
    if (!ctx || this.gainNode) return;
    try {
      this.gainNode = eqChain.attach(ctx, this.audio);
    } catch { /* already routed, or not allowed: the plain output still works */ }
    this.applyFx();
  }

  async onMediaError() {
    if (!this.id || !this.audio.getAttribute("src")) return;
    const gen = this.gen;
    if (this.retried) return this.fail();
    this.retried = true;
    try {
      this.info = await streamInfo(this.id, { fresh: true });
    } catch {
      return this.fail();
    }
    if (gen !== this.gen) return;
    this.start = this.audio.currentTime || this.start;
    await this.open(true, gen);
  }

  applyFx() {
    this.norm = normalizeFactor(this.info);
    this.applyVolume();
    if (audioFx.eq.on && !this.gainNode && this.audio.getAttribute("src")) this.attachChain();
    eqChain.apply();
  }

  applyVolume() {
    const level = this.silent ? 0 : (this.vol / 100) * this.norm;
    if (this.gainNode) {
      this.audio.volume = 1;
      this.gainNode.gain.value = level;
    } else {
      this.audio.volume = Math.max(0, Math.min(1, level));
    }
  }

  playVideo() {
    if (!this.id) return;
    return this.play();
  }

  pauseVideo() { this.audio.pause(); }

  stopVideo() {
    this.gen += 1;
    this.id = null;
    this.fresh = false;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.mapped = YT_STATE.UNSTARTED;
  }

  seekTo(seconds) {
    if (!this.fresh && this.audio.readyState >= 1) this.audio.currentTime = seconds;
    else this.start = seconds;
    this.pos = seconds;
  }

  getCurrentTime() { return !this.fresh && this.audio.readyState >= 1 ? this.audio.currentTime : this.start || this.pos; }

  getDuration() { return !this.fresh && Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }

  // The audio element needs nothing queued; asking early just makes the next song start sooner.
  setUpcoming(tracks) {
    for (const track of tracks.slice(0, 2)) streamInfo(track.id).catch(() => {});
  }

  setSleep() {}
}

// ---------------------------------------------------------------- Android: ExoPlayer service

const nativeCall = (command, args) => window.__TAURI__.core.invoke("native_player", { command, args: args ?? null });

class NativePlayer extends DirectPlayer {
  constructor(events) {
    super(events);
    this.polledAt = 0;
    this.playing = false;
    this.slots = new Map();
    this.slotCount = 0;
    this.upcomingToken = 0;
    setInterval(() => this.poll(), NATIVE_POLL_MS);
    audioFx.listeners.add(() => this.applyFx());
    setTimeout(() => {
      events.onReady({ target: this });
      this.applyFx();
    }, 0);
  }

  // Each queued song gets its own slot, so the same song queued twice can still be told apart.
  slotFor(track) {
    const slot = String(++this.slotCount);
    this.slots.set(slot, track);
    if (this.slots.size > 200) this.slots.delete(this.slots.keys().next().value);
    return slot;
  }

  trackFor(id) {
    const now = typeof current === "function" ? current() : null;
    return now?.id === id ? now : state.queue.find((t) => t.id === id) || { id };
  }

  async load(id, start, autoplay) {
    const gen = ++this.gen;
    this.id = id;
    this.pos = start;
    this.dur = 0;
    this.retried = false;
    if (autoplay) this.emit(YT_STATE.BUFFERING);
    try {
      this.info = await streamInfo(id);
      if (gen !== this.gen) return;
      await this.send(start, autoplay, gen);
    } catch {
      if (gen === this.gen) this.fail();
    }
  }

  async send(start, autoplay, gen) {
    const track = this.trackFor(this.id);
    this.slot = this.slotFor(track);
    await nativeCall("load", {
      gen,
      slot: this.slot,
      url: this.info.src,
      startSeconds: start,
      autoplay,
      title: track.title || "",
      artist: track.artist || "",
      art: track.art || null,
      loudnessDb: this.info.loudnessDb ?? null,
    });
    this.announceQuality();
    this.applyVolume();
    this.applyFx();
    this.poll();
  }

  // The songs after this one, handed to the native player so it can start them by itself: it keeps
  // playing when the page is asleep (screen off), and changes songs without a gap.
  async setUpcoming(tracks, repeatOne = false) {
    const token = ++this.upcomingToken;
    const gen = this.gen;
    const items = [];
    const send = () => nativeCall("queue", { gen, repeatOne, items: items.slice() }).catch(() => {});
    if (!repeatOne) {
      for (const track of tracks) {
        let info;
        try {
          info = await streamInfo(track.id);
        } catch {
          break;
        }
        if (token !== this.upcomingToken) return;
        items.push({
          slot: this.slotFor(track),
          url: info.src,
          title: track.title || "",
          artist: track.artist || "",
          art: track.art || null,
          loudnessDb: info.loudnessDb ?? null,
        });
        // The next song is queued as soon as it's known; the rest follow.
        if (items.length === 1) await send();
      }
    }
    if (token === this.upcomingToken) await send();
  }

  setSleep(seconds) { nativeCall("sleep", { seconds: Math.max(0, Math.round(seconds)) }).catch(() => {}); }

  async poll() {
    const gen = this.gen;
    let s;
    try {
      s = await nativeCall("status");
    } catch {
      return;
    }
    // A song was loaded since this was asked, or the native player hasn't heard of it yet.
    if (gen !== this.gen || !this.id || s.loadGen !== gen) return;
    if (s.command === "next") next();
    else if (s.command === "previous") prev();
    if (s.sleepFired) this.events.onSleep?.();
    if (s.slot && s.slot !== this.slot) {
      // The native player moved on by itself.
      this.slot = s.slot;
      const track = this.slots.get(s.slot);
      if (track) {
        this.id = track.id;
        this.info = streamCache.get(track.id)?.info || this.info;
        this.pos = 0;
        this.announceQuality();
        this.events.onAdvance?.(track);
      }
    }
    if (s.error && s.state !== "ended") {
      // The native player already tried again; ask once for a fresh link, then give up on the song.
      if (this.retried) return this.fail();
      this.retried = true;
      try {
        this.info = await streamInfo(this.id, { fresh: true });
        return await this.send(this.pos, true, this.gen);
      } catch {
        return this.fail();
      }
    }
    this.pos = s.position || 0;
    this.dur = s.duration || this.dur;
    this.polledAt = performance.now();
    this.playing = Boolean(s.playing);
    if (s.state === "ended") this.emit(YT_STATE.ENDED);
    else if (s.playing) this.emit(YT_STATE.PLAYING);
    else if (s.state === "buffering" || (s.state === "ready" && s.wantsPlay)) this.emit(YT_STATE.BUFFERING);
    else if (s.state === "ready") this.emit(YT_STATE.PAUSED);
  }

  applyVolume() {
    nativeCall("volume", { volume: this.silent ? 0 : this.vol / 100 }).catch(() => {});
  }

  applyFx() {
    nativeCall("fx", {
      normalize: audioFx.normalize,
      skipSilence: audioFx.skipSilence,
      eqOn: audioFx.eq.on,
      gains: audioFx.eq.gains,
      bands: EQ_BANDS,
    }).catch(() => {});
  }

  playVideo() {
    if (this.mapped === YT_STATE.ENDED) return this.seekTo(0).then(() => nativeCall("play")).then(() => this.poll()).catch(() => {});
    return nativeCall("play").then(() => this.poll()).catch(() => {});
  }

  pauseVideo() { return nativeCall("pause").then(() => this.poll()).catch(() => {}); }
  stopVideo() { return nativeCall("stop").catch(() => {}); }

  seekTo(seconds) {
    this.pos = seconds;
    this.polledAt = performance.now();
    return nativeCall("seek", { seconds }).then(() => this.poll()).catch(() => {});
  }

  getCurrentTime() { return this.playing ? this.pos + (performance.now() - this.polledAt) / 1000 : this.pos; }
}

// ---------------------------------------------------------------- fallback to YouTube's embedded player

let youtubeApi = null;

// Loads YouTube's iframe API the first time something needs it.
function loadYouTubeApi() {
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      youtubeApi = null;
      reject(new Error("Couldn't reach YouTube."));
    };
    document.head.append(script);
  });
  return youtubeApi;
}

const EMBED_PLAYER_VARS = { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0 };
const EMBED_ERROR = 5;
const DIRECT_FAILURES_BEFORE_SKIP = 2;
const DIRECT_SKIP_MS = 10 * 60 * 1000;
const EMBED_LABEL = "YouTube player · quality set by YouTube";

// Tries a song's direct audio first. If YouTube won't hand it over (a changed rule, a blocked
// link), the song plays through YouTube's embedded player instead, so music never just stops.
// After repeated failures it goes straight to the embed for a while.
class HybridPlayer {
  constructor(events, makeDirect, slotId) {
    this.events = events;
    this.slotId = slotId;
    this.gen = 0;
    this.mode = "direct";
    this.embed = null;
    this.embedReady = null;
    this.opts = null;
    this.autoplay = false;
    this.vol = 100;
    this.silent = false;
    this.directFailures = 0;
    this.skipDirectUntil = 0;
    this.direct = makeDirect({
      onReady: () => events.onReady({ target: this }),
      onStateChange: (e) => {
        if (this.mode !== "direct") return;
        if (e.data === YT_STATE.PLAYING) this.directFailures = 0;
        events.onStateChange({ target: this, data: e.data });
      },
      onError: () => this.directFailed(),
      onQuality: (_player, label) => { if (this.mode === "direct") events.onQuality?.(this, label); },
      onAdvance: (track) => events.onAdvance?.(track),
      onSleep: () => events.onSleep?.(),
    });
  }

  get active() { return this.mode === "embed" && this.embed ? this.embed : this.direct; }

  start(opts, autoplay) {
    const gen = ++this.gen;
    this.opts = opts;
    this.autoplay = autoplay;
    if (Date.now() < this.skipDirectUntil) return this.openEmbed(opts, autoplay, gen);
    this.closeEmbed();
    this.mode = "direct";
    return autoplay ? this.direct.loadVideoById(opts) : this.direct.cueVideoById(opts);
  }

  directFailed() {
    if (this.mode !== "direct" || !this.opts) return;
    this.directFailures += 1;
    if (this.directFailures >= DIRECT_FAILURES_BEFORE_SKIP) this.skipDirectUntil = Date.now() + DIRECT_SKIP_MS;
    const at = this.direct.getCurrentTime?.() || this.opts.startSeconds || 0;
    this.direct.stopVideo?.();
    this.openEmbed({ ...this.opts, startSeconds: at }, this.autoplay, ++this.gen);
  }

  async openEmbed(opts, autoplay, gen) {
    this.mode = "embed";
    this.events.onQuality?.(this, EMBED_LABEL);
    try {
      await this.ensureEmbed();
    } catch {
      if (gen === this.gen) this.events.onError({ target: this, data: EMBED_ERROR });
      return;
    }
    if (gen !== this.gen) return;
    this.showEmbed(true);
    if (autoplay) this.embed.loadVideoById(opts);
    else this.embed.cueVideoById(opts);
  }

  ensureEmbed() {
    if (this.embedReady) return this.embedReady;
    this.embedReady = loadYouTubeApi()
      .then(() => new Promise((resolve) => {
        const embed = new YT.Player(this.slotId, {
          width: "100%",
          height: "100%",
          playerVars: { ...EMBED_PLAYER_VARS, origin: location.origin },
          events: {
            onReady: () => {
              this.embed = embed;
              embed.setVolume(this.vol);
              if (this.silent) embed.mute();
              resolve(embed);
            },
            onStateChange: (e) => { if (this.mode === "embed") this.events.onStateChange({ target: this, data: e.data }); },
            onError: (e) => { if (this.mode === "embed") this.events.onError({ target: this, data: e.data }); },
          },
        });
      }))
      .catch((err) => {
        this.embedReady = null;
        throw err;
      });
    return this.embedReady;
  }

  showEmbed(on) { this.embed?.getIframe?.()?.classList.toggle("front", on); }

  closeEmbed() {
    this.showEmbed(false);
    try { this.embed?.stopVideo(); } catch { /* not ready yet */ }
  }

  loadVideoById(opts) { return this.start(opts, true); }
  cueVideoById(opts) { return this.start(opts, false); }
  playVideo() { return this.active.playVideo(); }
  pauseVideo() { return this.active.pauseVideo(); }
  seekTo(seconds, allowAhead) { return this.active.seekTo(seconds, allowAhead); }
  getCurrentTime() { return this.active.getCurrentTime(); }
  getDuration() { return this.active.getDuration(); }

  getPlayerState() {
    if (this.mode === "embed" && !this.embed) return YT_STATE.BUFFERING;
    return this.active.getPlayerState();
  }

  stopVideo() {
    this.gen += 1;
    this.direct.stopVideo?.();
    this.closeEmbed();
  }

  setVolume(value) {
    this.vol = value;
    this.direct.setVolume(value);
    this.embed?.setVolume(value);
  }

  mute() {
    this.silent = true;
    this.direct.mute();
    this.embed?.mute();
  }

  unMute() {
    this.silent = false;
    this.direct.unMute();
    this.embed?.unMute();
  }

  // Only the direct player can queue ahead or keep time while the page sleeps.
  setUpcoming(tracks, repeatOne) { if (this.mode === "direct") return this.direct.setUpcoming?.(tracks, repeatOne); }
  setSleep(seconds) { this.direct.setSleep?.(seconds); }
}
