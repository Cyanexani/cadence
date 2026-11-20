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
