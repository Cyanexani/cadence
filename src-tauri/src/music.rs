//! The music API inside the Android app. Answers the same /api/* calls as the Python server
//! (core.py) with the same JSON shapes, using rustypipe for YouTube Music.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use rand::seq::SliceRandom;
use regex::Regex;
use rustypipe::client::{RustyPipe, RustyPipeQuery};
use rustypipe::model::{
    AlbumItem, AlbumType, ArtistId, ArtistItem, MusicPlaylistItem, Thumbnail, TrackItem, TrackType,
};
use rustypipe::param::{Country, Language, StreamFilter};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::extras;

const CACHE_TTL: Duration = Duration::from_secs(600);
const CACHE_MAX_ENTRIES: usize = 1000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const ART_SIZE: u32 = 544;
const ARTIST_ART_SIZE: u32 = 900;
const HOME_TRACKS: usize = 20;
const MOOD_MIX_PLAYLISTS: usize = 4;
const MOOD_MIX_SIZE: usize = 60;
const YTM_ORIGIN: &str = "https://music.youtube.com";
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const VIDEO_ID_LEN: usize = 11;
// Liked Music and Episodes for Later have their own places in the app.
const HIDDEN_ACCOUNT_PLAYLISTS: [&str; 2] = ["LM", "SE"];
const CACHEABLE: [&str; 10] = [
    "/api/home", "/api/search", "/api/suggest", "/api/album", "/api/playlist", "/api/artist",
    "/api/moods", "/api/mood", "/api/lyrics", "/api/skips",
];

static SIZE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"=w\d+-h\d+").expect("valid regex"));
static SQUARE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"=s\d+$").expect("valid regex"));

pub type ApiResult = Result<Value, String>;

pub struct Music {
    rp: RustyPipe,
    pub http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
    /// Google session cookies from in-app sign-in; also kept by rustypipe in its own cache.
    cookie: Mutex<Option<String>>,
    cookie_file: PathBuf,
}

fn upstream(err: impl std::fmt::Display) -> String {
    format!("YouTube Music didn't answer ({err}).")
}

pub fn need<'a>(params: &'a HashMap<String, String>, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing '{key}'."))
}

