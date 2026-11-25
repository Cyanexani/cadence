package app.cadence.player

import android.content.Intent
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Foreground service that keeps the process, and so the music, alive while the app is in the
 * background. media3 shows the playback notification and lock-screen controls for [Engine]'s session.
 */
class PlaybackService : MediaSessionService() {
  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = Engine.mediaSession()

  override fun onCreate() {
    super.onCreate()
    addSession(Engine.mediaSession())
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away stops the music; paused playback has no reason to keep a service.
    Engine.stop()
    stopSelf()
  }
}
