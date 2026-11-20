"""Cadence's stateless music API, shared by the local server and the Vercel function.

Search and browsing come from YouTube Music through ytmusicapi (no sign-in), lyrics from
LRCLIB, and skip segments from SponsorBlock. Nothing here stores user data: likes, history,
playlists and stats live on the listener's device.
"""

import hashlib
import json
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from ytmusicapi import OAuthCredentials, YTMusic
from ytmusicapi.auth.oauth.exceptions import BadOAuthClient, UnauthorizedOAuthClient

CACHE_TTL_SECONDS = 600
CACHE_MAX_ENTRIES = 2000
HTTP_TIMEOUT_SECONDS = 10
SEARCH_LIMIT = 40
PLAYLIST_SEARCH_LIMIT = 20
PLAYLIST_TRACK_LIMIT = 300
RADIO_LIMIT = 40
HOME_SHELF_LIMIT = 10
SUGGESTION_LIMIT = 8
ART_SIZE = 544
ARTIST_ART_SIZE = 900
MOOD_MIX_PLAYLISTS = 4
MOOD_MIX_PLAYLIST_TRACKS = 50
MOOD_MIX_SIZE = 60
LYRICS_DURATION_TOLERANCE = 4
LYRICS_MAX_DRIFT = LYRICS_DURATION_TOLERANCE * 4
DEFAULT_LANGUAGE = "en"
USER_AGENT = "Cadence/0.1 (music player)"
LRCLIB_SEARCH = "https://lrclib.net/api/search"
SPONSORBLOCK_URL = "https://sponsor.ajay.app/api/skipSegments/{prefix}?categories={categories}"
SPONSORBLOCK_CATEGORIES = ["music_offtopic", "sponsor", "selfpromo", "interaction"]

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CODE_RE = re.compile(r"^[A-Za-z_-]{0,8}$")
VIEWS_RE = re.compile(r"^[\d.,]+\s?[KMB]?\s(views|plays|subscribers)$", re.IGNORECASE)
LRC_LINE_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")
TITLE_NOISE_RE = re.compile(
    r"\s*[\(\[][^)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|hd|4k|mv)[^)\]]*[\)\]]", re.IGNORECASE
)
FEAT_RE = re.compile(r"\s+[\(\[]?(ft\.?|feat\.?|featuring)\s.*$", re.IGNORECASE)

OAUTH_CLIENT_FILE = Path(__file__).resolve().with_name("oauth-client.json")
OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube"
OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
# The app refreshes access tokens itself; the server treats each one as valid for this long.
ASSUMED_TOKEN_LIFETIME = 3000
LIKED_SYNC_LIMIT = 1000
ACCOUNT_PLAYLIST_LIMIT = 200
HIDDEN_ACCOUNT_PLAYLISTS = {"LM", "SE"}  # Liked Music and Episodes for Later have their own places
RATINGS = {"LIKE", "DISLIKE", "INDIFFERENT"}

_local = threading.local()
_cache: dict = {}
_cache_lock = threading.Lock()


class BadRequest(ValueError):
    pass


class NotSignedIn(PermissionError):
    pass


@lru_cache(maxsize=1)
def oauth_credentials():
    """Your own Google Cloud OAuth client ("TVs and Limited Input devices"), or None if unset.

    Read from CADENCE_GOOGLE_CLIENT_ID / CADENCE_GOOGLE_CLIENT_SECRET, or from oauth-client.json
    next to this file (the JSON Google Cloud lets you download works as-is).
    """
    client_id = os.environ.get("CADENCE_GOOGLE_CLIENT_ID", "").strip()
    secret = os.environ.get("CADENCE_GOOGLE_CLIENT_SECRET", "").strip()
    if not (client_id and secret) and OAUTH_CLIENT_FILE.exists():
        data = json.loads(OAUTH_CLIENT_FILE.read_text("utf-8"))
        data = data.get("installed") or data.get("web") or data
        client_id, secret = data.get("client_id", ""), data.get("client_secret", "")
    if not (client_id and secret):
        return None
    return OAuthCredentials(client_id=client_id, client_secret=secret)


