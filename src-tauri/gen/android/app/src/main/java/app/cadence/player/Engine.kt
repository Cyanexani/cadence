package app.cadence.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.session.MediaSession

/**
 * The one audio player of the app. It lives outside the web page so music keeps playing when the
 * screen turns off or the app is in the background; [PlaybackService] keeps the process alive and
 * shows the media notification. The page drives it through [NativePlayerPlugin].
 *
 * Everything here runs on the main thread.
 */
object Engine {
  private lateinit var appContext: Context
  private var player: ExoPlayer? = null
  private var session: MediaSession? = null

  /** "next" or "previous" when the notification or lock screen asked; the page picks it up. */
  @Volatile var pendingCommand: String? = null
  @Volatile var lastError: String? = null
  @Volatile var lastErrorCode: Int = 0

  val main = Handler(Looper.getMainLooper())

  fun init(context: Context) {
    if (player != null) return
    appContext = context.applicationContext
    val exo = ExoPlayer.Builder(appContext)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    exo.setAudioAttributes(
      androidx.media3.common.AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build(),
      /* handleAudioFocus = */ true,
    )
    exo.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) {
        lastError = error.errorCodeName
        lastErrorCode = error.errorCode
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) ensureService()
      }
    })
    player = exo
    session = MediaSession.Builder(appContext, QueueAwarePlayer(exo)).build()
  }

  fun mediaSession(): MediaSession = session ?: error("Engine.init was not called")

  /** Starts the foreground service that keeps playback alive; media3 posts the notification. */
  private fun ensureService() {
    ContextCompat.startForegroundService(appContext, Intent(appContext, PlaybackService::class.java))
  }

  fun load(url: String, userAgent: String, startMs: Long, autoplay: Boolean, title: String, artist: String, art: String?) {
    val exo = player ?: return
    lastError = null
    lastErrorCode = 0
    pendingCommand = null
    // YouTube checks that the player identifies as the client that produced the stream URL.
    val http = DefaultHttpDataSource.Factory()
      .setUserAgent(userAgent.ifEmpty { "Mozilla/5.0" })
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(20_000)
      .setAllowCrossProtocolRedirects(true)
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setArtworkUri(art?.let { Uri.parse(it) })
      .build()
    val item = MediaItem.Builder().setUri(url).setMediaMetadata(metadata).build()
    exo.setMediaSource(ProgressiveMediaSource.Factory(http).createMediaSource(item), startMs)
    exo.playWhenReady = autoplay
    exo.prepare()
  }

  fun play() { player?.play() }
  fun pause() { player?.pause() }
  fun seek(ms: Long) { player?.seekTo(ms) }
  fun volume(v: Float) { player?.volume = v.coerceIn(0f, 1f) }
  fun stop() { player?.stop() }

  /** The player's state in the words the page's player adapter uses. */
  fun status(): Map<String, Any?> {
    val exo = player ?: return mapOf("state" to "idle")
    val state = when (exo.playbackState) {
      Player.STATE_BUFFERING -> "buffering"
      Player.STATE_READY -> "ready"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
    val duration = exo.duration
    val command = pendingCommand
    pendingCommand = null
    return mapOf(
      "state" to state,
      "playing" to exo.isPlaying,
      "wantsPlay" to exo.playWhenReady,
      "position" to exo.currentPosition / 1000.0,
      "duration" to if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0,
      "error" to lastError,
      "errorCode" to lastErrorCode,
      "command" to command,
    )
  }

  /** Lets the notification and lock screen show next and previous, which the page's queue handles. */
  private class QueueAwarePlayer(player: Player) : ForwardingPlayer(player) {
    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands().buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .build()

    override fun isCommandAvailable(command: Int): Boolean =
      command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_PREVIOUS || super.isCommandAvailable(command)

    override fun seekToNext() { pendingCommand = "next" }
    override fun seekToNextMediaItem() { pendingCommand = "next" }
    override fun seekToPrevious() { pendingCommand = "previous" }
    override fun seekToPreviousMediaItem() { pendingCommand = "previous" }
  }
}
