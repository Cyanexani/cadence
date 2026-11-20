package app.cadence.player

import android.app.Activity
import android.content.Intent
import android.webkit.CookieManager
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** Opens Google's sign-in page in [GoogleLoginActivity] and hands the resulting cookies to Rust. */
@TauriPlugin
class GoogleLoginPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun signIn(invoke: Invoke) {
    startActivityForResult(invoke, Intent(activity, GoogleLoginActivity::class.java), "onSignInResult")
  }

  @ActivityCallback
  fun onSignInResult(invoke: Invoke, result: ActivityResult) {
    val cookie = result.data?.getStringExtra(GoogleLoginActivity.EXTRA_COOKIE)
    if (result.resultCode == Activity.RESULT_OK && !cookie.isNullOrEmpty()) {
      val ret = JSObject()
      ret.put("cookie", cookie)
      invoke.resolve(ret)
    } else {
      invoke.reject("Sign-in was cancelled.")
    }
  }

  @Command
  fun clearCookies(invoke: Invoke) {
    CookieManager.getInstance().removeAllCookies {
      CookieManager.getInstance().flush()
      invoke.resolve()
    }
  }
}
