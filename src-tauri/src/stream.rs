//! The app's own audio server. Players (the Android ExoPlayer, the desktop page's `<audio>`) read
//! each song from `http://127.0.0.1:<port>/<secret>/<video id>`; this module answers by fetching
//! the matching byte ranges of the best audio stream from YouTube, with the headers it expects.
//!
//! Fetching in slices avoids the slow-down YouTube applies to one long download, and an expired
//! link is replaced here, so a player never has to know about it.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::music::StreamInfo;

/// Largest piece asked of YouTube at once.
const CHUNK_BYTES: u64 = 1 << 20;
const MAX_HEAD_BYTES: usize = 16 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const VIDEO_ID_LEN: usize = 11;

/// Why a slice couldn't be fetched.
#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The link expired or was refused: ask YouTube for a fresh one.
    Expired,
    Failed,
}

/// Where the bytes come from: [`crate::music::Music`] in the app, a stand-in in tests.
pub trait Source: Send + Sync + 'static {
    fn info(&self, id: &str, fresh: bool) -> impl Future<Output = Result<StreamInfo, String>> + Send;
    fn fetch(&self, info: &StreamInfo, start: u64, end: u64) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send;
}

/// The byte range a request asks for.
#[derive(Debug, PartialEq, Eq)]
pub struct Slice {
    pub start: u64,
    pub end: u64,
}