impl Music {
    pub fn new(storage: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&storage).map_err(|e| format!("Can't create the cache folder: {e}"))?;
        let cookie_file = storage.join("google-cookie.txt");
        let cookie = std::fs::read_to_string(&cookie_file).ok().filter(|c| !c.trim().is_empty());
        let rp = RustyPipe::builder()
            .storage_dir(storage)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("Can't start the YouTube Music client: {e}"))?;
        let http = reqwest::Client::builder()
            .user_agent(extras::USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("Can't start the HTTP client: {e}"))?;
        Ok(Self { rp, http, cache: Mutex::new(HashMap::new()), cookie: Mutex::new(cookie), cookie_file })
    }

    fn query(&self, language: Option<&str>, region: Option<&str>) -> RustyPipeQuery {
        let mut query = self.rp.query();
        if let Some(lang) = language.filter(|l| !l.is_empty()).and_then(|l| Language::from_str(&l.replace('_', "-")).ok()) {
            query = query.lang(lang);
        }
        if let Some(country) = region.and_then(parse_country) {
            query = query.country(country);
        }
        query
    }

    pub async fn dispatch(&self, path: &str, mut params: HashMap<String, String>) -> ApiResult {
        let language = params.remove("hl");
        let region = params.remove("gl");
        let key = CACHEABLE.contains(&path).then(|| {
            let mut pairs: Vec<_> = params.iter().map(|(k, v)| format!("{k}={}", v.to_lowercase())).collect();
            pairs.sort();
            format!("{path}|{language:?}|{region:?}|{}", pairs.join("&"))
        });
        if let Some(hit) = key.as_ref().and_then(|k| self.cached(k)) {
            return Ok(hit);
        }
        let q = self.query(language.as_deref(), region.as_deref());
        let value = match path {
            "/api/home" => home(&q, region.as_deref()).await,
            "/api/search" => search(&q, need(&params, "q")?, params.get("type").map_or("songs", String::as_str)).await,
            "/api/suggest" => suggest(&q, need(&params, "q")?).await,
            "/api/album" => album(&q, need(&params, "id")?).await,
            "/api/playlist" => playlist(&q, need(&params, "id")?).await,
            "/api/artist" => artist(&q, need(&params, "id")?).await,
            "/api/radio" => radio(&q, need(&params, "id")?).await,
            "/api/stream" => audio_stream(&q, need(&params, "id")?).await,
            "/api/alternate" => alternate(&q, need(&params, "q")?, params.get("exclude").map_or("", String::as_str)).await,
            "/api/moods" => moods(&q).await,
            "/api/mood" => mood(&q, need(&params, "params")?).await,
            "/api/mood-mix" => mood_mix(&q, need(&params, "params")?).await,
            "/api/lyrics" => extras::lyrics(&self.http, &params).await,
            "/api/skips" => extras::skips(&self.http, need(&params, "id")?).await,
            "/api/podcast" => Err("Podcasts aren't available in the Android app yet.".to_string()),
            _ => Err("No such endpoint.".to_string()),
        }?;
        if let Some(k) = key {
            self.remember(k, value.clone());
        }
        Ok(value)
    }

    // ------------------------------------------------------------ Google account (in-app sign-in)

    fn session_cookie(&self) -> Result<String, String> {
        self.cookie.lock().ok().and_then(|c| c.clone()).ok_or_else(|| "Sign in with Google first.".to_string())
    }

    /// Keep the cookies from the in-app sign-in page. rustypipe checks them against youtube.com first.
    pub async fn sign_in_with_cookie(&self, cookie: String) -> ApiResult {
        self.rp
            .user_auth_set_cookie(cookie.clone())
            .await
            .map_err(|e| format!("YouTube didn't accept the sign-in ({e}). Try again."))?;
        std::fs::write(&self.cookie_file, &cookie).map_err(|e| format!("Couldn't save the sign-in: {e}"))?;
        if let Ok(mut slot) = self.cookie.lock() {
            *slot = Some(cookie);
        }
        // The name and photo are a nicety; a signed-in session without them still works.
        Ok(self.account_info().await.unwrap_or_else(|_| json!({ "name": null, "handle": null, "photo": null })))
    }

    pub async fn sign_out(&self) {
        let _ = self.rp.user_auth_remove_cookie().await; // errors only when nothing was stored
        let _ = std::fs::remove_file(&self.cookie_file);
        if let Ok(mut slot) = self.cookie.lock() {
            *slot = None;
        }
    }

    /// Calls that need the signed-in account, mirroring core.py's account routes.
    pub async fn account_dispatch(&self, path: &str, body: Option<Value>) -> ApiResult {
        match path {
            "/api/auth/config" => Ok(json!({ "configured": true, "mode": "app" })),
            "/api/account" => self.account_info().await,
            "/api/liked" => {
                self.session_cookie()?;
                let liked = self.rp.query().music_liked_tracks().await.map_err(upstream)?;
                Ok(json!({ "items": tracks(&liked.tracks.items) }))
            }
            "/api/account-playlists" => {
                self.session_cookie()?;
                let saved = self.rp.query().music_saved_playlists().await.map_err(upstream)?;
                let cards: Vec<Value> =
                    saved.items.iter().filter(|p| !HIDDEN_ACCOUNT_PLAYLISTS.contains(&p.id.as_str())).map(playlist_card).collect();
                Ok(json!({ "items": cards }))
            }
            "/api/rate" => {
                let body = body.unwrap_or_default();
                let id = body["id"].as_str().unwrap_or_default();
                let endpoint = match body["rating"].as_str() {
                    Some("LIKE") => "like/like",
                    Some("DISLIKE") => "like/dislike",
                    Some("INDIFFERENT") => "like/removelike",
                    _ => return Err("Rating needs LIKE, DISLIKE or INDIFFERENT.".to_string()),
                };
                if id.len() != VIDEO_ID_LEN {
                    return Err("That isn't a YouTube video id.".to_string());
                }
                self.ytm_post(endpoint, json!({ "target": { "videoId": id } })).await?;
                Ok(json!({ "status": "ok" }))
            }
            "/api/history" => Err("Adding plays to your YouTube Music history isn't in the Android app yet.".to_string()),
            _ => Err("In the Android app, sign in with the button in Settings.".to_string()),
        }
    }

    async fn account_info(&self) -> ApiResult {
        let menu = self.ytm_post("account/account_menu", json!({})).await?;
        let header = &menu["actions"][0]["openPopupAction"]["popup"]["multiPageMenuRenderer"]["header"]
            ["activeAccountHeaderRenderer"];
        let photo = header["accountPhoto"]["thumbnails"].as_array().and_then(|t| t.last()).map(|t| t["url"].clone());
        Ok(json!({
            "name": header["accountName"]["runs"][0]["text"],
            "handle": header["channelHandle"]["runs"][0]["text"],
            "photo": photo.unwrap_or(Value::Null),
        }))
    }

    /// A signed request to YouTube Music's web API, authorised the way the website does it.
    async fn ytm_post(&self, endpoint: &str, extra: Value) -> ApiResult {
        let cookie = self.session_cookie()?;
        let sapisid = cookie_value(&cookie, "SAPISID")
            .or_else(|| cookie_value(&cookie, "__Secure-3PAPISID"))
            .ok_or("The saved sign-in is incomplete. Sign out and sign in again.")?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
        let digest = Sha1::digest(format!("{now} {sapisid} {YTM_ORIGIN}").as_bytes());
        let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let mut payload = json!({ "context": { "client": {
            "clientName": "WEB_REMIX", "clientVersion": web_remix_version(now), "hl": "en",
        } } });
        if let (Some(target), Some(fields)) = (payload.as_object_mut(), extra.as_object()) {
            target.extend(fields.clone());
        }
        let response = self
            .http
            .post(format!("{YTM_ORIGIN}/youtubei/v1/{endpoint}?prettyPrint=false"))
            .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
            .header(reqwest::header::COOKIE, cookie)
            .header(reqwest::header::AUTHORIZATION, format!("SAPISIDHASH {now}_{hash}"))
            .header(reqwest::header::ORIGIN, YTM_ORIGIN)
            .header("X-Origin", YTM_ORIGIN)
            .header("X-Goog-AuthUser", "0")
            .json(&payload)
            .send()
            .await
            .map_err(upstream)?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("YouTube Music didn't accept your sign-in. Sign out and sign in again.".to_string());
        }
        response.error_for_status().map_err(upstream)?.json().await.map_err(upstream)
    }

    fn cached(&self, key: &str) -> Option<Value> {
        let cache = self.cache.lock().ok()?;
        cache.get(key).filter(|(at, _)| at.elapsed() < CACHE_TTL).map(|(_, v)| v.clone())
    }

    fn remember(&self, key: String, value: Value) {
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(key, (Instant::now(), value));
        }
    }
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie.split(';').find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

