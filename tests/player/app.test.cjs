// The real page (public/) in "desktop app" mode: a faked Tauri backend, the mock audio server on another origin.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__apiCalls = [];
    window.__TAURI__ = { core: { invoke: async (cmd, a) => {
      if (cmd !== "api") throw new Error("unexpected command " + cmd);
      __apiCalls.push(a.path);
      const id = a.params && a.params.id;
      switch (a.path) {
        case "/api/stream": return { src: `http://127.0.0.1:8002/secret/${id}`, mime: "audio/wav", codec: "opus", bitrate: 160000, size: 1, loudnessDb: 6, validUntil: Date.now() / 1000 + 3600 };
        case "/api/radio": return { items: [] };
        case "/api/lyrics": return { synced: null, plain: null };
        case "/api/skips": return { segments: [] };
        default: return {};
      }
    } } };
  });
  await page.goto("http://127.0.0.1:8003/index.html");
  const waitFor = async (fn, what, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return; await sleep(50); } throw new Error("timed out: " + what); };
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  await waitFor(() => typeof playList === "function" && playerReady, "app ready");
  ok("the page boots in desktop-app mode with a ready player");
  assert.equal(await page.evaluate(() => [DIRECT_AUDIO, NATIVE_AUDIO, players.length, players[0].constructor.name].join()), "true,false,2,HybridPlayer"); ok("two hybrid players (direct audio + embed fallback), as on desktop");
  assert.equal(await page.evaluate(() => document.getElementById("app").classList.contains("direct-audio")), true); ok("the page shows cover art instead of the video area");

  const A = { id: "AAAAAAAAAAA", title: "Song A", artist: "Artist", duration: 3, art: "" };
  const B = { id: "BBBBBBBBBBB", title: "Song B", artist: "Artist", duration: 2, art: "" };
  await page.evaluate(([a, b]) => playList([a, b], 0), [A, B]);
  await waitFor(() => state.playing, "playing");
  ok("playList starts the first song");
  await waitFor(() => document.getElementById("np-quality").textContent === "Opus · 160 kbps", "quality badge");
  assert.equal(await page.evaluate(() => document.getElementById("np-quality").hidden), false); ok("the quality badge shows Opus · 160 kbps");
  assert.equal(await page.evaluate(() => document.getElementById("np-title").textContent), "Song A"); ok("now playing shows the song");

  // normalisation off by default: full volume
  const vol = await page.evaluate(() => player.direct.audio.volume);
  assert.ok(Math.abs(vol - 0.8) < 0.02, "default volume 80: " + vol); ok("the saved volume (80) is applied (" + vol + ")");

  // the song ends and the next one starts on its own
  await waitFor(() => state.index === 1 && state.playing, "auto-advance", 8000);
  ok("the next song starts by itself when the first ends");
  assert.equal(await page.evaluate(() => document.getElementById("np-title").textContent), "Song B"); ok("and the display follows");
  await waitFor(() => !state.playing, "queue end", 6000);
  ok("playback stops at the end of the queue (nothing similar to add in this test)");

  // settings page
  await page.evaluate(() => { location.hash = "#settings"; });
  await waitFor(() => document.getElementById("set-eq-on"), "settings page");
  ok("the Settings page has the Sound section");
  assert.equal(await page.evaluate(() => !!document.getElementById("set-skip-silence")), false); ok("skip silence is Android only");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".eq-slider").length), 5); ok("five equalizer bands");
  assert.equal(await page.evaluate(() => !!document.getElementById("set-crossfade")), true); ok("crossfade is available on desktop");
  await page.selectOption("#set-eq-preset", "bass");
  await waitFor(() => audioFx.eq.on && audioFx.eq.gains[0] === 6, "preset applied");
  ok("choosing Bass boost turns the equalizer on with its gains");
  assert.deepEqual(await page.evaluate(() => state.settings.eq), { on: true, gains: [6, 4, 1, 0, 0] }); ok("and saves it to the library settings");
  await page.fill("#set-eq-2", "-5"); await page.dispatchEvent("#set-eq-2", "input"); await page.dispatchEvent("#set-eq-2", "change");
  await waitFor(() => state.settings.eq && state.settings.eq.gains[2] === -5, "slider saved");
  assert.equal(await page.evaluate(() => document.getElementById("set-eq-preset").value), "custom"); ok("moving a slider makes the preset Custom and saves the gain");
  assert.equal(await page.evaluate(() => document.getElementById("set-eq-out-2").textContent), "-5 dB"); ok("the dB readout follows");
  await page.check("#set-normalize");
  await waitFor(() => state.settings.normalize === true && audioFx.normalize, "normalize saved");
  ok("the volume-evening switch is saved and applied");

  // reload settings (persisted)
  await page.reload(); await waitFor(() => typeof playList === "function" && playerReady, "reloaded");
  assert.deepEqual(await page.evaluate(() => [audioFx.normalize, audioFx.eq.on, audioFx.eq.gains.join()]), [true, true, "6,4,-5,0,0"]); ok("settings survive a reload and reach the audio engine");

  // normalisation now applies: 6 dB louder than average -> about half volume
  await page.evaluate(([a]) => playList([a], 0), [A]);
  await waitFor(() => state.playing && player.direct.gainNode, "playing through the equalizer");
  const gain = await page.evaluate(() => player.direct.gainNode.gain.value);
  assert.ok(Math.abs(gain - 0.8 * 10 ** (-6 / 20)) < 0.02, "normalised gain " + gain); ok("playing through the equalizer with normalised volume (" + gain.toFixed(3) + ")");

  // crossfade: 1 s on a 3 s song -> the next song starts in the other player before this one ends
  await page.evaluate(() => { audioFx.configure({}); });
  await page.evaluate(async () => { await saveSettings({ crossfade: 1, eq: { on: false, gains: [0, 0, 0, 0, 0] }, normalize: false }); });
  await page.evaluate(([a, b]) => playList([a, b], 0), [A, B]);
  await waitFor(() => state.playing, "playing for crossfade");
  await waitFor(() => state.index === 1, "crossfade began", 6000);
  assert.equal(await page.evaluate(() => players.filter((p) => p.direct.audio.getAttribute("src") && !p.direct.audio.paused).length), 2); ok("crossfade: both players play while the songs overlap");
  assert.equal(await page.evaluate(() => document.getElementById("np-title").textContent), "Song B"); ok("and the display already shows the next song");
  await waitFor(() => fade === null, "fade over", 4000);
  ok("the fade finishes");
  assert.equal(await page.evaluate(() => players.filter((p) => p.direct.audio.getAttribute("src") && !p.direct.audio.paused).length), 1); ok("the old player is stopped afterwards");

  assert.deepEqual(errors, [], "no page errors: " + errors.join("; ")); ok("no console or page errors");
  await browser.close();
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