def need_credentials():
    creds = oauth_credentials()
    if creds is None:
        raise BadRequest("Google sign-in isn't set up on this server. See the README's Google sign-in section.")
    return creds


def google_oauth(step):
    """Run one OAuth call, turning a misconfigured client into a message the listener can act on."""
    try:
        return step(need_credentials())
    except (BadOAuthClient, UnauthorizedOAuthClient) as err:
        raise BadRequest(
            "Google rejected this server's OAuth client. Check the client ID and secret, that the client type is "
            f"'TVs and Limited Input devices', and that the YouTube Data API is enabled ({err})."
        ) from err


def ytm() -> YTMusic:
    # ytmusicapi holds a requests session, so each thread keeps its own client per language/region.
    language, region, token = getattr(_local, "req", (DEFAULT_LANGUAGE, "", None))
    if token:
        # Signed-in clients are per request: they carry one listener's token and are never shared.
        now = int(time.time())
        auth = {
            "scope": OAUTH_SCOPE, "token_type": "Bearer", "access_token": token, "refresh_token": "",
            "expires_at": now + ASSUMED_TOKEN_LIFETIME, "expires_in": ASSUMED_TOKEN_LIFETIME,
        }
        try:
            return YTMusic(auth=auth, oauth_credentials=need_credentials(), language=language, location=region)
        except BadRequest:
            raise
        except Exception as err:
            raise BadRequest(f"YouTube Music doesn't support that language or region ({err}).") from err
    key = (language, region)
    clients = getattr(_local, "clients", None)
    if clients is None:
        clients = _local.clients = {}
    if key not in clients:
        try:
            clients[key] = YTMusic(language=language, location=region)
        except Exception as err:
            raise BadRequest(f"YouTube Music doesn't support that language or region ({err}).") from err
    return clients[key]


def signed_in():
    return bool(getattr(_local, "req", (None, None, None))[2])


def need_signed_in():
    if not signed_in():
        raise NotSignedIn("Sign in with Google first.")


def cached(key, compute):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]
    value = compute()
    with _cache_lock:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            _cache.clear()
        _cache[key] = (now, value)
    return value


def http_json(url):
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read())


# ---------------------------------------------------------------- shaping YouTube Music data

def parse_duration(text):
    if not text:
        return None
    try:
        parts = [int(p) for p in str(text).split(":")]
    except ValueError:
        return None
    total = 0
    for part in parts:
        total = total * 60 + part
    return total


def art_url(thumbs, size=ART_SIZE):
    if not thumbs:
        return None
    url = max(thumbs, key=lambda t: t.get("width") or 0).get("url")
    if not url:
        return None
    # Google image URLs carry their size in the suffix, so ask for a sharper copy.
    if "googleusercontent.com" in url or "ggpht.com" in url:
        url = re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url, count=1)
        url = re.sub(r"=s\d+$", f"=s{size}", url)
    return url


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("name") or ""
    if isinstance(value, list):
        return ", ".join(filter(None, (text_of(v) for v in value)))
    return ""


def real_artists(item):
    return [a for a in item.get("artists") or [] if a.get("name") and not VIEWS_RE.match(a["name"])]


def artist_names(item):
    return ", ".join(a["name"] for a in real_artists(item))


