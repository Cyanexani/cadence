package app.cadence.player

import android.content.Context
import android.content.Intent
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.session.MediaSession
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow

/** One song the player can be given: where to read it (the app's local audio server) and how to show it. */
class Song(
  val slot: String,
  val url: String,
  val title: String,
  val artist: String,
  val art: String?,
  val loudnessDb: Double?,
)

/**
 * The one audio player of the app. It lives outside the web page so music keeps playing when the
 * screen turns off or the app is in the background; [PlaybackService] keeps the process alive and
 * shows the media notification. The page drives it through [NativePlayerPlugin].
 *
 * The page hands over the current song and the few after it. The player starts each one by itself
 * when the last ends, so changing songs never waits for the page (which Android may have put to sleep).
 *
 * Everything here runs on the main thread.
 */
object Engine {
  private const val KEEP_PLAYED = 3
  private const val RESTART_AFTER_MS = 3000L

  private lateinit var appContext: Context
  private var player: ExoPlayer? = null
  private var session: MediaSession? = null
  private val http = DefaultHttpDataSource.Factory()
    .setConnectTimeoutMs(15_000)
    .setReadTimeoutMs(20_000)

  /** "next" or "previous" when the notification or lock screen asked for a song the player doesn't have queued. */
  @Volatile var pendingCommand: String? = null
  @Volatile var lastError: String? = null
  @Volatile var lastErrorCode: Int = 0
  @Volatile var sleepFired: Boolean = false

  /** Which `load` the player is working on; commands about an older one are ignored. */
  private var loadGen = 0
  private var loadedSlot: String? = null
  private var retries = 0

  private var userVolume = 1f
  private var normalize = false
  private var eqOn = false
  private var eqGains: List<Int> = emptyList()
  private var eqBandsHz: List<Int> = emptyList()
  private var equalizer: Equalizer? = null
  private var equalizerSession = C.AUDIO_SESSION_ID_UNSET
  private var sleepTask: Runnable? = null

  val main = Handler(Looper.getMainLooper())

