const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("http://127.0.0.1:8001/harness.html");
  const states = () => page.evaluate(() => events.filter((e) => e[0] === "state").map((e) => e[1]));
  const waitFor = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return; await sleep(50); } throw new Error("timed out: " + what); };
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  await page.evaluate(() => { window.p = makePlayer(); });
  await waitFor(() => events.some((e) => e[0] === "ready"), "ready");
  ok("player reports ready");

  // 1. load and play, read across origins
  await page.evaluate(() => p.loadVideoById({ videoId: "AAAAAAAAAAA" }));
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1), "playing");
  ok("autoplay reaches PLAYING");
  assert.ok((await states()).includes(3), "buffering was announced first"); ok("BUFFERING announced before PLAYING");
  await waitFor(() => p.getDuration() > 2.9 && p.getDuration() < 3.1, "duration");
  ok("duration is about 3 s (" + (await page.evaluate(() => p.getDuration())).toFixed(2) + ")");
  await sleep(700);
  const t1 = await page.evaluate(() => p.getCurrentTime()); assert.ok(t1 > 0.4, "time advances: " + t1); ok("time advances (" + t1.toFixed(2) + ")");
  assert.deepEqual(await page.evaluate(() => events.find((e) => e[0] === "quality")), ["quality", "Opus · 160 kbps"]); ok("quality label is Opus · 160 kbps");
  let log = await (await fetch("http://127.0.0.1:8001/__log")).json();
  assert.ok(log.length > 0 && log.every((r) => r.origin === "http://127.0.0.1:8001"), "cross-origin requests carry Origin"); ok("audio is requested from the other origin with CORS (" + log.length + " requests)");

  // 2. pause / play
  await page.evaluate(() => p.pauseVideo());
  await waitFor(() => events.filter((e) => e[0] === "state").slice(-1)[0][1] === 2, "paused");
  ok("pause reaches PAUSED");
  await page.evaluate(() => p.playVideo());
  await waitFor(() => events.filter((e) => e[0] === "state").slice(-1)[0][1] === 1, "playing again");
  ok("play resumes");

  // 3. seek then end
  await page.evaluate(() => p.seekTo(2.2));
  await waitFor(() => p.getCurrentTime() > 2.15, "seek");
  ok("seek moves the playhead");
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 0), "ended");
  ok("ENDED fires at the end");
  assert.notEqual((await states()).slice(-1)[0], 2, "no PAUSED after ENDED"); ok("no stray PAUSED after ENDED");

  // 4. volume + normalisation
  await page.evaluate(() => { audioFx.configure({ normalize: false }); p.setVolume(50); });
  assert.equal(await page.evaluate(() => p.audio.volume), 0.5); ok("volume 50 -> element volume 0.5");
  await page.evaluate(() => { audioFx.configure({ normalize: true }); });
  const v = await page.evaluate(() => p.audio.volume);
  assert.ok(Math.abs(v - 0.5 * 10 ** (-6 / 20)) < 0.01, "normalised: " + v); ok("normalisation turns a 6 dB-loud song down (" + v.toFixed(3) + ")");
  await page.evaluate(() => { p.mute(); });
  assert.equal(await page.evaluate(() => p.audio.volume), 0); ok("mute -> 0");
  await page.evaluate(() => { p.unMute(); audioFx.configure({}); });

  // 5. seek before metadata (cue with start offset)
  await page.evaluate(() => p.cueVideoById({ videoId: "BBBBBBBBBBB", startSeconds: 1.2 }));
  await waitFor(() => p.audio.readyState >= 1 && p.getCurrentTime() > 1.1, "cued offset");
  ok("cue honours the start offset (" + (await page.evaluate(() => p.getCurrentTime())).toFixed(2) + ")");
  assert.equal(await page.evaluate(() => p.audio.paused), true); ok("cue does not start playing");

  // 6. equalizer attaches without silencing
  await page.evaluate(() => { audioFx.configure({ eq: { on: true, gains: [6, 0, 0, 0, -6] } }); p.playVideo(); });
  await waitFor(() => !!p.gainNode, "eq attached");
  ok("equalizer routes the element through the audio graph");
  assert.equal(await page.evaluate(() => eqChain.ctx.state), "running"); ok("audio context is running");
  await sleep(250);
  assert.ok(Math.abs(await page.evaluate(() => eqChain.filters[0].gain.value) - 6) < 0.5); ok("band gains follow the settings");
  const before = await page.evaluate(() => p.getCurrentTime()); await sleep(400);
  assert.ok((await page.evaluate(() => p.getCurrentTime())) > before + 0.2, "keeps playing through the graph"); ok("keeps playing through the equalizer");
  await page.evaluate(() => { p.setVolume(40); });
  assert.ok(Math.abs(await page.evaluate(() => p.gainNode.gain.value) - 0.4) < 0.01); ok("volume goes through the gain node when routed");
  await page.evaluate(() => audioFx.configure({}));
  await sleep(250);
  assert.ok(Math.abs(await page.evaluate(() => eqChain.filters[0].gain.value)) < 0.5); ok("turning the equalizer off flattens the bands");

  // 7. errors
  await page.evaluate(() => { window.events.length = 0; p.loadVideoById({ videoId: "BADBADBADBA" }); });
  await waitFor(() => events.some((e) => e[0] === "error" && e[1] === 150), "error 150");
  ok("an unavailable stream reports error 150");

  // 8. a second player can fade in while the first fades out (crossfade uses two)
  await page.evaluate(() => { window.q = makePlayer(); });
  await page.evaluate(() => { p.loadVideoById({ videoId: "AAAAAAAAAAA" }); q.setVolume(0); q.loadVideoById({ videoId: "BBBBBBBBBBB" }); });
  await waitFor(() => !p.audio.paused && !q.audio.paused, "both playing");
  ok("two players play at once");
  await page.evaluate(() => { p.setVolume(0); q.setVolume(100); });
  await page.evaluate(() => p.stopVideo());
  assert.equal(await page.evaluate(() => p.audio.paused && !p.audio.getAttribute("src")), true); ok("stopVideo clears the old player");
  assert.equal(await page.evaluate(() => q.audio.paused), false); ok("the other keeps playing");

  assert.deepEqual(errors, [], "no page errors"); ok("no console or page errors");
  await browser.close();
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
