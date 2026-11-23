package app.cadence.player

import android.content.res.Configuration
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  companion object {
    private const val TAG = "Cadence"
    /** Give up rebuilding the page if its renderer keeps dying this fast (a crash loop). */
    private const val RECOVERY_WINDOW_MS = 60_000L
    private const val MAX_RECOVERIES = 3
    private val recoveries = ArrayDeque<Long>()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
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

    // wry attaches its WebViewClient right after this returns.
    webView.post { guardRenderer(webView) }
  }

  /**
   * Android may kill a background web view's renderer to free memory, typically when other
   * apps are opened. Unhandled, that takes the whole app down. Rebuild the page instead; the
   * music carries on in PlaybackService meanwhile.
   */
  private fun guardRenderer(webView: WebView) {
    val inner = webView.webViewClient
    if (inner is RendererGuardClient) return
    webView.webViewClient = RendererGuardClient(inner) { view, detail -> onRendererGone(view, detail) }
  }

  private fun onRendererGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    Log.w(TAG, "Web view renderer gone (crashed=${detail.didCrash()}); rebuilding the page")
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
    val now = SystemClock.elapsedRealtime()
    while (recoveries.isNotEmpty() && now - recoveries.first() > RECOVERY_WINDOW_MS) recoveries.removeFirst()
    recoveries.addLast(now)
    if (recoveries.size > MAX_RECOVERIES) {
      Log.e(TAG, "The page keeps crashing; closing the window (music keeps playing)")
      finish()
    } else {
      recreate()
    }
    return true
  }
}