/// YouTube Music's web client version is "1.YYYYMMDD.01.00"; today's date is always accepted.
fn web_remix_version(unix_seconds: u64) -> String {
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let days = (unix_seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("1.{year:04}{month:02}{day:02}.01.00")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_remix_version_uses_the_calendar_date() {
        assert_eq!(web_remix_version(1_763_600_000), "1.20251120.01.00");
        assert_eq!(web_remix_version(1_709_164_800), "1.20240229.01.00"); // leap day
        assert_eq!(web_remix_version(0), "1.19700101.01.00");
    }

    #[test]
    fn cookie_value_finds_exact_names() {
        let cookie = "HSID=a; __Secure-3PAPISID=b; SAPISID=c=d; SID=e";
        assert_eq!(cookie_value(cookie, "SAPISID").as_deref(), Some("c=d"));
        assert_eq!(cookie_value(cookie, "__Secure-3PAPISID").as_deref(), Some("b"));
        assert_eq!(cookie_value(cookie, "APISID"), None);
    }

    #[tokio::test]
    async fn account_calls_need_a_sign_in() {
        let music = Music::new(std::env::temp_dir().join("cadence-unit-signed-out")).expect("client starts");
        music.sign_out().await;
        let config = music.account_dispatch("/api/auth/config", None).await.expect("config answers");
        assert_eq!(config["mode"], "app");
        for path in ["/api/account", "/api/liked", "/api/account-playlists"] {
            assert_eq!(music.account_dispatch(path, None).await.unwrap_err(), "Sign in with Google first.");
        }
        let rate = music.account_dispatch("/api/rate", Some(json!({ "id": "dQw4w9WgXcQ", "rating": "LIKE" }))).await;
        assert_eq!(rate.unwrap_err(), "Sign in with Google first.");
    }
}

fn parse_country(code: &str) -> Option<Country> {
    if code.trim().is_empty() {
        return None;
    }
    serde_json::from_value(Value::String(code.trim().to_uppercase())).ok()
}

// ---------------------------------------------------------------- shaping

fn art(thumbs: &[Thumbnail], size: u32) -> Option<String> {
    let url = &thumbs.iter().max_by_key(|t| t.width)?.url;
    // Google image URLs carry their size in the suffix, so ask for a sharper copy.
    if url.contains("googleusercontent.com") || url.contains("ggpht.com") {
        let sized = SIZE_SUFFIX.replace(url, format!("=w{size}-h{size}").as_str());
        return Some(SQUARE_SUFFIX.replace(&sized, format!("=s{size}").as_str()).into_owned());
    }
    Some(url.clone())
}

fn names(artists: &[ArtistId]) -> String {
    artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

fn compact(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{:.1}K", n as f64 / 1e3).replace(".0K", "K"),
        1_000_000..=999_999_999 => format!("{:.2}M", n as f64 / 1e6).replace(".00M", "M"),
        _ => format!("{:.2}B", n as f64 / 1e9).replace(".00B", "B"),
    }
}

fn album_label(kind: AlbumType) -> &'static str {
    match kind {
        AlbumType::Album => "Album",
        AlbumType::Ep => "EP",
        AlbumType::Single => "Single",
        AlbumType::Audiobook => "Audiobook",
        AlbumType::Show => "Show",
        _ => "Album",
    }
}

