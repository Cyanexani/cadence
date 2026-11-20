package app.cadence.player

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Google's own sign-in page, shown inside the app. When it lands on YouTube Music signed in,
 * the session cookies go back to the caller and are then wiped from the web view: YouTube
 * rotates cookies whenever a session is used in a browser, which would invalidate the copy
 * the app keeps.
 */
class GoogleLoginActivity : AppCompatActivity() {
  companion object {
    const val EXTRA_COOKIE = "cookie"
    private const val MUSIC_URL = "https://music.youtube.com"
    private const val LOGIN_URL =
      "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F"
    private const val BAR_PADDING = 24
    private const val TITLE_SIZE_SP = 17f
  }

  private lateinit var webView: WebView
  private var finished = false

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val title = TextView(this).apply {
      text = "Sign in to YouTube Music"
      textSize = TITLE_SIZE_SP
      setTypeface(typeface, Typeface.BOLD)
      layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
    }
    val cancel = Button(this, null, android.R.attr.borderlessButtonStyle).apply {
      text = "Cancel"
      setOnClickListener { finishWith(null) }
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(BAR_PADDING, 0, 0, 0)
      addView(title)
      addView(cancel)
    }

    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    webView = WebView(this).apply {
      layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
          if (!url.startsWith(MUSIC_URL)) return
          val cookie = cookies.getCookie(MUSIC_URL).orEmpty()
          if (cookie.contains("SAPISID=")) finishWith(cookie)
        }
      }
    }
    cookies.setAcceptThirdPartyCookies(webView, true)

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(webView)
    }
    setContentView(root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.canGoBack()) webView.goBack() else finishWith(null)
      }
    })

    webView.loadUrl(LOGIN_URL)
  }

  private fun finishWith(cookie: String?) {
    if (finished) return
    finished = true
    if (cookie != null) setResult(RESULT_OK, Intent().putExtra(EXTRA_COOKIE, cookie))
    else setResult(RESULT_CANCELED)
    // Leave no Google session behind in the shared web view cookie store.
    CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush() }
    webView.stopLoading()
    finish()
  }

  override fun onDestroy() {
    webView.destroy()
    super.onDestroy()
  }
}