  fun init(context: Context) {
    if (player != null) return
    appContext = context.applicationContext
    val exo = ExoPlayer.Builder(appContext)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    exo.setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build(),
      /* handleAudioFocus = */ true,
    )
    exo.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) = handleError(error)

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) ensureService()
      }

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        retries = 0
        applyVolume()
        main.post { trimPlayed() }
      }

      override fun onAudioSessionIdChanged(audioSessionId: Int) = applyEqualizer()
    })
    player = exo
    session = MediaSession.Builder(appContext, QueueAwarePlayer(exo)).build()
  }

  fun mediaSession(): MediaSession = session ?: error("Engine.init was not called")

  /** Starts the foreground service that keeps playback alive; media3 posts the notification. */
  private fun ensureService() {
    ContextCompat.startForegroundService(appContext, Intent(appContext, PlaybackService::class.java))
  }

  private fun source(song: Song): MediaSource {
    val extras = Bundle()
    song.loudnessDb?.let { extras.putDouble("loudnessDb", it) }
    val metadata = MediaMetadata.Builder()
      .setTitle(song.title)
      .setArtist(song.artist)
      .setArtworkUri(song.art?.let { Uri.parse(it) })
      .setExtras(extras)
      .build()
    val item = MediaItem.Builder().setMediaId(song.slot).setUri(song.url).setMediaMetadata(metadata).build()
    return ProgressiveMediaSource.Factory(http).createMediaSource(item)
  }

  /** Plays [song] now, replacing everything queued. */
  fun load(gen: Int, song: Song, startMs: Long, autoplay: Boolean) {
    val exo = player ?: return
    loadGen = gen
    loadedSlot = song.slot
    retries = 0
    lastError = null
    lastErrorCode = 0
    pendingCommand = null
    exo.repeatMode = Player.REPEAT_MODE_OFF
    exo.setMediaSource(source(song), startMs)
    exo.playWhenReady = autoplay
    exo.prepare()
    applyVolume()
  }

  /** Replaces the songs after the current one. */
  fun queue(gen: Int, songs: List<Song>, repeatOne: Boolean) {
    val exo = player ?: return
    if (gen != loadGen) return
    exo.repeatMode = if (repeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    val current = exo.currentMediaItemIndex
    val count = exo.mediaItemCount
    if (count > current + 1) exo.removeMediaItems(current + 1, count)
    if (songs.isNotEmpty()) exo.addMediaSources(songs.map { source(it) })
  }

  /** Songs that already played stay for "previous"; older ones go. */
  private fun trimPlayed() {
    val exo = player ?: return
    val current = exo.currentMediaItemIndex
    if (current > KEEP_PLAYED) exo.removeMediaItems(0, current - KEEP_PLAYED)
  }

  private fun handleError(error: PlaybackException) {
    val exo = player ?: return
    lastError = error.errorCodeName
    lastErrorCode = error.errorCode
    if (retries < 1) {
      // Try the same song once more before giving up on it.
      retries++
      lastError = null
      exo.prepare()
      return
    }
    // A song the page queued ahead can be skipped without the page; the one it loaded itself is its to handle.
    if (exo.currentMediaItem?.mediaId != loadedSlot && exo.hasNextMediaItem()) {
      lastError = null
      retries = 0
      exo.seekToNextMediaItem()
      exo.prepare()
    }
  }

  fun play() {
    val exo = player ?: return
    if (exo.playbackState == Player.STATE_ENDED) exo.seekToDefaultPosition()
    exo.playWhenReady = true
  }

  fun pause() { player?.pause() }
  fun seek(ms: Long) { player?.seekTo(ms) }
  fun stop() { player?.stop() }

  fun volume(v: Float) {
    userVolume = v.coerceIn(0f, 1f)
    applyVolume()
  }

  /** The player's volume: what the user chose, turned down for songs YouTube says are loud. */
  private fun applyVolume() {
    val exo = player ?: return
    var factor = 1.0
    if (normalize) {
      val db = exo.currentMediaItem?.mediaMetadata?.extras?.getDouble("loudnessDb", Double.NaN) ?: Double.NaN
      if (!db.isNaN()) factor = 10.0.pow(-db / 20.0).coerceAtMost(1.0)
    }
    exo.volume = (userVolume * factor).toFloat().coerceIn(0f, 1f)
  }

  /** Pauses after [seconds] (0 cancels). The page learns of it through `sleepFired`. */
  fun sleep(seconds: Int) {
    sleepTask?.let { main.removeCallbacks(it) }
    sleepTask = null
    if (seconds <= 0) return
    val task = Runnable {
      player?.pause()
      sleepFired = true
      sleepTask = null
    }
    sleepTask = task
    main.postDelayed(task, seconds * 1000L)
  }

  fun fx(normalize: Boolean, skipSilence: Boolean, eqOn: Boolean, gains: List<Int>, bandsHz: List<Int>) {
    this.normalize = normalize
    this.eqOn = eqOn
    this.eqGains = gains
    this.eqBandsHz = bandsHz
    player?.skipSilenceEnabled = skipSilence
    applyVolume()
    applyEqualizer()
  }

  /** Sets the device's equalizer bands from the page's five (the nearest page band for each device band). */
  private fun applyEqualizer() {
    val exo = player ?: return
    val sessionId = exo.audioSessionId
    if (sessionId == C.AUDIO_SESSION_ID_UNSET) return
    try {
      if (equalizer == null || equalizerSession != sessionId) {
        equalizer?.release()
        equalizer = Equalizer(0, sessionId)
        equalizerSession = sessionId
      }
      val eq = equalizer ?: return
      eq.setEnabled(eqOn)
      if (eqBandsHz.isEmpty()) return
      val range = eq.bandLevelRange
      for (band in 0 until eq.numberOfBands.toInt()) {
        val centerHz = eq.getCenterFreq(band.toShort()) / 1000.0
        val nearest = eqBandsHz.indices.minByOrNull { abs(ln(centerHz / eqBandsHz[it])) } ?: continue
        val level = ((eqGains.getOrElse(nearest) { 0 }) * 100).coerceIn(range[0].toInt(), range[1].toInt())
        eq.setBandLevel(band.toShort(), level.toShort())
      }
    } catch (e: Exception) {
      // Some devices don't offer an equalizer; the music still plays.
      equalizer = null
    }
  }

  /** The player's state in the words the page's player adapter uses. */
  fun status(): Map<String, Any?> {
    val exo = player ?: return mapOf("loadGen" to loadGen, "state" to "idle")
    val state = when (exo.playbackState) {
      Player.STATE_BUFFERING -> "buffering"
      Player.STATE_READY -> "ready"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
    val duration = exo.duration
    val command = pendingCommand
    pendingCommand = null
    val fired = sleepFired
    sleepFired = false
    return mapOf(
      "loadGen" to loadGen,
      "slot" to exo.currentMediaItem?.mediaId,
      "state" to state,
      "playing" to exo.isPlaying,
      "wantsPlay" to exo.playWhenReady,
      "position" to exo.currentPosition / 1000.0,
      "duration" to if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0,
      "error" to lastError,
      "errorCode" to lastErrorCode,
      "command" to command,
      "sleepFired" to fired,
    )
  }

  /**
   * Lets the notification and lock screen show next and previous. Songs the player has queued are
   * handled here; otherwise the page (which owns the queue) is asked.
   */
  private class QueueAwarePlayer(player: Player) : ForwardingPlayer(player) {
    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands().buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .build()

    override fun isCommandAvailable(command: Int): Boolean =
      command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_PREVIOUS || super.isCommandAvailable(command)

    override fun seekToNext() {
      if (wrappedPlayer.hasNextMediaItem()) wrappedPlayer.seekToNextMediaItem() else pendingCommand = "next"
    }

    override fun seekToNextMediaItem() = seekToNext()

    override fun seekToPrevious() {
      if (wrappedPlayer.hasPreviousMediaItem() || wrappedPlayer.currentPosition > RESTART_AFTER_MS) {
        wrappedPlayer.seekToPrevious()
      } else {
        pendingCommand = "previous"
      }
    }

    override fun seekToPreviousMediaItem() = seekToPrevious()
  }
}