fn track(t: &TrackItem, album_fallback: Option<(&str, &str)>, art_fallback: Option<&str>) -> Value {
    json!({
        "id": t.id,
        "title": t.name,
        "artist": names(&t.artists),
        "artistId": t.artist_id.clone().or_else(|| t.artists.iter().find_map(|a| a.id.clone())),
        "album": t.album.as_ref().map(|a| a.name.clone()).or_else(|| album_fallback.map(|(n, _)| n.to_string())),
        "albumId": t.album.as_ref().map(|a| a.id.clone()).or_else(|| album_fallback.map(|(_, id)| id.to_string())),
        "duration": t.duration,
        "art": art(&t.cover, ART_SIZE).or_else(|| art_fallback.map(str::to_string)),
        "video": t.track_type == TrackType::Video,
        "explicit": false,
    })
}

fn tracks(items: &[TrackItem]) -> Vec<Value> {
    items.iter().map(|t| track(t, None, None)).collect()
}

fn album_card(a: &AlbumItem) -> Value {
    let year = a.year.map(|y| y.to_string()).unwrap_or_default();
    let subtitle = [album_label(a.album_type), &names(&a.artists), &year]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    json!({ "kind": "album", "id": a.id, "title": a.name, "subtitle": subtitle, "art": art(&a.cover, ART_SIZE) })
}

fn artist_card(a: &ArtistItem) -> Value {
    let subtitle = a.subscriber_count.map_or_else(|| "Artist".to_string(), |n| format!("{} subscribers", compact(n)));
    json!({ "kind": "artist", "id": a.id, "title": a.name, "subtitle": subtitle, "art": art(&a.avatar, ART_SIZE) })
}

fn playlist_card(p: &MusicPlaylistItem) -> Value {
    let owner = p.channel.as_ref().map_or("YouTube Music", |c| c.name.as_str());
    let subtitle = match p.track_count {
        Some(n) => format!("{owner} · {n} songs"),
        None => owner.to_string(),
    };
    json!({ "kind": "playlist", "id": p.id, "title": p.name, "subtitle": subtitle, "art": art(&p.thumbnail, ART_SIZE) })
}

fn total_length(items: &[TrackItem]) -> Option<String> {
    let seconds: u32 = items.iter().filter_map(|t| t.duration).sum();
    if seconds == 0 {
        return None;
    }
    let (h, m) = (seconds / 3600, (seconds % 3600 + 30) / 60);
    Some(if h > 0 { format!("{h} hr {m} min") } else { format!("{m} min") })
}

fn shelf(title: &str, kind: &str, items: Vec<Value>) -> Option<Value> {
    (!items.is_empty()).then(|| json!({ "title": title, "kind": kind, "items": items }))
}

// ---------------------------------------------------------------- endpoints

