const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:8001/harness-native.html");
  const waitFor = async (fn, what, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return; await sleep(40); } throw new Error("timed out: " + what); };
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
  const evs = () => page.evaluate(() => events.slice());

  await page.evaluate(() => { window.p = makePlayer(); });
  await waitFor(() => events.some((e) => e[0] === "ready"), "ready");
  ok("native player reports ready");

  // 1. load + play
  await page.evaluate(() => p.loadVideoById({ videoId: "AAAAAAAAAAA" }));
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1), "playing");
  ok("load reaches PLAYING");
  assert.deepEqual((await evs()).find((e) => e[0] === "quality"), ["quality", "Opus · 160 kbps"]); ok("quality label announced");
  const load = await page.evaluate(() => fake.log.find((l) => l[0] === "load")[1]);
  assert.equal(load.url, "http://127.0.0.1:1/token/AAAAAAAAAAA"); assert.equal(load.loudnessDb, 3); assert.ok(load.gen >= 1 && load.slot); ok("load carries the local-server URL, loudness, generation and slot");

  // 2. upcoming queue: the first song is sent as soon as it is known, then the whole list
  await page.evaluate(() => p.setUpcoming([TRACKS[1], TRACKS[2]], false));
  await waitFor(() => fake.log.filter((l) => l[0] === "queue").length >= 2, "two queue calls");
  const queues = await page.evaluate(() => fake.log.filter((l) => l[0] === "queue").map((l) => l[1]));
  assert.equal(queues[0].items.length, 1); assert.equal(queues[1].items.length, 2);
  assert.equal(queues[1].gen, load.gen); ok("queue: first song first, then the full list, tagged with the load generation");
  assert.equal(new Set(queues[1].items.map((i) => i.slot)).size, 2); ok("every queued item has its own slot");

  // 3. the native player moves on by itself (page "asleep": poll less often)
  await waitFor(() => events.some((e) => e[0] === "advance"), "advance", 6000);
  assert.deepEqual((await evs()).filter((e) => e[0] === "advance"), [["advance", "BBBBBBBBBBB"]]); ok("page is told the native player moved on to B (once)");
  assert.equal(await page.evaluate(() => p.id), "BBBBBBBBBBB"); ok("player follows along");
  assert.equal(await page.evaluate(() => p.getPlayerState()), 1); ok("state stays PLAYING across the change");

  // 4. wait for C, then exhaustion -> ENDED
  await waitFor(() => events.filter((e) => e[0] === "advance").length === 2, "advance to C", 6000);
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 0), "ended", 6000);
  ok("ENDED only when the queued songs run out");

  // 5. stale status is ignored while a new load is pending on the native side
  await page.evaluate(() => { window.events.length = 0; fake.delayLoad = 400; p.loadVideoById({ videoId: "DDDDDDDDDDD" }); });
  await sleep(250);
  assert.equal((await evs()).filter((e) => e[0] === "advance").length, 0, "no advance from a stale status"); ok("statuses from before a new load are ignored (no false advance)");
  await page.evaluate(() => { fake.delayLoad = 0; });
  await waitFor(() => events.some((e) => e[0] === "state" && e[1] === 1), "D playing");
  ok("the new load then takes over");

  // 6. lock-screen buttons and sleep
  await page.evaluate(() => { fake.command = "next"; });
  await waitFor(() => nextCalls === 1, "next command");
  await page.evaluate(() => { fake.command = "previous"; });
  await waitFor(() => prevCalls === 1, "previous command");
  ok("next/previous from the notification reach the page");
  await page.evaluate(() => p.setSleep(0.6));
  await waitFor(() => events.some((e) => e[0] === "sleep"), "sleep fired");
  ok("a native sleep timer is reported back");
  assert.deepEqual(await page.evaluate(() => fake.log.filter((l) => l[0] === "sleep").map((l) => l[1].seconds)), [1]); ok("sleep seconds are whole numbers (0.6 -> 1)");

  // 7. errors: one retry with a fresh link, then give up with 150
  await page.evaluate(() => { window.events.length = 0; window.apiCalls = 0; fake.failNext = 2; p.loadVideoById({ videoId: "AAAAAAAAAAA" }); });
  await waitFor(() => events.some((e) => e[0] === "error" && e[1] === 150), "error 150", 6000);
  ok("a stream that fails twice is reported as unavailable (error 150)");
  assert.equal(await page.evaluate(() => fake.log.filter((l) => l[0] === "load").length >= 2), true); ok("the first failure retried with a fresh link");

  // 8. repeat one is passed through
  await page.evaluate(() => { fake.failNext = 0; p.loadVideoById({ videoId: "AAAAAAAAAAA" }); });
  await waitFor(() => fake.playing, "playing again");
  await page.evaluate(() => p.setUpcoming([TRACKS[1]], true));
  await waitFor(() => fake.repeatOne === true, "repeat one");
  assert.equal(await page.evaluate(() => fake.list.length), 1); ok("repeat one queues nothing and sets the native repeat mode");

  assert.deepEqual(errors, [], "no page errors"); ok("no page errors");
  await browser.close();
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
