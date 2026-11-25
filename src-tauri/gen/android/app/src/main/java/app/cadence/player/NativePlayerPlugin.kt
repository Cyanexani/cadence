package app.cadence.player

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SongArgs {
  lateinit var slot: String
  lateinit var url: String
  var title: String = ""
  var artist: String = ""
  var art: String? = null
  var loudnessDb: Double? = null

  fun toSong() = Song(slot, url, title, artist, art, loudnessDb)
}

@InvokeArg
class LoadArgs {
  var gen: Int = 0
  lateinit var slot: String
  lateinit var url: String
  var startSeconds: Double = 0.0
  var autoplay: Boolean = true
  var title: String = ""
  var artist: String = ""
  var art: String? = null
  var loudnessDb: Double? = null
}

@InvokeArg
class QueueArgs {
  var gen: Int = 0
  var repeatOne: Boolean = false
  var items: Array<SongArgs> = arrayOf()
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@InvokeArg
class VolumeArgs {
  var volume: Double = 1.0
}

@InvokeArg
class SleepArgs {
  var seconds: Int = 0
}

@InvokeArg
class FxArgs {
  var normalize: Boolean = false
  var skipSilence: Boolean = false
  var eqOn: Boolean = false
  var gains: IntArray = intArrayOf()
  var bands: IntArray = intArrayOf()
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
    val song = Song(args.slot, args.url, args.title, args.artist, args.art, args.loudnessDb)
    onMain(invoke) { Engine.load(args.gen, song, (args.startSeconds * 1000).toLong(), args.autoplay) }
  }

  @Command
  fun queue(invoke: Invoke) {
    val args = invoke.parseArgs(QueueArgs::class.java)
    val songs = args.items.map { it.toSong() }
    onMain(invoke) { Engine.queue(args.gen, songs, args.repeatOne) }
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
  fun sleep(invoke: Invoke) {
    val args = invoke.parseArgs(SleepArgs::class.java)
    onMain(invoke) { Engine.sleep(args.seconds) }
  }

  @Command
  fun fx(invoke: Invoke) {
    val args = invoke.parseArgs(FxArgs::class.java)
    onMain(invoke) { Engine.fx(args.normalize, args.skipSilence, args.eqOn, args.gains.toList(), args.bands.toList()) }
  }

  @Command
  fun status(invoke: Invoke) {
    Engine.main.post {
      try {
        Engine.init(activity)
        invoke.resolveObject(Engine.status())
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The audio player failed.")
      }
    }
  }
}