// rustypipe has no personalized home feed, so Home is built from charts and new releases.
async fn home(q: &RustyPipeQuery, region: Option<&str>) -> ApiResult {
    let (charts, albums, videos) =
        futures::join!(q.music_charts(region.and_then(parse_country)), q.music_new_albums(), q.music_new_videos());
    let mut shelves = Vec::new();
    if let Ok(c) = &charts {
        // YouTube Music now often ships charts as playlists rather than track lists.
        let mut top = c.top_tracks.clone();
        if top.is_empty() {
            let named_top = c.playlists.iter().find(|p| {
                let name = p.name.to_lowercase();
                name.contains("top") && name.contains("song")
            });
            let id = c.top_playlist_id.clone().or_else(|| named_top.or(c.playlists.first()).map(|p| p.id.clone()));
            if let Some(id) = id {
                top = q.music_playlist(&id).await.map(|p| p.tracks.items).unwrap_or_default();
            }
        }
        let mut trending = c.trending_tracks.clone();
        if trending.is_empty() {
            if let Some(id) = &c.trending_playlist_id {
                trending = q.music_playlist(id).await.map(|p| p.tracks.items).unwrap_or_default();
            }
        }
        shelves.extend(shelf("Top songs", "tracks", tracks(&top[..top.len().min(HOME_TRACKS)])));
        shelves.extend(shelf("Trending now", "tracks", tracks(&trending[..trending.len().min(HOME_TRACKS)])));
    }
    if let Ok(a) = &albums {
        shelves.extend(shelf("New releases", "cards", a.iter().map(album_card).collect()));
    }
    if let Ok(c) = &charts {
        shelves.extend(shelf("Top artists", "cards", c.artists.iter().map(artist_card).collect()));
        shelves.extend(shelf("Chart playlists", "cards", c.playlists.iter().map(playlist_card).collect()));
    }
    if let Ok(v) = &videos {
        shelves.extend(shelf("New music videos", "tracks", tracks(&v[..v.len().min(HOME_TRACKS)])));
    }
    if shelves.is_empty() {
        return Err(upstream(charts.err().map_or_else(|| "empty home".to_string(), |e| e.to_string())));
    }
    Ok(json!({ "shelves": shelves }))
}

async fn search(q: &RustyPipeQuery, query: &str, kind: &str) -> ApiResult {
    let items: Vec<Value> = match kind {
        "songs" => tracks(&q.music_search_tracks(query).await.map_err(upstream)?.items.items),
        "videos" => tracks(&q.music_search_videos(query).await.map_err(upstream)?.items.items),
        "albums" => q.music_search_albums(query).await.map_err(upstream)?.items.items.iter().map(album_card).collect(),
        "artists" => q.music_search_artists(query).await.map_err(upstream)?.items.items.iter().map(artist_card).collect(),
        "playlists" => {
            let (featured, community) =
                futures::join!(q.music_search_playlists(query, false), q.music_search_playlists(query, true));
            let mut found: Vec<Value> = Vec::new();
            for result in [featured, community].into_iter().flatten() {
                found.extend(result.items.items.iter().map(playlist_card));
            }
            found
        }
        "podcasts" => return Err("Podcasts aren't available in the Android app yet.".to_string()),
        other => return Err(format!("Unknown search type '{other}'.")),
    };
    Ok(json!({ "items": items }))
}

async fn suggest(q: &RustyPipeQuery, query: &str) -> ApiResult {
    let s = q.music_search_suggestion(query).await.map_err(upstream)?;
    Ok(json!({ "items": s.terms.into_iter().take(8).collect::<Vec<_>>() }))
}

async fn album(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let a = q.music_album(id).await.map_err(upstream)?;
    let cover = art(&a.cover, ART_SIZE);
    let items: Vec<Value> = a.tracks.iter().map(|t| track(t, Some((&a.name, &a.id)), cover.as_deref())).collect();
    let mut meta: Vec<String> = a.year.map(|y| y.to_string()).into_iter().collect();
    meta.push(format!("{} songs", items.len()));
    meta.extend(total_length(&a.tracks));
    Ok(json!({
        "kind": "album", "id": a.id, "label": album_label(a.album_type), "title": a.name,
        "subtitle": names(&a.artists),
        "artistId": a.artist_id.clone().or_else(|| a.artists.iter().find_map(|x| x.id.clone())),
        "meta": meta, "art": cover, "tracks": items,
    }))
}

async fn playlist(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let p = q.music_playlist(id).await.map_err(upstream)?;
    let items = tracks(&p.tracks.items);
    let mut meta = vec![format!("{} songs", p.track_count.unwrap_or(items.len() as u64))];
    meta.extend(total_length(&p.tracks.items));
    Ok(json!({
        "kind": "playlist", "id": p.id, "label": "Playlist", "title": p.name,
        "subtitle": p.channel.as_ref().map_or("YouTube Music".to_string(), |c| c.name.clone()),
        "meta": meta, "art": art(&p.thumbnail, ART_SIZE), "tracks": items,
    }))
}

