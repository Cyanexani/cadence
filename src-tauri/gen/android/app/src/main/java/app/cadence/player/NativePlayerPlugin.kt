package app.cadence.player

import android.app.Activity
import android.content.ComponentName
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

/**
 * The web UI's handle on [PlaybackService]. Commands come in through Rust (lib.rs, the
 * `native_player` command); events go back to `window.__cadenceNative(event, data)`, which
 * app.js defines. Everything touching the controller runs on the main thread.
 */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    /** While playing, the UI also gets the position this often, to correct its own clock. */
    private const val PROGRESS_MS = 5_000L
  }

  private val app = activity.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var controller: MediaController? = null
  private var connecting: ListenableFuture<MediaController>? = null
  private val waiting = ArrayDeque<Pair<Invoke, (MediaController) -> Unit>>()

  private val progress = object : Runnable {
    override fun run() {
      val c = controller ?: return
      if (c.isPlaying) {
        emit("state", snapshot(c))
        main.postDelayed(this, PROGRESS_MS)
      }
    }
  }

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(
          Player.EVENT_IS_PLAYING_CHANGED,
          Player.EVENT_PLAYBACK_STATE_CHANGED,
          Player.EVENT_PLAY_WHEN_READY_CHANGED,
          Player.EVENT_POSITION_DISCONTINUITY,
          Player.EVENT_TIMELINE_CHANGED,
        )
      ) {
        emit("state", snapshot(player))
      }
      main.removeCallbacks(progress)
      if (player.isPlaying) main.postDelayed(progress, PROGRESS_MS)
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      // Only moves the player made itself (the queued next song began); the UI asked for the rest.
      if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && mediaItem != null) {
        emit("transition", JSObject().put("id", mediaItem.mediaId))
      }
    }

    override fun onPlayerError(error: PlaybackException) {
      val id = controller?.currentMediaItem?.mediaId
      if (id != null && id == PlaybackService.retryingId) {
        PlaybackService.retryingId = null
        return
      }
      emit("error", JSObject().put("id", id).put("code", error.errorCodeName).put("message", error.message ?: ""))
    }
  }

  override fun load(webView: WebView) {
    // Called again with the new web view if the activity is recreated.
    this.webView = webView
    PlaybackService.onRemote = { action -> emit("remote", JSObject().put("action", action)) }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    // No page to ask: notification next/previous fall back to the songs queued in the player.
    webView = null
    PlaybackService.onRemote = null
    // Let go of the service, so it can stop if the app was swiped away while paused (a bound
    // controller keeps it alive). A new page reconnects with its first command.
    main.post {
      main.removeCallbacks(progress)
      controller?.run {
        removeListener(listener)
        release()
      }
      controller = null
      connecting?.let(MediaController::releaseFuture)
      connecting = null
      while (waiting.isNotEmpty()) waiting.removeFirst().first.reject("The app closed.")
    }
  }

  // ------------------------------------------------------------------ commands

  /** {id, title, artist, album, art, start (seconds), autoplay, upcoming: [{id, title, ...}]} */
  @Command
  fun playTrack(invoke: Invoke) {
    val args = invoke.getArgs()
    val track = mediaItem(args) ?: return invoke.reject("No song to play.")
    val upcoming = mediaItems(args.optJSONArray("upcoming"))
    val startMs = (args.optDouble("start", 0.0) * 1000).toLong().coerceAtLeast(0)
    val autoplay = args.optBoolean("autoplay", true)
    withController(invoke) { c ->
      c.setMediaItems(listOf(track) + upcoming, 0, startMs)
      c.playWhenReady = autoplay
      c.prepare()
      invoke.resolve()
    }
  }

  /**
   * {upcoming: [track]}: the songs to follow the current one, in order. They play on gaplessly,
   * even with the app closed. Only what changed is replaced, so the next song stays buffered.
   */
  @Command
  fun setUpcoming(invoke: Invoke) {
    val upcoming = mediaItems(invoke.getArgs().optJSONArray("upcoming"))
    withController(invoke) { c ->
      // Songs already played have no use here.
      if (c.currentMediaItemIndex > 0) c.removeMediaItems(0, c.currentMediaItemIndex)
      val from = c.currentMediaItemIndex + 1
      val have = (from until c.mediaItemCount).map { c.getMediaItemAt(it).mediaId }
      var same = 0
      while (same < have.size && same < upcoming.size && have[same] == upcoming[same].mediaId) same++
      if (from + same < c.mediaItemCount) c.removeMediaItems(from + same, c.mediaItemCount)
      if (same < upcoming.size) c.addMediaItems(upcoming.subList(same, upcoming.size))
      invoke.resolve()
    }
  }

  @Command
  fun play(invoke: Invoke) = withController(invoke) { c ->
    if (c.playbackState == Player.STATE_IDLE) c.prepare()
    if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
    c.play()
    invoke.resolve()
  }

  @Command
  fun pause(invoke: Invoke) = withController(invoke) { c ->
    c.pause()
    invoke.resolve()
  }

  /** {seconds} */
  @Command
  fun seek(invoke: Invoke) {
    val ms = (invoke.getArgs().optDouble("seconds", 0.0) * 1000).toLong().coerceAtLeast(0)
    withController(invoke) { c ->
      c.seekTo(ms)
      invoke.resolve()
    }
  }

  /** {volume: 0-100, muted} */
  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.getArgs()
    val volume = if (args.optBoolean("muted", false)) 0f else (args.optDouble("volume", 100.0) / 100).toFloat().coerceIn(0f, 1f)
    withController(invoke) { c ->
      c.volume = volume
      invoke.resolve()
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    val c = controller ?: return invoke.resolve() // nothing to stop, and no reason to start the service
    main.post {
      c.stop()
      c.clearMediaItems()
      invoke.resolve()
    }
  }

  /** What's playing, so a reopened UI can pick up a song that kept going without it. */
  @Command
  fun status(invoke: Invoke) = withController(invoke) { invoke.resolve(snapshot(it)) }

  // ------------------------------------------------------------------ plumbing

  private fun withController(invoke: Invoke, block: (MediaController) -> Unit) {
    main.post {
      val c = controller
      if (c != null) runCommand(invoke, block, c) else {
        waiting.addLast(invoke to block)
        connect()
      }
    }
  }

  private fun runCommand(invoke: Invoke, block: (MediaController) -> Unit, c: MediaController) {
    try {
      block(c)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "The player didn't respond.")
    }
  }

  private fun connect() {
    if (connecting != null) return
    val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
    val future = MediaController.Builder(app, token).buildAsync()
    connecting = future
    future.addListener({
      connecting = null
      val c = try {
        future.get()
      } catch (e: Exception) {
        while (waiting.isNotEmpty()) waiting.removeFirst().first.reject("Couldn't start the player: ${e.message}")
        return@addListener
      }
      c.addListener(listener)
      controller = c
      while (waiting.isNotEmpty()) {
        val (invoke, block) = waiting.removeFirst()
        runCommand(invoke, block, c)
      }
    }, ContextCompat.getMainExecutor(app))
  }

  private fun mediaItems(list: JSONArray?): List<MediaItem> =
    if (list == null) emptyList() else (0 until list.length()).mapNotNull { list.optJSONObject(it)?.let(::mediaItem) }

  private fun mediaItem(args: JSONObject): MediaItem? {
    val id = args.optString("id").takeIf { it.isNotBlank() } ?: return null
    val meta = MediaMetadata.Builder()
      .setTitle(args.optString("title").ifBlank { null })
      .setArtist(args.optString("artist").ifBlank { null })
      .setAlbumTitle(args.optString("album").ifBlank { null })
      .setArtworkUri(args.optString("art").ifBlank { null }?.let(Uri::parse))
      .setIsPlayable(true)
      .setIsBrowsable(false)
      .build()
    return MediaItem.Builder().setMediaId(id).setUri(PlaybackService.trackUri(id)).setMediaMetadata(meta).build()
  }

  private fun snapshot(p: Player): JSObject {
    val id = p.currentMediaItem?.mediaId
    val state = when (p.playbackState) {
      Player.STATE_BUFFERING -> "buffering"
      Player.STATE_READY -> "ready"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
    val duration = p.duration.takeIf { it != C.TIME_UNSET }?.let { it / 1000.0 } ?: 0.0
    val out = JSObject()
      .put("id", id)
      .put("state", state)
      .put("playing", p.isPlaying)
      .put("playWhenReady", p.playWhenReady)
      .put("position", p.currentPosition / 1000.0)
      .put("duration", duration)
    id?.let(YouTubeAudio::cached)?.let { out.put("codec", it.codec).put("bitrate", it.bitrate) }
    return out
  }

  private fun emit(event: String, data: JSObject) {
    main.post {
      webView?.evaluateJavascript("window.__cadenceNative && window.__cadenceNative(${JSONObject.quote(event)}, $data)", null)
    }
  }
}