def to_track(item, album=None, album_id=None, art=None, artist=None):
    if not item or not item.get("videoId") or item.get("isAvailable") is False:
        return None
    album_info = item.get("album") if isinstance(item.get("album"), dict) else {}
    artists = real_artists(item)
    duration = item.get("duration_seconds") or parse_duration(item.get("duration") or item.get("length"))
    return {
        "id": item["videoId"],
        "title": item.get("title") or "Untitled",
        "artist": ", ".join(a["name"] for a in artists) or text_of(item.get("author")) or artist or "",
        "artistId": next((a.get("id") for a in artists if a.get("id")), None),
        "album": album_info.get("name") or album,
        "albumId": album_info.get("id") or album_id,
        "duration": duration,
        "art": art_url(item.get("thumbnails") or item.get("thumbnail")) or art,
        "video": item.get("videoType") not in (None, "MUSIC_VIDEO_TYPE_ATV"),
        "explicit": bool(item.get("isExplicit")),
    }


def to_card(item):
    if not item:
        return None
    browse_id = item.get("browseId") or ""
    playlist_id = item.get("playlistId") or ""
    title = item.get("title") or item.get("artist") or "Untitled"
    if browse_id.startswith("MPRE"):
        kind, ident = "album", browse_id
        subtitle = " · ".join(filter(None, [item.get("type"), artist_names(item), item.get("year")]))
    elif browse_id.startswith("MPSP"):
        kind, ident = "podcast", browse_id
        subtitle = text_of(item.get("author")) or "Podcast"
    elif browse_id.startswith("UC"):
        kind, ident = "artist", browse_id
        subtitle = f"{item['subscribers']} subscribers" if item.get("subscribers") else "Artist"
    elif playlist_id or browse_id.startswith("VL"):
        kind, ident = "playlist", playlist_id or browse_id
        subtitle = item.get("description") or text_of(item.get("author"))
        if item.get("itemCount") and not item.get("description"):
            subtitle = " · ".join(filter(None, [subtitle, f"{item['itemCount']} songs"]))
    else:
        return None
    return {"kind": kind, "id": ident, "title": title, "subtitle": subtitle or "", "art": art_url(item.get("thumbnails"))}


def keep(items):
    return [i for i in items if i]


# ---------------------------------------------------------------- YouTube Music calls

def home():
    shelves = []
    for shelf in ytm().get_home(limit=HOME_SHELF_LIMIT):
        items = keep(shelf.get("contents") or [])
        tracks = keep(to_track(i) for i in items)
        cards = keep(to_card(i) for i in items if not i.get("videoId"))
        if tracks and len(tracks) >= len(cards):
            shelves.append({"title": shelf.get("title"), "kind": "tracks", "items": tracks})
        elif cards:
            shelves.append({"title": shelf.get("title"), "kind": "cards", "items": cards})
    return {"shelves": shelves}


def search(query, kind):
    if kind in ("songs", "videos"):
        return {"items": keep(to_track(r) for r in ytm().search(query, filter=kind, limit=SEARCH_LIMIT))}
    if kind in ("albums", "artists", "podcasts"):
        results = ytm().search(query, filter=kind, limit=SEARCH_LIMIT)
    elif kind == "playlists":
        results = ytm().search(query, filter="featured_playlists", limit=PLAYLIST_SEARCH_LIMIT)
        results += ytm().search(query, filter="community_playlists", limit=PLAYLIST_SEARCH_LIMIT)
    else:
        raise BadRequest(f"Unknown search type '{kind}'.")
    return {"items": keep(to_card(r) for r in results)}


def album(browse_id):
    data = ytm().get_album(browse_id)
    art = art_url(data.get("thumbnails"))
    tracks = keep(
        to_track(t, album=data.get("title"), album_id=browse_id, art=art) for t in data.get("tracks") or []
    )
    artists = real_artists(data)
    return {
        "kind": "album",
        "id": browse_id,
        "label": data.get("type") or "Album",
        "title": data.get("title") or "Untitled album",
        "subtitle": artist_names(data),
        "artistId": next((a.get("id") for a in artists if a.get("id")), None),
        "meta": keep([data.get("year"), f"{len(tracks)} songs", data.get("duration")]),
        "art": art,
        "tracks": tracks,
    }