/// Reads `Range: bytes=start-end` (either end may be missing) against a file of `size` bytes.
/// `Ok(None)` means no range was asked for; `Err` means it can't be satisfied.
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<Slice>, ()> {
    let Some(value) = header else { return Ok(None) };
    let spec = value.trim().strip_prefix("bytes=").ok_or(())?;
    if spec.contains(',') || size == 0 {
        return Err(());
    }
    let (from, to) = spec.split_once('-').ok_or(())?;
    let (start, end) = if from.is_empty() {
        // "bytes=-N": the last N bytes.
        let tail: u64 = to.parse().map_err(|_| ())?;
        if tail == 0 {
            return Err(());
        }
        (size.saturating_sub(tail), size - 1)
    } else {
        let start: u64 = from.parse().map_err(|_| ())?;
        let end = if to.is_empty() { size - 1 } else { to.parse::<u64>().map_err(|_| ())?.min(size - 1) };
        (start, end)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok(Some(Slice { start, end }))
}

/// Whether `id` looks like a YouTube video id (11 letters, digits, `-` or `_`).
pub fn is_video_id(id: &str) -> bool {
    id.len() == VIDEO_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn video_id(id: &str) -> Option<&str> {
    is_video_id(id).then_some(id)
}

struct Request {
    method: String,
    path: String,
    range: Option<String>,
    keep_alive: bool,
}

enum Parse {
    Partial,
    Bad,
    Done(Request, usize),
}

fn parse_request(buf: &[u8]) -> Parse {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut req = httparse::Request::new(&mut headers);
    match req.parse(buf) {
        Ok(httparse::Status::Complete(used)) => {
            let header = |name: &str| {
                req.headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case(name))
                    .and_then(|h| std::str::from_utf8(h.value).ok())
            };
            let connection = header("connection").map(str::to_ascii_lowercase);
            let keep_alive = match connection.as_deref() {
                Some(c) if c.contains("close") => false,
                Some(c) if c.contains("keep-alive") => true,
                _ => req.version == Some(1),
            };
            Parse::Done(
                Request {
                    method: req.method.unwrap_or("").to_string(),
                    path: req.path.unwrap_or("").to_string(),
                    range: header("range").map(str::to_string),
                    keep_alive,
                },
                used,
            )
        }
        Ok(httparse::Status::Partial) => Parse::Partial,
        Err(_) => Parse::Bad,
    }
}

async fn read_request<S: AsyncRead + Unpin>(io: &mut S, buf: &mut Vec<u8>) -> Option<Request> {
    loop {
        if !buf.is_empty() {
            match parse_request(buf) {
                Parse::Done(request, used) => {
                    buf.drain(..used);
                    return Some(request);
                }
                Parse::Bad => return None,
                Parse::Partial => {}
            }
        }
        if buf.len() > MAX_HEAD_BYTES {
            return None;
        }
        let mut chunk = [0u8; 2048];
        let n = tokio::time::timeout(IDLE_TIMEOUT, io.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn head(status: &str, extra: &[(&str, String)], keep_alive: bool) -> String {
    let mut out = format!(
        "HTTP/1.1 {status}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
         Cache-Control: no-store\r\n\
         Connection: {}\r\n",
        if keep_alive { "keep-alive" } else { "close" }
    );
    for (name, value) in extra {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    out
}

async fn say<S: AsyncWrite + Unpin>(io: &mut S, status: &str, message: &str, keep_alive: bool) -> bool {
    let mut response = head(
        status,
        &[("Content-Type", "text/plain; charset=utf-8".into()), ("Content-Length", message.len().to_string())],
        keep_alive,
    );
    response.push_str(message);
    io.write_all(response.as_bytes()).await.is_ok() && keep_alive
}

/// Fetches one slice, replacing an expired link once. Returns the bytes and the link that worked.
async fn fetch_slice<R: Source>(source: &R, id: &str, info: &mut StreamInfo, start: u64, end: u64) -> Result<Vec<u8>, FetchError> {
    match source.fetch(info, start, end).await {
        Err(FetchError::Expired) => {
            *info = source.info(id, true).await.map_err(|_| FetchError::Failed)?;
            source.fetch(info, start, end).await
        }
        other => other,
    }
}

/// Answers one request. Returns whether the connection can take another.
async fn respond<S: AsyncWrite + Unpin, R: Source>(io: &mut S, token: &str, source: &R, request: &Request) -> bool {
    let keep = request.keep_alive;
    if request.method == "OPTIONS" {
        let response = head(
            "204 No Content",
            &[("Access-Control-Allow-Headers", "Range".into()), ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".into())],
            keep,
        );
        return io.write_all(response.as_bytes()).await.is_ok() && keep;
    }
    if request.method != "GET" && request.method != "HEAD" {
        return say(io, "405 Method Not Allowed", "GET only.", keep).await;
    }
    let path = request.path.split('?').next().unwrap_or("");
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (Some(given), Some(id)) = (parts.next(), parts.next()) else {
        return say(io, "404 Not Found", "No such song.", keep).await;
    };
    if given != token {
        return say(io, "403 Forbidden", "Not for you.", keep).await;
    }
    let Some(id) = video_id(id) else {
        return say(io, "404 Not Found", "No such song.", keep).await;
    };

    let mut info = match source.info(id, false).await {
        Ok(info) => info,
        Err(message) => return say(io, "502 Bad Gateway", &message, keep).await,
    };
    let (status, slice) = match parse_range(request.range.as_deref(), info.size) {
        Ok(Some(slice)) => ("206 Partial Content", slice),
        Ok(None) => ("200 OK", Slice { start: 0, end: info.size.saturating_sub(1) }),
        Err(()) => {
            let response = head(
                "416 Range Not Satisfiable",
                &[("Content-Range", format!("bytes */{}", info.size)), ("Content-Length", "0".into())],
                keep,
            );
            return io.write_all(response.as_bytes()).await.is_ok() && keep;
        }
    };
    if info.size == 0 {
        return say(io, "502 Bad Gateway", "YouTube didn't say how long this song is.", keep).await;
    }

    // Fetch the first slice before promising anything, so a failure can still be an error status.
    let first_end = slice.end.min(slice.start + CHUNK_BYTES - 1);
    let first = match fetch_slice(source, id, &mut info, slice.start, first_end).await {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => return say(io, "502 Bad Gateway", "YouTube didn't send that part of the song.", keep).await,
    };

    let length = slice.end - slice.start + 1;
    let mut fields = vec![
        ("Content-Type", info.mime.clone()),
        ("Accept-Ranges", "bytes".into()),
        ("Content-Length", length.to_string()),
    ];
    if status.starts_with("206") {
        fields.push(("Content-Range", format!("bytes {}-{}/{}", slice.start, slice.end, info.size)));
    }
    if io.write_all(head(status, &fields, keep).as_bytes()).await.is_err() {
        return false;
    }
    if request.method == "HEAD" {
        return keep;
    }

    let mut next = slice.start;
    let mut bytes = first;
    loop {
        // Never send more than was promised.
        let room = (slice.end + 1 - next) as usize;
        let take = bytes.len().min(room);
        if io.write_all(&bytes[..take]).await.is_err() {
            return false;
        }
        next += take as u64;
        if next > slice.end {
            return io.flush().await.is_ok() && keep;
        }
        let end = slice.end.min(next + CHUNK_BYTES - 1);
        bytes = match fetch_slice(source, id, &mut info, next, end).await {
            Ok(bytes) if !bytes.is_empty() => bytes,
            // The promise was made; closing the connection is how the player learns it broke.
            _ => return false,
        };
    }
}

/// Serves requests on one connection until it closes.
pub async fn serve_connection<S, R>(mut io: S, token: &str, source: &R)
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: Source,
{
    let mut buf = Vec::with_capacity(2048);
    while let Some(request) = read_request(&mut io, &mut buf).await {
        if !respond(&mut io, token, source, &request).await {
            return;
        }
    }
}

/// Accepts connections forever, one task each.
pub async fn run<R: Source>(listener: TcpListener, token: String, source: Arc<R>) {
    let token: Arc<str> = token.into();
    loop {
        let Ok((socket, _)) = listener.accept().await else { continue };
        let (token, source) = (token.clone(), source.clone());
        tokio::spawn(async move {
            serve_connection(socket, &token, &*source).await;
        });
    }
}

/// Binds a free port on this device only. Returns the listener and its port.
pub async fn bind() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::duplex;

    /// A song of `size` bytes where byte n is `n % 251`, and a counter of what was asked of "YouTube".
    struct Fake {
        size: u64,
        expire_first_fetch: Mutex<bool>,
        fetches: Mutex<Vec<(u64, u64)>>,
        infos: Mutex<u32>,
    }

    impl Fake {
        fn new(size: u64, expire_first_fetch: bool) -> Self {
            Self { size, expire_first_fetch: Mutex::new(expire_first_fetch), fetches: Mutex::new(vec![]), infos: Mutex::new(0) }
        }
    }

    impl Source for Fake {
        async fn info(&self, _id: &str, _fresh: bool) -> Result<StreamInfo, String> {
            *self.infos.lock().unwrap() += 1;
            Ok(StreamInfo {
                url: "fake".into(),
                mime: "audio/webm".into(),
                codec: "opus".into(),
                size: self.size,
                bitrate: 160_000,
                user_agent: "test".into(),
                valid_until: i64::MAX,
                loudness_db: Some(2.0),
            })
        }

        async fn fetch(&self, _info: &StreamInfo, start: u64, end: u64) -> Result<Vec<u8>, FetchError> {
            if std::mem::replace(&mut *self.expire_first_fetch.lock().unwrap(), false) {
                return Err(FetchError::Expired);
            }
            self.fetches.lock().unwrap().push((start, end));
            Ok((start..=end).map(|n| (n % 251) as u8).collect())
        }
    }

    /// Sends one request and returns the status line, the headers and the body.
    async fn ask(fake: Arc<Fake>, request: &str) -> (String, String, Vec<u8>) {
        let (mut client, server) = duplex(64 * 1024);
        let task = tokio::spawn(async move { serve_connection(server, "secret", &*fake).await });
        client.write_all(request.as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        task.await.unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head");
        let text = String::from_utf8_lossy(&raw[..split]).to_string();
        let (status, headers) = text.split_once("\r\n").unwrap_or((&text, ""));
        (status.to_string(), headers.to_string(), raw[split + 4..].to_vec())
    }

    fn get(path: &str, range: Option<&str>) -> String {
        let range = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        format!("GET {path} HTTP/1.1\r\nHost: x\r\n{range}Connection: close\r\n\r\n")
    }

    #[test]
    fn no_range_header_means_no_range() {
        assert_eq!(parse_range(None, 100), Ok(None));
    }

    #[test]
    fn ranges_are_clamped_to_the_file() {
        assert_eq!(parse_range(Some("bytes=0-"), 1000), Ok(Some(Slice { start: 0, end: 999 })));
        assert_eq!(parse_range(Some("bytes=10-19"), 1000), Ok(Some(Slice { start: 10, end: 19 })));
        assert_eq!(parse_range(Some("bytes=990-5000"), 1000), Ok(Some(Slice { start: 990, end: 999 })));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Ok(Some(Slice { start: 900, end: 999 })));
    }

    #[test]
    fn bad_ranges_are_refused() {
        for bad in ["bytes=2000-", "bytes=20-10", "bytes=0-1,5-6", "items=0-1", "bytes=-0", "bytes=x-"] {
            assert_eq!(parse_range(Some(bad), 1000), Err(()), "{bad}");
        }
        assert_eq!(parse_range(Some("bytes=0-"), 0), Err(()));
    }

    #[test]
    fn only_video_ids_are_served() {
        assert_eq!(video_id("dQw4w9WgXcQ"), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("../etc/pass"), None);
        assert_eq!(video_id("short"), None);
    }

    #[tokio::test]
    async fn a_ranged_request_gets_exactly_those_bytes() {
        let fake = Arc::new(Fake::new(10_000, false));
        let (status, headers, body) = ask(fake, &get("/secret/dQw4w9WgXcQ", Some("bytes=100-199"))).await;
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert!(headers.contains("Content-Range: bytes 100-199/10000"), "{headers}");
        assert!(headers.contains("Content-Length: 100"), "{headers}");
        assert!(headers.contains("Access-Control-Allow-Origin: *"));
        assert_eq!(body, (100u64..200).map(|n| (n % 251) as u8).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn an_open_ended_range_streams_the_rest_in_slices() {
        let size = 2 * CHUNK_BYTES + 12_345;
        let fake = Arc::new(Fake::new(size, false));
        let (status, headers, body) = ask(fake.clone(), &get("/secret/dQw4w9WgXcQ", Some("bytes=5-"))).await;
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert!(headers.contains(&format!("Content-Range: bytes 5-{}/{size}", size - 1)), "{headers}");
        assert_eq!(body.len() as u64, size - 5);
        assert!(body.iter().enumerate().all(|(i, b)| *b == ((i as u64 + 5) % 251) as u8));
        // Three slices, none larger than the limit.
        let fetches = fake.fetches.lock().unwrap().clone();
        assert_eq!(fetches.len(), 3, "{fetches:?}");
        assert!(fetches.iter().all(|(a, b)| b - a < CHUNK_BYTES));
    }

    #[tokio::test]
    async fn no_range_gets_the_whole_song() {
        let fake = Arc::new(Fake::new(3000, false));
        let (status, headers, body) = ask(fake, &get("/secret/dQw4w9WgXcQ", None)).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains("Content-Length: 3000"));
        assert_eq!(body.len(), 3000);
    }

    #[tokio::test]
    async fn an_expired_link_is_replaced_without_the_player_noticing() {
        let fake = Arc::new(Fake::new(5000, true));
        let (status, _, body) = ask(fake.clone(), &get("/secret/dQw4w9WgXcQ", Some("bytes=0-"))).await;
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert_eq!(body.len(), 5000);
        assert_eq!(*fake.infos.lock().unwrap(), 2, "one fresh link was asked for");
    }

    #[tokio::test]
    async fn wrong_secret_and_bad_paths_are_refused() {
        let fake = Arc::new(Fake::new(100, false));
        assert_eq!(ask(fake.clone(), &get("/wrong/dQw4w9WgXcQ", None)).await.0, "HTTP/1.1 403 Forbidden");
        assert_eq!(ask(fake.clone(), &get("/secret/short", None)).await.0, "HTTP/1.1 404 Not Found");
        assert_eq!(ask(fake.clone(), &get("/secret", None)).await.0, "HTTP/1.1 404 Not Found");
        assert_eq!(ask(fake, &get("/secret/dQw4w9WgXcQ", Some("bytes=500-"))).await.0, "HTTP/1.1 416 Range Not Satisfiable");
    }

    #[tokio::test]
    async fn head_and_preflight_have_no_body() {
        let fake = Arc::new(Fake::new(100, false));
        let head_request = "HEAD /secret/dQw4w9WgXcQ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        let (status, headers, body) = ask(fake.clone(), head_request).await;
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(headers.contains("Content-Length: 100"));
        assert!(body.is_empty());
        let options = "OPTIONS /secret/dQw4w9WgXcQ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        let (status, headers, _) = ask(fake, options).await;
        assert_eq!(status, "HTTP/1.1 204 No Content");
        assert!(headers.contains("Access-Control-Allow-Headers: Range"));
    }

    #[tokio::test]
    async fn two_requests_can_share_a_connection() {
        let fake = Arc::new(Fake::new(1000, false));
        let (mut client, server) = duplex(64 * 1024);
        let shared = fake.clone();
        let task = tokio::spawn(async move { serve_connection(server, "secret", &*shared).await });
        let one = "GET /secret/dQw4w9WgXcQ HTTP/1.1\r\nHost: x\r\nRange: bytes=0-9\r\n\r\n";
        let two = "GET /secret/dQw4w9WgXcQ HTTP/1.1\r\nHost: x\r\nRange: bytes=10-19\r\nConnection: close\r\n\r\n";
        client.write_all(one.as_bytes()).await.unwrap();
        client.write_all(two.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        task.await.unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert_eq!(text.matches("206 Partial Content").count(), 2, "{text}");
    }
}
