package app.cadence.player

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Wraps the web view client Tauri installs (wry's RustWebViewClient, which serves the app's
 * pages) and adds the one thing it lacks: surviving the loss of the renderer process.
 * Everything else goes to the original client unchanged.
 */
@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class RendererGuardClient(
  private val inner: WebViewClient,
  private val onGone: (WebView, RenderProcessGoneDetail) -> Boolean,
) : WebViewClient() {
  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean =
    inner.onRenderProcessGone(view, detail) || onGone(view, detail)

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    inner.shouldInterceptRequest(view, request)

  override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
    inner.shouldInterceptRequest(view, url)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
    inner.shouldOverrideUrlLoading(view, url)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = inner.onPageStarted(view, url, favicon)

  override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)

  override fun onPageCommitVisible(view: WebView, url: String) = inner.onPageCommitVisible(view, url)

  override fun onLoadResource(view: WebView, url: String) = inner.onLoadResource(view, url)

  override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
    inner.doUpdateVisitedHistory(view, url, isReload)

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
    inner.onReceivedError(view, request, error)

  override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) =
    inner.onReceivedError(view, errorCode, description, failingUrl)

  override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) =
    inner.onReceivedHttpError(view, request, errorResponse)

  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
    inner.onReceivedSslError(view, handler, error)

  override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) =
    inner.onReceivedHttpAuthRequest(view, handler, host, realm)

  override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
    inner.onReceivedClientCertRequest(view, request)

  override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) =
    inner.onReceivedLoginRequest(view, realm, account, args)

  override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
    inner.onFormResubmission(view, dontResend, resend)

  override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) = inner.onScaleChanged(view, oldScale, newScale)

  override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean = inner.shouldOverrideKeyEvent(view, event)

  override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

  override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) =
    inner.onSafeBrowsingHit(view, request, threatType, callback)
}
