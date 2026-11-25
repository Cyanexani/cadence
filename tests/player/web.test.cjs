// The web version (no Tauri): it must keep using YouTube's embedded player and show no app-only settings.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The server and YouTube are stand-ins: every API call answers {}, and the iframe API is a fake player.
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.route("https://www.youtube.com/iframe_api", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.__embeds = [];
      window.YT = { Player: class {
        constructor(slot, cfg) { this.slot = slot; this.cfg = cfg; this.calls = []; this.vol = 100; __embeds.push(this); setTimeout(() => cfg.events.onReady({ target: this }), 0); }
        setVolume(v) { this.vol = v; } mute() {} unMute() {} getIframe() { return null; }
        loadVideoById(o) { this.calls.push(["load", o.videoId]); } cueVideoById(o) { this.calls.push(["cue", o.videoId]); }
        playVideo() {} pauseVideo() {} stopVideo() {} seekTo() {} getCurrentTime() { return 0; } getDuration() { return 0; } getPlayerState() { return -1; }
      } };
      setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);`,
  }));
  await page.goto("http://127.0.0.1:8003/index.html");
  const waitFor = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return; await sleep(50); } throw new Error("timed out: " + what); };
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  await waitFor(() => typeof playList === "function" && playerReady, "app ready");
  ok("the page boots on the web");
  assert.equal(await page.evaluate(() => [DIRECT_AUDIO, NATIVE_AUDIO, DESKTOP_AUDIO].join()), "false,false,false"); ok("direct audio is off on the web");
  assert.equal(await page.evaluate(() => [players.length, players[0].constructor.name].join()), "2,Player"); ok("two YouTube embed players, as before");
  assert.equal(await page.evaluate(() => document.getElementById("app").classList.contains("direct-audio")), false); ok("no cover-art mode: the video area stays");

  await page.evaluate(() => playList([{ id: "AAAAAAAAAAA", title: "A", artist: "X", duration: 3 }], 0));
  await waitFor(() => __embeds[0].calls.some((c) => c[0] === "load" && c[1] === "AAAAAAAAAAA"), "embed load");
  ok("playing a song loads it in the embedded player");
  assert.equal(await page.evaluate(() => document.getElementById("np-quality").hidden), true); ok("no quality badge (the embed doesn't say)");

  await page.evaluate(() => { location.hash = "#settings"; });
  await waitFor(() => document.getElementById("set-sponsorblock"), "settings");
  assert.equal(await page.evaluate(() => !!document.getElementById("set-crossfade")), true); ok("crossfade is on the web settings page");
  assert.equal(await page.evaluate(() => [!!document.getElementById("set-eq-on"), !!document.getElementById("set-normalize")].join()), "false,false"); ok("the Sound section (equalizer, volume evening) is app-only");

  assert.deepEqual(errors, [], "no page errors: " + errors.join("; ")); ok("no page errors");
  await browser.close();
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