def playlist(playlist_id):
    data = ytm().get_playlist(playlist_id, limit=PLAYLIST_TRACK_LIMIT)
    tracks = keep(to_track(t) for t in data.get("tracks") or [])
    return {
        "kind": "playlist",
        "id": playlist_id,
        "label": "Playlist",
        "title": data.get("title") or "Untitled playlist",
        "subtitle": text_of(data.get("author")),
        "meta": keep([f"{len(tracks)} songs", data.get("duration")]),
        "art": art_url(data.get("thumbnails")),
        "tracks": tracks,
    }


def podcast(browse_id):
    playlist_id = browse_id[4:] if browse_id.startswith("MPSP") else browse_id
    data = ytm().get_podcast(playlist_id)
    author = text_of(data.get("author"))
    art = art_url(data.get("thumbnails"))
    episodes = keep(to_track(e, artist=author, art=art) for e in data.get("episodes") or [])
    return {
        "kind": "podcast",
        "id": browse_id,
        "label": "Podcast",
        "title": data.get("title") or "Untitled podcast",
        "subtitle": author,
        "meta": [f"{len(episodes)} episodes"],
        "art": art,
        "tracks": episodes,
    }


def artist(channel_id):
    data = ytm().get_artist(channel_id)
    name = data.get("name") or "Artist"

    def section(key, convert):
        return keep(convert(i) for i in (data.get(key) or {}).get("results") or [])

    return {
        "kind": "artist",
        "id": channel_id,
        "title": name,
        "art": art_url(data.get("thumbnails"), size=ARTIST_ART_SIZE),
        "meta": keep([
            f"{data['subscribers']} subscribers" if data.get("subscribers") else None,
            f"{data['monthlyListeners']} monthly listeners" if data.get("monthlyListeners") else None,
        ]),
        "description": (data.get("description") or "").strip(),
        "songs": section("songs", lambda i: to_track(i, artist=name)),
        "albums": section("albums", lambda i: to_card({**i, "artists": i.get("artists") or [{"name": name}]})),
        "singles": section("singles", to_card),
        "videos": section("videos", lambda i: to_track({**i, "videoType": i.get("videoType") or "MUSIC_VIDEO_TYPE_OMV"})),
        "related": section("related", to_card),
    }


def radio(video_id):
    data = ytm().get_watch_playlist(videoId=video_id, limit=RADIO_LIMIT)
    return {"items": [t for t in keep(to_track(i) for i in data.get("tracks") or []) if t["id"] != video_id]}


def alternate(query, exclude):
    # Some uploads block embedding; another upload of the same song usually plays.
    for kind in ("songs", "videos"):
        for result in ytm().search(query, filter=kind, limit=6):
            track = to_track(result)
            if track and track["id"] not in exclude:
                return {"track": track}
    return {"track": None}


def suggestions(query):
    return {"items": [s for s in ytm().get_search_suggestions(query) if isinstance(s, str)][:SUGGESTION_LIMIT]}


def moods():
    return {
        "groups": [
            {"title": title, "items": [{"title": c["title"], "params": c["params"]} for c in items]}
            for title, items in ytm().get_mood_categories().items()
        ]
    }


def mood(params):
    return {"items": keep(to_card(p) for p in ytm().get_mood_playlists(params))}


def mood_mix(params):
    request_key = getattr(_local, "req", (DEFAULT_LANGUAGE, "", None))
    playlists = [p for p in ytm().get_mood_playlists(params) if p.get("playlistId")][:MOOD_MIX_PLAYLISTS]

    def fetch(pl):
        _local.req = request_key
        try:
            data = ytm().get_playlist(pl["playlistId"], limit=MOOD_MIX_PLAYLIST_TRACKS)
            return keep(to_track(t) for t in data.get("tracks") or [])
        except Exception:  # one failing playlist shouldn't sink the whole mix
            return []

    with ThreadPoolExecutor(max_workers=MOOD_MIX_PLAYLISTS) as pool:
        batches = list(pool.map(fetch, playlists))
    seen, tracks = set(), []
    for track in (t for batch in batches for t in batch):
        if track["id"] not in seen:
            seen.add(track["id"])
            tracks.append(track)
    random.shuffle(tracks)
    return {"items": tracks[:MOOD_MIX_SIZE]}


