package app.cadence.player

import android.util.Log
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPInputStream
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod

/**
 * Finds the best audio stream YouTube offers for a song, using NewPipe Extractor. Stream
 * URLs are signed for a few hours, so answers are cached per video until shortly before then.
 */
object YouTubeAudio {
  private const val TAG = "CadenceAudio"
  private const val YOUTUBE = "https://www.youtube.com"
  /** The same browser NewPipe's own app presents itself as. */
  const val BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"
  private const val CONNECT_TIMEOUT_MS = 15_000
  private const val READ_TIMEOUT_MS = 20_000
  /** YouTube's links last about six hours; refetch well before that. */
  private const val DEFAULT_LIFETIME_MS = 4 * 60 * 60 * 1000L
  private const val EXPIRY_MARGIN_MS = 30 * 60 * 1000L

  /** A playable stream and the request headers YouTube expects with it. */
  data class Source(
    val url: String,
    val codec: String,
    val bitrate: Int,
    val itag: Int,
    val headers: Map<String, String>,
    val expiresAt: Long,
  )

  private val cache = ConcurrentHashMap<String, Source>()
  @Volatile private var initialised = false

  private fun init() {
    if (initialised) return
    synchronized(this) {
      if (!initialised) {
        NewPipe.init(Http, Localization("en", "US"))
        initialised = true
      }
    }
  }

  /** Drop a cached link, e.g. after YouTube refused it. */
  fun forget(videoId: String) {
    cache.remove(videoId)
  }

  fun cached(videoId: String): Source? = cache[videoId]?.takeIf { it.expiresAt > System.currentTimeMillis() }

  /** Blocks on the network: call it off the main thread. */
  fun source(videoId: String): Source {
    cached(videoId)?.let { return it }
    init()
    // Just the player data: StreamInfo would also fetch related videos, comments and the like.
    val extractor = ServiceList.YouTube.getStreamExtractor("$YOUTUBE/watch?v=$videoId")
    extractor.fetchPage()
    val stream = best(extractor.audioStreams) ?: throw IllegalStateException("YouTube offered no playable audio for $videoId")
    val url = stream.content
    val source = Source(
      url = url,
      codec = codecName(stream),
      bitrate = bitrate(stream),
      itag = stream.itag,
      headers = headersFor(url),
      expiresAt = expiry(url),
    )
    Log.i(TAG, "$videoId: ${source.codec} ${source.bitrate / 1000} kbps (itag ${source.itag})")
    cache[videoId] = source
    return source
  }

  private fun bitrate(s: AudioStream): Int = if (s.averageBitrate > 0) s.averageBitrate else s.bitrate.coerceAtLeast(0)

  private fun isOpus(s: AudioStream): Boolean =
    s.format == MediaFormat.WEBMA_OPUS || s.format == MediaFormat.OPUS || s.codec?.contains("opus", ignoreCase = true) == true

  private fun codecName(s: AudioStream): String = when {
    isOpus(s) -> "Opus"
    s.format == MediaFormat.M4A || s.codec?.startsWith("mp4a") == true -> "AAC"
    else -> s.format?.getName() ?: "Audio"
  }

  /** Plain links ExoPlayer can stream directly, in the song's original language. */
  private fun playable(s: AudioStream): Boolean =
    s.isUrl && s.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && s.content.isNotEmpty() &&
      (s.audioTrackType == null || s.audioTrackType == AudioTrackType.ORIGINAL) &&
      (isOpus(s) || s.format == MediaFormat.M4A)

  /** Highest bitrate wins; Opus beats AAC at equal bitrate since it sounds better. */
  fun best(streams: List<AudioStream>): AudioStream? =
    streams.filter(::playable).maxWithOrNull(compareBy<AudioStream>({ bitrate(it) }, { isOpus(it) }))

  private fun headersFor(url: String): Map<String, String> = when {
    YoutubeParsingHelper.isVisionOsStreamingUrl(url) ->
      mapOf("User-Agent" to YoutubeParsingHelper.getVisionOsUserAgent(Localization("en", "US")))
    YoutubeParsingHelper.isWebStreamingUrl(url) ->
      mapOf("User-Agent" to BROWSER_USER_AGENT, "Origin" to YOUTUBE, "Referer" to "$YOUTUBE/")
    else -> mapOf("User-Agent" to BROWSER_USER_AGENT)
  }

  /** The link's own `expire` parameter (unix seconds), less a safety margin. */
  private fun expiry(url: String): Long {
    val now = System.currentTimeMillis()
    val expire = Regex("[?&]expire=(\\d+)").find(url)?.groupValues?.get(1)?.toLongOrNull()
    val until = expire?.let { it * 1000 } ?: (now + DEFAULT_LIFETIME_MS)
    return (until - EXPIRY_MARGIN_MS).coerceAtLeast(now + 60_000)
  }

  /** NewPipe's HTTP client, on the platform's HttpURLConnection. */
  private object Http : Downloader() {
    override fun execute(request: Request): Response {
      val connection = URL(request.url()).openConnection() as HttpURLConnection
      try {
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.instanceFollowRedirects = true
        connection.requestMethod = request.httpMethod()
        var hasUserAgent = false
        for ((name, values) in request.headers()) {
          if (name.equals("User-Agent", ignoreCase = true)) hasUserAgent = true
          for (value in values) connection.addRequestProperty(name, value)
        }
        if (!hasUserAgent) connection.setRequestProperty("User-Agent", BROWSER_USER_AGENT)
        request.dataToSend()?.let { body ->
          connection.doOutput = true
          connection.outputStream.use { it.write(body) }
        }
        val code = connection.responseCode
        if (code == 429) throw ReCaptchaException("YouTube asked for a captcha", request.url())
        val raw: InputStream? = if (code >= 400) connection.errorStream else connection.inputStream
        val stream = if (raw != null && connection.contentEncoding.equals("gzip", ignoreCase = true)) GZIPInputStream(raw) else raw
        val body = stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
        val headers = connection.headerFields.filterKeys { it != null }
        return Response(code, connection.responseMessage ?: "", headers, body, connection.url.toString())
      } finally {
        connection.disconnect()
      }
    }
  }
}
