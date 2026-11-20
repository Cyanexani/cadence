mod extras;
pub mod music;

use std::collections::HashMap;

use serde_json::Value;
use tauri::Manager;

use music::Music;

/// Account calls handled by the signed-in session rather than the public music API.
const ACCOUNT_PATHS: [&str; 5] = ["/api/account", "/api/liked", "/api/account-playlists", "/api/rate", "/api/history"];

/// The UI calls this for every music request (search, albums, lyrics, ...). Library data
/// (likes, history, playlists) stays in the webview's own storage, as on the web.
/// `body` is set for writes, mirroring the web API's POST bodies. `secrets` (the web's
/// X-Cadence-* headers) is unused here: the app signs in with Google's own page instead.
#[tauri::command]
async fn api(
    music: tauri::State<'_, Music>,
    path: String,
    params: HashMap<String, String>,
    body: Option<Value>,
    #[allow(unused_variables)] secrets: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    if path.starts_with("/api/auth/") || ACCOUNT_PATHS.contains(&path.as_str()) {
        return music.account_dispatch(&path, body).await;
    }
    music.dispatch(&path, params).await
}

#[cfg(target_os = "android")]
struct GoogleLogin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct LoginResult {
    cookie: String,
}

/// Opens Google's own sign-in page inside the app and keeps the resulting YouTube Music session.
#[tauri::command]
async fn google_sign_in(app: tauri::AppHandle, music: tauri::State<'_, Music>) -> Result<Value, String> {
    let cookie = native_sign_in(&app).await?;
    music.sign_in_with_cookie(cookie).await
}

/// Android: GoogleLoginActivity.kt shows the page and returns the cookies.
#[cfg(target_os = "android")]
async fn native_sign_in(app: &tauri::AppHandle) -> Result<String, String> {
    let login = app.state::<GoogleLogin>();
    let result: LoginResult = login.0.run_mobile_plugin_async("signIn", ()).await.map_err(|e| e.to_string())?;
    Ok(result.cookie)
}

/// Desktop: a private (incognito) window shows the page; once it lands on YouTube Music signed
/// in, its cookies are read and the window closes, taking the browser session with it.
#[cfg(desktop)]
async fn native_sign_in(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::webview::PageLoadEvent;
    use tauri::{Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    const LABEL: &str = "google-sign-in";
    const LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F";
    const MUSIC_URL: &str = "https://music.youtube.com/";

    if let Some(stale) = app.get_webview_window(LABEL) {
        let _ = stale.close();
    }
    // true: a YouTube Music page finished loading; false: the window was closed.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<bool>();
    let landed = tx.clone();
    let login_url = Url::parse(LOGIN_URL).map_err(|e| e.to_string())?;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(login_url))
        .title("Sign in to YouTube Music")
        .inner_size(480.0, 720.0)
        .incognito(true)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().as_str().starts_with(MUSIC_URL) {
                let _ = landed.send(true);
            }
        })
        .build()
        .map_err(|e| format!("Couldn't open the sign-in window: {e}"))?;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = tx.send(false);
        }
    });
    let music_url = Url::parse(MUSIC_URL).map_err(|e| e.to_string())?;
    while let Some(true) = rx.recv().await {
        // Read cookies here, in the async command: on Windows it deadlocks inside event handlers.
        let cookies = window.cookies_for_url(music_url.clone()).map_err(|e| e.to_string())?;
        let header = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
        if header.contains("SAPISID=") {
            let _ = window.close();
            return Ok(header);
        }
        // Landed on YouTube Music but not signed in yet (Google's quick "already signed in?" check).
    }
    Err("Sign-in was cancelled.".to_string())
}

#[cfg(all(mobile, not(target_os = "android")))]
async fn native_sign_in(_app: &tauri::AppHandle) -> Result<String, String> {
    Err("Sign-in isn't available on this platform yet.".to_string())
}

#[tauri::command]
async fn google_sign_out(app: tauri::AppHandle, music: tauri::State<'_, Music>) -> Result<(), String> {
    music.sign_out().await;
    #[cfg(target_os = "android")]
    {
        let login = app.state::<GoogleLogin>();
        let _: Result<Value, _> = login.0.run_mobile_plugin_async("clearCookies", ()).await;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

fn login_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("cadence-login")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("app.cadence.player", "GoogleLoginPlugin")?;
                app.manage(GoogleLogin(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(login_plugin())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            let storage = app.path().app_cache_dir()?.join("rustypipe");
            app.manage(Music::new(storage)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api, google_sign_in, google_sign_out])
        .run(tauri::generate_context!())
        .expect("error while running Cadence");
}
