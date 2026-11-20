//! Lyrics from LRCLIB and skip segments from SponsorBlock (same logic as core.py).

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::music::{ApiResult, need};

pub const USER_AGENT: &str = "Cadence/0.1 (music player)";
const LRCLIB_SEARCH: &str = "https://lrclib.net/api/search";
const SPONSORBLOCK: &str = "https://sponsor.ajay.app/api/skipSegments";
const SPONSORBLOCK_CATEGORIES: &str = r#"["music_offtopic","sponsor","selfpromo","interaction"]"#;
const LYRICS_DURATION_TOLERANCE: f64 = 4.0;
const LYRICS_MAX_DRIFT: f64 = LYRICS_DURATION_TOLERANCE * 4.0;

static VIDEO_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{11}$").expect("valid regex"));
static LRC_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$").expect("valid regex"));
static TITLE_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[(\[][^)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|hd|4k|mv)[^)\]]*[)\]]")
        .expect("valid regex")
});
static FEAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+[(\[]?(ft\.?|feat\.?|featuring)\s.*$").expect("valid regex"));

fn clean_title(title: &str) -> String {
    FEAT.replace(&TITLE_NOISE.replace_all(title, ""), "").trim().to_string()
}

fn parse_lrc(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|raw| {
            let caps = LRC_LINE.captures(raw.trim())?;
            let minutes: f64 = caps[1].parse().ok()?;
            let seconds: f64 = caps[2].parse().ok()?;
            let t = ((minutes * 60.0 + seconds) * 100.0).round() / 100.0;
            Some(json!({ "t": t, "text": caps[3].trim() }))
        })
        .collect()
}

pub async fn lyrics(http: &reqwest::Client, params: &HashMap<String, String>) -> ApiResult {
    let mut title = clean_title(need(params, "title")?);
    let mut artist = params.get("artist").map_or("", String::as_str).split(',').next().unwrap_or("").trim().to_string();
    if params.get("video").is_some_and(|v| v == "1") {
        if let Some((maybe_artist, maybe_title)) = title.clone().split_once(" - ") {
            artist = maybe_artist.trim().to_string();
            title = clean_title(maybe_title);
        }
    }
    let duration: f64 = params.get("duration").and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let mut query = vec![("track_name", title)];
    if !artist.is_empty() {
        query.push(("artist_name", artist));
    }
    let results: Vec<Value> = http
        .get(LRCLIB_SEARCH)
        .query(&query)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("LRCLIB didn't answer ({e})."))?
        .json()
        .await
        .map_err(|e| format!("LRCLIB sent something unexpected ({e})."))?;
    let gap = |item: &Value| {
        if duration > 0.0 { (item["duration"].as_f64().unwrap_or(0.0) - duration).abs() } else { 0.0 }
    };
    let best = results.iter().min_by(|a, b| {
        let key = |x: &Value| (gap(x) > LYRICS_DURATION_TOLERANCE, x["syncedLyrics"].as_str().is_none(), gap(x));
        let (ka, kb) = (key(a), key(b));
        (ka.0, ka.1).cmp(&(kb.0, kb.1)).then(ka.2.total_cmp(&kb.2))
    });
    let Some(best) = best.filter(|b| duration == 0.0 || gap(b) <= LYRICS_MAX_DRIFT) else {
        return Ok(json!({ "synced": null, "plain": null }));
    };
    let synced = parse_lrc(best["syncedLyrics"].as_str().unwrap_or(""));
    Ok(json!({
        "synced": if synced.is_empty() { Value::Null } else { Value::Array(synced) },
        "plain": best["plainLyrics"].clone(),
        "instrumental": best["instrumental"].as_bool().unwrap_or(false),
        "source": "LRCLIB",
    }))
}

pub async fn skips(http: &reqwest::Client, video_id: &str) -> ApiResult {
    if !VIDEO_ID.is_match(video_id) {
        return Err("That isn't a YouTube video id.".to_string());
    }
    // Ask by hash prefix so SponsorBlock never learns exactly which video is playing.
    let digest = Sha256::digest(video_id.as_bytes());
    let prefix: String = digest.iter().take(2).map(|b| format!("{b:02x}")).collect();
    let response = http
        .get(format!("{SPONSORBLOCK}/{prefix}"))
        .query(&[("categories", SPONSORBLOCK_CATEGORIES)])
        .send()
        .await
        .map_err(|e| format!("SponsorBlock didn't answer ({e})."))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({ "segments": [] }));
    }
    let data: Vec<Value> = response
        .error_for_status()
        .map_err(|e| format!("SponsorBlock didn't answer ({e})."))?
        .json()
        .await
        .map_err(|e| format!("SponsorBlock sent something unexpected ({e})."))?;
    let mut segments: Vec<Value> = data
        .iter()
        .filter(|item| item["videoID"] == video_id)
        .flat_map(|item| item["segments"].as_array().cloned().unwrap_or_default())
        .filter(|s| s["actionType"].as_str().unwrap_or("skip") == "skip")
        .filter_map(|s| {
            let range = s["segment"].as_array()?;
            Some(json!({ "start": range.first()?, "end": range.get(1)?, "category": s["category"] }))
        })
        .collect();
    segments.sort_by(|a, b| a["start"].as_f64().unwrap_or(0.0).total_cmp(&b["start"].as_f64().unwrap_or(0.0)));
    Ok(json!({ "segments": segments }))
}