# ---------------------------------------------------------------- lyrics and SponsorBlock

def clean_title(title):
    return FEAT_RE.sub("", TITLE_NOISE_RE.sub("", title)).strip()


def parse_lrc(text):
    lines = []
    for raw in (text or "").splitlines():
        match = LRC_LINE_RE.match(raw.strip())
        if match:
            lines.append({"t": round(int(match[1]) * 60 + float(match[2]), 2), "text": match[3].strip()})
    return lines


def lyrics(params):
    title = clean_title(need(params, "title"))
    artist_name = (params.get("artist") or "").split(",")[0].strip()
    if params.get("video") == "1" and " - " in title:
        maybe_artist, maybe_title = title.split(" - ", 1)
        artist_name, title = maybe_artist.strip(), clean_title(maybe_title)
    duration = float(params.get("duration") or 0)
    query = {"track_name": title, **({"artist_name": artist_name} if artist_name else {})}
    results = http_json(f"{LRCLIB_SEARCH}?{urlencode(query)}")
    if not results:
        return {"synced": None, "plain": None}

    def score(item):
        gap = abs((item.get("duration") or 0) - duration) if duration else 0
        return (gap > LYRICS_DURATION_TOLERANCE, not item.get("syncedLyrics"), gap)

    best = min(results, key=score)
    if duration and abs((best.get("duration") or 0) - duration) > LYRICS_MAX_DRIFT:
        return {"synced": None, "plain": None}
    return {
        "synced": parse_lrc(best.get("syncedLyrics")) or None,
        "plain": best.get("plainLyrics") or None,
        "instrumental": bool(best.get("instrumental")),
        "source": "LRCLIB",
    }


def skips(video_id):
    if not VIDEO_ID_RE.match(video_id):
        raise BadRequest("That isn't a YouTube video id.")
    # Ask by hash prefix so SponsorBlock never learns exactly which video is playing.
    prefix = hashlib.sha256(video_id.encode()).hexdigest()[:4]
    url = SPONSORBLOCK_URL.format(prefix=prefix, categories=quote(json.dumps(SPONSORBLOCK_CATEGORIES)))
    try:
        data = http_json(url)
    except HTTPError as err:
        if err.code == 404:
            return {"segments": []}
        raise
    segments = [
        {"start": s["segment"][0], "end": s["segment"][1], "category": s.get("category")}
        for item in data if item.get("videoID") == video_id
        for s in item.get("segments") or [] if s.get("actionType", "skip") == "skip"
    ]
    return {"segments": sorted(segments, key=lambda s: s["start"])}


# ---------------------------------------------------------------- Google sign-in and your account

def token_payload(raw):
    now = int(time.time())
    return {
        "accessToken": raw["access_token"],
        "refreshToken": raw.get("refresh_token"),
        "expiresAt": now + int(raw.get("expires_in", 3600)),
        "refreshExpiresAt": now + int(raw["refresh_token_expires_in"]) if raw.get("refresh_token_expires_in") else None,
    }


def auth_start():
    code = google_oauth(lambda creds: creds.get_code())
    if "error" in code:
        raise BadRequest(f"Google wouldn't start sign-in ({code.get('error_description') or code['error']}).")
    return {
        "userCode": code["user_code"],
        "verificationUrl": code["verification_url"],
        "deviceCode": code["device_code"],
        "interval": int(code.get("interval", 5)),
        "expiresIn": int(code.get("expires_in", 1800)),
    }


