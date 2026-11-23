package app.cadence.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.IOException

/**
 * Plays songs natively, outside the web view, so music keeps going with the screen off or
 * another app open. Media3 runs it as a foreground service with the media notification and
 * lock-screen controls. The app's queue stays in the web UI (NativePlayerPlugin bridges the
 * two); this player holds the current song plus the next one, so songs change gaplessly even
 * while the UI is asleep.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  companion object {
    private const val TAG = "CadencePlayback"
    private const val SCHEME = "cadence"
    private const val HOST = "youtube"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 20_000

    fun trackUri(videoId: String): Uri = Uri.Builder().scheme(SCHEME).authority(HOST).appendPath(videoId).build()

    /** Notification, headset and Bluetooth "next"/"previous": the UI's queue decides. */
    @Volatile var onRemote: ((String) -> Unit)? = null

    /**
     * Set while a refused (expired) link is being refetched, so the bridge doesn't report that
     * error to the UI, which would switch the song to YouTube's web player.
     */
    @Volatile var retryingId: String? = null
  }

  private var session: MediaSession? = null
  private val retried = HashSet<String>()

  override fun onCreate() {
    super.onCreate()
    // No factory-wide user agent: each stream gets the one YouTube expects (see YouTubeAudio).
    val http = DefaultHttpDataSource.Factory()
      .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
      .setReadTimeoutMs(READ_TIMEOUT_MS)
      .setAllowCrossProtocolRedirects(true)
    val resolving = ResolvingDataSource.Factory(http, ::resolve)
    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(resolving))
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus = */ true,
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    player.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) = retryRefusedLink(player, error)

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (!isPlaying) return
        val id = player.currentMediaItem?.mediaId ?: return
        retried.remove(id)
        if (retryingId == id) retryingId = null
      }
    })

    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaSession.Builder(this, QueuePlayer(player))
      .setSessionActivity(openApp)
      .setCallback(SessionCallback)
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onDestroy() {
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }

  /** Turns cadence://youtube/<id> into the song's real stream, on ExoPlayer's loading thread. */
  private fun resolve(spec: DataSpec): DataSpec {
    if (spec.uri.scheme != SCHEME) return spec
    val id = spec.uri.lastPathSegment ?: throw IOException("No song in ${spec.uri}")
    val source = try {
      YouTubeAudio.source(id)
    } catch (e: IOException) {
      throw e
    } catch (e: Exception) {
      throw IOException("Couldn't find the audio for $id: ${e.message}", e)
    }
    return spec.buildUpon()
      .setUri(source.url)
      .setHttpRequestHeaders(spec.httpRequestHeaders + source.headers)
      .build()
  }

  /** YouTube refuses a link once it has expired: fetch a fresh one once and carry on. */
  private fun retryRefusedLink(player: ExoPlayer, error: PlaybackException) {
    val id = player.currentMediaItem?.mediaId ?: return
    var cause: Throwable? = error
    while (cause != null && cause !is HttpDataSource.InvalidResponseCodeException) cause = cause.cause
    val code = (cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: return
    if ((code != 403 && code != 410) || !retried.add(id)) return
    Log.w(TAG, "$id: YouTube refused the link (HTTP $code); fetching a fresh one")
    retryingId = id
    YouTubeAudio.forget(id)
    player.prepare()
  }

  /** Songs arrive from the bridge by id; give each its stream address again if it was dropped in transit. */
  private object SessionCallback : MediaSession.Callback {
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> = Futures.immediateFuture(
      mediaItems.map { item ->
        if (item.localConfiguration != null) item else item.buildUpon().setUri(trackUri(item.mediaId)).build()
      }.toMutableList(),
    )
  }

  /** Sends next/previous to the UI's queue instead of this player's short playlist. */
  private class QueuePlayer(player: Player) : ForwardingPlayer(player) {
    private val queueCommands = intArrayOf(
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
    )

    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands().buildUpon().addAll(*queueCommands).build()

    override fun isCommandAvailable(command: Int): Boolean = command in queueCommands || super.isCommandAvailable(command)

    private fun remote(action: String, fallback: () -> Unit) {
      val handler = onRemote
      if (handler != null) handler(action) else fallback()
    }

    override fun seekToNext() = remote("next") { super.seekToNext() }

    override fun seekToNextMediaItem() = remote("next") { super.seekToNextMediaItem() }

    override fun seekToPrevious() = remote("previous") { super.seekToPrevious() }

    override fun seekToPreviousMediaItem() = remote("previous") { super.seekToPreviousMediaItem() }
  }
}
