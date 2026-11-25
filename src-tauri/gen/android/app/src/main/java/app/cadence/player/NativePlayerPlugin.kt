package app.cadence.player

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class LoadArgs {
  lateinit var url: String
  var userAgent: String = ""
  var startSeconds: Double = 0.0
  var autoplay: Boolean = true
  var title: String = ""
  var artist: String = ""
  var art: String? = null
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@InvokeArg
class VolumeArgs {
  var volume: Double = 1.0
}

/** The page's audio player: plays the direct audio streams in [Engine], in the background too. */
@TauriPlugin
class NativePlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private fun onMain(invoke: Invoke, block: () -> Unit) {
    Engine.main.post {
      try {
        Engine.init(activity)
        block()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The audio player failed.")
      }
    }
  }

  @Command
  fun load(invoke: Invoke) {
    val args = invoke.parseArgs(LoadArgs::class.java)
    onMain(invoke) {
      Engine.load(args.url, args.userAgent, (args.startSeconds * 1000).toLong(), args.autoplay, args.title, args.artist, args.art)
    }
  }

  @Command
  fun play(invoke: Invoke) = onMain(invoke) { Engine.play() }

  @Command
  fun pause(invoke: Invoke) = onMain(invoke) { Engine.pause() }

  @Command
  fun stop(invoke: Invoke) = onMain(invoke) { Engine.stop() }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    onMain(invoke) { Engine.seek((args.seconds * 1000).toLong()) }
  }

  @Command
  fun volume(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeArgs::class.java)
    onMain(invoke) { Engine.volume(args.volume.toFloat()) }
  }

  @Command
  fun status(invoke: Invoke) {
    Engine.main.post {
      try {
        Engine.init(activity)
        val out = JSObject()
        for ((key, value) in Engine.status()) {
          when (value) {
            null -> Unit
            is Boolean -> out.put(key, value)
            is Int -> out.put(key, value)
            is Double -> out.put(key, value)
            else -> out.put(key, value.toString())
          }
        }
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The audio player failed.")
      }
    }
  }
}
