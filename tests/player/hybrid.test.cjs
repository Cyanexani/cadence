const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:8001/harness-hybrid.html");
  const waitFor = async (fn, what, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return; await sleep(40); } throw new Error("timed out: " + what); };
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  await page.evaluate(() => { window.h = makeHybrid(); });
  await waitFor(() => events.some((e) => e[0] === "ready"), "ready");
  ok("hybrid player reports ready once");

  // 1. direct works: no embed is created, events carry the hybrid as target
  await page.evaluate(() => h.loadVideoById({ videoId: "AAAAAAAAAAA" }));
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1), "playing");
  assert.equal(await page.evaluate(() => fakeEmbeds.length), 0); ok("a working song never touches YouTube's embed");
  assert.ok(await page.evaluate(() => events.filter((e) => e[0] === "state").every((e) => e[2] === true))); ok("events are reported with the hybrid as target");
  assert.equal(await page.evaluate(() => h.mode), "direct");
  assert.deepEqual(await page.evaluate(() => events.find((e) => e[0] === "quality")), ["quality", "Opus · 160 kbps"]); ok("direct quality label shown");

  // 2. direct fails -> embed takes over at the same spot, with volume carried over
  await page.evaluate(() => { events.length = 0; h.setVolume(55); h.mute(); h.loadVideoById({ videoId: "BADBADBADBA", startSeconds: 12 }); });
  await waitFor(() => fakeEmbeds.length === 1 && fakeEmbeds[0].calls.some((c) => c[0] === "load"), "embed load");
  const embed = await page.evaluate(() => ({ slot: fakeEmbeds[0].slot, calls: fakeEmbeds[0].calls, vol: fakeEmbeds[0].vol, muted: fakeEmbeds[0].muted, front: fakeEmbeds[0].iframe.classList.contains("front") }));
  assert.equal(embed.slot, "yt-a"); assert.equal(embed.calls[0][0], "load"); assert.equal(embed.calls[0][1].videoId, "BADBADBADBA");
  assert.ok(embed.calls[0][1].startSeconds >= 12); ok("a failing song moves to the embed, keeping its start position");
  assert.equal(embed.vol, 55); assert.equal(embed.muted, true); ok("volume and mute carry over to the embed");
  assert.equal(embed.front, true); ok("the embed is shown");
  assert.equal(await page.evaluate(() => h.mode), "embed");
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1), "embed state forwarded");
  assert.deepEqual(await page.evaluate(() => events.filter((e) => e[0] === "error")), []); ok("the failure is not reported as an error (the embed handled it)");
  assert.deepEqual(await page.evaluate(() => events.find((e) => e[0] === "quality")), ["quality", "YouTube player · quality set by YouTube"]); ok("embed quality label says so");
  assert.equal(await page.evaluate(() => [h.getCurrentTime(), h.getDuration(), h.getPlayerState()].join()), "7,100,1"); ok("controls reach the embed while it is active");
  await page.evaluate(() => h.pauseVideo()); assert.equal(await page.evaluate(() => fakeEmbeds[0].calls.slice(-1)[0][0]), "pause"); ok("pause goes to the embed");

  // 3. a second failure in a row -> the next song skips direct entirely
  await page.evaluate(() => { events.length = 0; h.loadVideoById({ videoId: "BADBADBADBA" }); });
  await waitFor(() => fakeEmbeds[0].calls.filter((c) => c[0] === "load").length === 2, "second embed load");
  assert.ok(await page.evaluate(() => h.skipDirectUntil > Date.now())); ok("two failures in a row make it skip direct audio for a while");
  const loadsBefore = await page.evaluate(() => { window.audioLoads = 0; return fakeEmbeds.length; });
  await page.evaluate(() => h.loadVideoById({ videoId: "AAAAAAAAAAA" }));
  await waitFor(() => fakeEmbeds[0].calls.filter((c) => c[0] === "load").length === 3, "third goes straight to embed");
  assert.equal(await page.evaluate(() => h.mode), "embed"); assert.equal(await page.evaluate(() => fakeEmbeds.length), loadsBefore); ok("a good song goes straight to the embed during the skip window (one embed reused)");

  // 4. after the window, direct is tried again and a success clears the failures
  await page.evaluate(() => { h.skipDirectUntil = 0; events.length = 0; h.loadVideoById({ videoId: "AAAAAAAAAAA" }); });
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1 && e[2]), "direct playing again");
  assert.equal(await page.evaluate(() => h.mode), "direct"); assert.equal(await page.evaluate(() => h.directFailures), 0); ok("direct is tried again later and a success resets the count");
  assert.equal(await page.evaluate(() => fakeEmbeds[0].iframe.classList.contains("front")), false); ok("the embed is hidden when direct takes over");
  assert.equal(await page.evaluate(() => fakeEmbeds[0].calls.slice(-1)[0][0]), "stop"); ok("and stopped, so it can't keep playing underneath");

  // 5. stop hides everything
  await page.evaluate(() => h.stopVideo());
  assert.equal(await page.evaluate(() => h.direct.audio.paused), true); ok("stopVideo stops the direct audio");

  assert.deepEqual(errors, [], "no page errors"); ok("no page errors");
  await browser.close();
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