def auth_poll(device_code):
    raw = google_oauth(lambda creds: creds.token_from_code(device_code))
    error = raw.get("error")
    if error in ("authorization_pending", "slow_down"):
        return {"status": "pending", "slowDown": error == "slow_down"}
    if error == "access_denied":
        return {"status": "denied"}
    if error == "expired_token":
        return {"status": "expired"}
    if error:
        raise BadRequest(f"Google refused the sign-in ({raw.get('error_description') or error}).")
    return {"status": "done", "token": token_payload(raw)}


def auth_refresh(refresh_token):
    try:
        raw = google_oauth(lambda creds: creds.refresh_token(refresh_token))
    except BadRequest:
        raise
    except Exception as err:  # Google answers a dead refresh token with an error status
        return {"status": "signed_out", "reason": str(err)}
    if "access_token" not in raw:
        # Revoked, expired (7 days for apps still in Google's "Testing" mode) or from another client.
        return {"status": "signed_out", "reason": raw.get("error_description") or raw.get("error") or "unknown"}
    return {"status": "ok", "token": token_payload(raw)}


def auth_revoke(token):
    request = Request(f"{OAUTH_REVOKE_URL}?{urlencode({'token': token})}", method="POST",
                      headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS):
            pass
    except HTTPError as err:
        if err.code != 400:  # 400 means the token was already invalid, which is what we wanted
            raise
    return {"status": "revoked"}


def account():
    need_signed_in()
    info = ytm().get_account_info()
    return {"name": info.get("accountName"), "handle": info.get("channelHandle"), "photo": info.get("accountPhotoUrl")}


def liked_songs():
    need_signed_in()
    data = ytm().get_liked_songs(limit=LIKED_SYNC_LIMIT)
    return {"items": keep(to_track(t) for t in data.get("tracks") or [])}


def account_playlists():
    need_signed_in()
    playlists = ytm().get_library_playlists(limit=ACCOUNT_PLAYLIST_LIMIT)
    cards = []
    for p in playlists:
        if p.get("playlistId") in HIDDEN_ACCOUNT_PLAYLISTS:
            continue
        card = to_card({**p, "description": p.get("description") or (f"{p['count']} songs" if p.get("count") else "")})
        if card:
            cards.append(card)
    return {"items": cards}


def rate(body):
    need_signed_in()
    video_id, rating = str(body.get("id") or ""), str(body.get("rating") or "")
    if not VIDEO_ID_RE.match(video_id) or rating not in RATINGS:
        raise BadRequest("Rating needs a video id and LIKE, DISLIKE or INDIFFERENT.")
    ytm().rate_song(video_id, rating)
    return {"status": "ok"}


def add_history(body):
    need_signed_in()
    video_id = str(body.get("id") or "")
    if not VIDEO_ID_RE.match(video_id):
        raise BadRequest("That isn't a YouTube video id.")
    client = ytm()
    client.add_history_item(client.get_song(video_id))
    return {"status": "ok"}


# ---------------------------------------------------------------- routing

def need(params, key):
    value = (params.get(key) or "").strip()
    if not value:
        raise BadRequest(f"Missing '{key}'.")
    return value


def need_secret(secrets, key):
    value = (secrets.get(key) or "").strip()
    if not value:
        raise BadRequest("Sign-in details are missing from the request.")
    return value


def cache_route(name, compute, *keys):
    def run(params):
        if signed_in():
            return compute(params)  # personal answers never go into the shared cache
        key = (name, getattr(_local, "req", None), *[(params.get(k) or "").strip().lower() for k in keys])
        return cached(key, lambda: compute(params))

    return run


# Routes whose answers are the same for everyone for a while; edge caches may keep them.
CACHEABLE = {"/api/home", "/api/search", "/api/suggest", "/api/album", "/api/playlist", "/api/podcast",
             "/api/artist", "/api/moods", "/api/mood", "/api/lyrics", "/api/skips"}