async fn artist(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let a = q.music_artist(id, false).await.map_err(upstream)?;
    let (albums, singles): (Vec<&AlbumItem>, Vec<&AlbumItem>) =
        a.albums.iter().partition(|x| matches!(x.album_type, AlbumType::Album | AlbumType::Audiobook | AlbumType::Show));
    Ok(json!({
        "kind": "artist", "id": a.id, "title": a.name,
        "art": art(&a.header_image, ARTIST_ART_SIZE),
        "meta": a.subscriber_count.map(|n| vec![format!("{} subscribers", compact(n))]).unwrap_or_default(),
        "description": a.description.clone().unwrap_or_default(),
        "songs": tracks(&a.tracks),
        "albums": albums.into_iter().map(album_card).collect::<Vec<_>>(),
        "singles": singles.into_iter().map(album_card).collect::<Vec<_>>(),
        "videos": Vec::<Value>::new(),
        "related": a.similar_artists.iter().map(artist_card).collect::<Vec<_>>(),
    }))
}

async fn radio(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let r = q.music_radio_track(id).await.map_err(upstream)?;
    let items: Vec<Value> = r.items.iter().filter(|t| t.id != id).map(|t| track(t, None, None)).collect();
    Ok(json!({ "items": items }))
}

/// The top-bitrate audio stream for the native player. The URL expires (`validUntil`, unix
/// seconds) and the player must send `userAgent` with it, since YouTube checks the client.
async fn audio_stream(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let player = q.player(id).await.map_err(upstream)?;
    let stream = player
        .select_audio_stream(&StreamFilter::new())
        .ok_or_else(|| "YouTube didn't offer an audio stream for this song.".to_string())?;
    Ok(json!({
        "url": stream.url,
        "mime": stream.mime,
        "bitrate": stream.bitrate,
        "userAgent": q.user_agent(player.client_type).into_owned(),
        "validUntil": player.valid_until.unix_timestamp(),
    }))
}

// Some uploads block embedding; another upload of the same song usually plays.
async fn alternate(q: &RustyPipeQuery, query: &str, exclude: &str) -> ApiResult {
    let skip: HashSet<&str> = exclude.split(',').collect();
    if let Ok(found) = q.music_search_tracks(query).await {
        if let Some(t) = found.items.items.iter().find(|t| !skip.contains(t.id.as_str())) {
            return Ok(json!({ "track": track(t, None, None) }));
        }
    }
    let videos = q.music_search_videos(query).await.map_err(upstream)?;
    let pick = videos.items.items.iter().find(|t| !skip.contains(t.id.as_str())).map(|t| track(t, None, None));
    Ok(json!({ "track": pick }))
}

async fn moods(q: &RustyPipeQuery) -> ApiResult {
    let genres = q.music_genres().await.map_err(upstream)?;
    let pick = |mood: bool| -> Vec<Value> {
        genres.iter().filter(|g| g.is_mood == mood).map(|g| json!({ "title": g.name, "params": g.id })).collect()
    };
    Ok(json!({ "groups": [
        { "title": "Moods & moments", "items": pick(true) },
        { "title": "Genres", "items": pick(false) },
    ] }))
}

async fn mood_playlists(q: &RustyPipeQuery, id: &str) -> Result<Vec<MusicPlaylistItem>, String> {
    let genre = q.music_genre(id).await.map_err(upstream)?;
    let mut seen = HashSet::new();
    Ok(genre.sections.into_iter().flat_map(|s| s.playlists).filter(|p| seen.insert(p.id.clone())).collect())
}

async fn mood(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let playlists = mood_playlists(q, id).await?;
    Ok(json!({ "items": playlists.iter().map(playlist_card).collect::<Vec<_>>() }))
}

async fn mood_mix(q: &RustyPipeQuery, id: &str) -> ApiResult {
    let playlists = mood_playlists(q, id).await?;
    let fetches = playlists.iter().take(MOOD_MIX_PLAYLISTS).map(|p| q.music_playlist(&p.id));
    let mut seen = HashSet::new();
    let mut mixed: Vec<Value> = join_all(fetches)
        .await
        .into_iter()
        .flatten() // one failing playlist shouldn't sink the whole mix
        .flat_map(|p| p.tracks.items)
        .filter(|t| seen.insert(t.id.clone()))
        .map(|t| track(&t, None, None))
        .collect();
    mixed.shuffle(&mut rand::thread_rng());
    mixed.truncate(MOOD_MIX_SIZE);
    Ok(json!({ "items": mixed }))
}
