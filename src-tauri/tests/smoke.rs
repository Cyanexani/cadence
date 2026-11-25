//! Live smoke test of the Rust music API against YouTube Music, LRCLIB and SponsorBlock.
//! Needs the network: `cargo test --test smoke -- --nocapture`.

use std::collections::HashMap;

use cadence_lib::music::Music;
use serde_json::Value;

fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

async fn call(music: &Music, path: &str, pairs: &[(&str, &str)]) -> Value {
    match music.dispatch(path, params(pairs)).await {
        Ok(v) => v,
        Err(e) => panic!("{path} failed: {e}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn music_api_answers_like_the_python_core() {
    let music = Music::new(std::env::temp_dir().join("cadence-smoke")).expect("client starts");

    let home = call(&music, "/api/home", &[("gl", "IN")]).await;
    let shelves = home["shelves"].as_array().expect("shelves");
    println!("home: {} shelves: {:?}", shelves.len(), shelves.iter().map(|s| s["title"].as_str().unwrap_or("")).collect::<Vec<_>>());
    assert!(!shelves.is_empty());

    let songs = call(&music, "/api/search", &[("q", "do i wanna know arctic monkeys"), ("type", "songs")]).await;
    let first = &songs["items"][0];
    println!("search: {} by {} ({}s) album={} art={}", first["title"], first["artist"], first["duration"], first["albumId"], first["art"]);
    assert!(first["id"].as_str().is_some_and(|id| id.len() == 11));

    for kind in ["videos", "albums", "artists", "playlists"] {
        let found = call(&music, "/api/search", &[("q", "coke studio"), ("type", kind)]).await;
        println!("search {kind}: {} items, first: {}", found["items"].as_array().map_or(0, Vec::len), found["items"][0]["title"]);
    }

    let album_id = first["albumId"].as_str().expect("album id");
    let album = call(&music, "/api/album", &[("id", album_id)]).await;
    println!("album: {} by {} — {} tracks, meta {}", album["title"], album["subtitle"], album["tracks"].as_array().map_or(0, Vec::len), album["meta"]);

    let artist_id = first["artistId"].as_str().expect("artist id");
    let artist = call(&music, "/api/artist", &[("id", artist_id)]).await;
    println!("artist: {} — {} songs, {} albums, {} singles, {} related", artist["title"],
        artist["songs"].as_array().map_or(0, Vec::len), artist["albums"].as_array().map_or(0, Vec::len),
        artist["singles"].as_array().map_or(0, Vec::len), artist["related"].as_array().map_or(0, Vec::len));

    let id = first["id"].as_str().expect("id");
    let radio = call(&music, "/api/radio", &[("id", id)]).await;
    println!("radio: {} tracks", radio["items"].as_array().map_or(0, Vec::len));

    let suggest = call(&music, "/api/suggest", &[("q", "tay")]).await;
    println!("suggest: {}", suggest["items"]);

    let moods = call(&music, "/api/moods", &[]).await;
    let mood_id = moods["groups"][0]["items"][0]["params"].as_str().expect("a mood");
    let mood = call(&music, "/api/mood", &[("params", mood_id)]).await;
    println!("moods: {} / {} items; first mood has {} playlists", moods["groups"][0]["items"].as_array().map_or(0, Vec::len),
        moods["groups"][1]["items"].as_array().map_or(0, Vec::len), mood["items"].as_array().map_or(0, Vec::len));

    let lyrics = call(&music, "/api/lyrics", &[("title", "Do I Wanna Know?"), ("artist", "Arctic Monkeys"), ("duration", "273")]).await;
    println!("lyrics: synced lines = {}, first = {}", lyrics["synced"].as_array().map_or(0, Vec::len), lyrics["synced"][0]);
    assert!(lyrics["synced"].is_array());

    let skips = call(&music, "/api/skips", &[("id", "1_O_T6Aq85E")]).await;
    println!("skips: {}", skips["segments"]);

    assert!(music.dispatch("/api/nope", HashMap::new()).await.is_err());
}

/// The local audio server end to end: ask YouTube for a song's best stream, then read it through
/// the server the way a player does (ranged requests), including a seek near the end.
/// YouTube ties each stream link to the IP that asked for it, so this needs a plain connection;
/// behind a proxy that changes the source address per connection every read is refused (403).
/// Run it with `cargo test --test smoke songs_stream -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a connection whose IP stays the same between youtube.com and googlevideo.com"]
async fn songs_stream_through_the_local_audio_server() {
    let music = std::sync::Arc::new(Music::new(std::env::temp_dir().join("cadence-smoke-audio")).expect("client starts"));
    let (listener, port) = cadence_lib::stream::bind().await.expect("a free port");
    let secret = "smokesecret";
    music.set_audio_base(format!("http://127.0.0.1:{port}/{secret}"));
    tokio::spawn(cadence_lib::stream::run(listener, secret.to_string(), music.clone()));

    let info = call(&music, "/api/stream", &[("id", "1_O_T6Aq85E")]).await;
    println!(
        "stream: {} {} kbps {} bytes loudness {} valid until {}",
        info["codec"], info["bitrate"].as_u64().unwrap_or(0) / 1000, info["size"], info["loudnessDb"], info["validUntil"]
    );
    let size = info["size"].as_u64().expect("size");
    assert!(size > 100_000, "a song is bigger than 100 kB");
    assert!(info["bitrate"].as_u64().unwrap_or(0) >= 100_000, "best stream is at least 100 kbps");
    let src = info["src"].as_str().expect("src");

    let client = reqwest::Client::new();
    let started = std::time::Instant::now();
    let start = client.get(src).header("Range", "bytes=0-199999").send().await.expect("answers");
    let status = start.status().as_u16();
    let bytes = start.bytes().await.expect("body");
    assert_eq!(status, 206, "the server said: {}", String::from_utf8_lossy(&bytes));
    assert_eq!(bytes.len(), 200_000);
    println!("first 200 kB in {:?}, starts {:02x?}", started.elapsed(), &bytes[..4]);

    // A seek: the last 50 kB, open-ended.
    let from = size - 50_000;
    let tail = client.get(src).header("Range", format!("bytes={from}-")).send().await.expect("answers");
    assert_eq!(tail.status().as_u16(), 206);
    assert_eq!(tail.bytes().await.expect("body").len(), 50_000);

    // Throughput over a few chunks: a throttled link would crawl.
    let started = std::time::Instant::now();
    let long = client.get(src).header("Range", "bytes=0-3999999").send().await.expect("answers");
    let body = long.bytes().await.expect("body");
    let secs = started.elapsed().as_secs_f64();
    println!("{} bytes in {secs:.2}s = {:.0} kB/s", body.len(), body.len() as f64 / secs / 1000.0);
    assert!(body.len() as u64 >= 3_999_999.min(size - 1));
}
