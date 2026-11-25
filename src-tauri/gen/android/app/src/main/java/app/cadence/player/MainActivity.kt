package app.cadence.player

import android.content.res.Configuration
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The playback notification needs this on Android 13+.
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
  }

  override fun onPause() {
    super.onPause()
    // The page decides what plays next when a song ends, so its timers must keep running
    // while the app is in the background (the foreground service keeps the process alive).
    webView?.resumeTimers()
  }

  override fun onStop() {
    super.onStop()
    webView?.resumeTimers()
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // The next song starts when the last one ends, without a tap, so the
    // YouTube player must be allowed to start media on its own.
    webView.settings.mediaPlaybackRequiresUserGesture = false

    // Keep the app clear of the status bar, navigation bar, notch and keyboard,
    // and colour the strips behind them like the app's own background.
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val root = findViewById<View>(android.R.id.content)
    root.setBackgroundColor(if (night) 0xFF0B0D13.toInt() else 0xFFDFE4EF.toInt())
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !night
      isAppearanceLightNavigationBars = !night
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