ROUTES = {
    "/api/home": cache_route("home", lambda p: home()),
    "/api/search": cache_route("search", lambda p: search(need(p, "q"), p.get("type") or "songs"), "q", "type"),
    "/api/suggest": cache_route("suggest", lambda p: suggestions(need(p, "q")), "q"),
    "/api/album": cache_route("album", lambda p: album(need(p, "id")), "id"),
    "/api/playlist": cache_route("playlist", lambda p: playlist(need(p, "id")), "id"),
    "/api/podcast": cache_route("podcast", lambda p: podcast(need(p, "id")), "id"),
    "/api/artist": cache_route("artist", lambda p: artist(need(p, "id")), "id"),
    "/api/moods": cache_route("moods", lambda p: moods()),
    "/api/mood": cache_route("mood", lambda p: mood(need(p, "params")), "params"),
    "/api/mood-mix": lambda p: mood_mix(need(p, "params")),
    "/api/lyrics": cache_route("lyrics", lyrics, "title", "artist", "duration"),
    "/api/skips": cache_route("skips", lambda p: skips(need(p, "id")), "id"),
    "/api/radio": lambda p: radio(need(p, "id")),
    "/api/alternate": lambda p: alternate(need(p, "q"), set(p.get("exclude", "").split(","))),
    "/api/account": lambda p: account(),
    "/api/liked": lambda p: liked_songs(),
    "/api/account-playlists": lambda p: account_playlists(),
}

# Sign-in steps take their secrets from request headers (never the URL, which ends up in logs).
AUTH_ROUTES = {
    "/api/auth/config": lambda s: {"configured": oauth_credentials() is not None},
    "/api/auth/start": lambda s: auth_start(),
    "/api/auth/poll": lambda s: auth_poll(need_secret(s, "device")),
    "/api/auth/refresh": lambda s: auth_refresh(need_secret(s, "refresh")),
    "/api/auth/revoke": lambda s: auth_revoke(need_secret(s, "refresh")),
}

POST_ROUTES = {
    "/api/rate": rate,
    "/api/history": add_history,
}

# Requests carrying any of these headers are personal and must never be cached.
SECRET_HEADERS = {"token": "X-Cadence-Token", "refresh": "X-Cadence-Refresh", "device": "X-Cadence-Device"}


def read_secrets(headers):
    return {key: headers.get(name, "") for key, name in SECRET_HEADERS.items() if headers.get(name)}


def is_personal(path, secrets):
    return bool(secrets) or path.startswith("/api/auth/")


def dispatch(path, params, secrets=None, body=None):
    """Answer one API call. Returns (HTTP status, JSON-ready payload).

    `secrets` holds the sign-in values from the request headers; `body` is the JSON body of a POST.
    """
    secrets = secrets or {}
    if body is not None:
        route = POST_ROUTES.get(path)
        call = (lambda: route(body)) if route else None
    elif path in AUTH_ROUTES:
        call = lambda: AUTH_ROUTES[path](secrets)  # noqa: E731
    else:
        route = ROUTES.get(path)
        call = (lambda: route(params)) if route else None
    if call is None:
        return 404, {"error": "No such endpoint."}
    language = params.pop("hl", "") or DEFAULT_LANGUAGE
    region = params.pop("gl", "")
    if not CODE_RE.match(language) or not CODE_RE.match(region):
        return 400, {"error": "Language and region must be short codes such as 'en' and 'IN'."}
    _local.req = (language, region.upper(), secrets.get("token") or None)
    try:
        return 200, call()
    except NotSignedIn as err:
        return 401, {"error": str(err)}
    except BadRequest as err:
        return 400, {"error": str(err)}
    except Exception as err:  # YouTube Music, Google, LRCLIB and SponsorBlock fail in many shapes
        if signed_in() and "401" in str(err):
            return 401, {"error": "Google didn't accept your sign-in. Sign in again."}
        return 502, {"error": f"The music service didn't answer ({type(err).__name__})."}
    finally:
        _local.req = (DEFAULT_LANGUAGE, "", None)
