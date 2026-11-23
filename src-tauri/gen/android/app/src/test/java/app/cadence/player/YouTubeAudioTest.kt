package app.cadence.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.services.youtube.ItagItem
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod

/** Run with `./gradlew testArm64DebugUnitTest` in src-tauri/gen/android. */
class YouTubeAudioTest {
  private fun stream(
    itag: Int,
    format: MediaFormat,
    bitrate: Int,
    delivery: DeliveryMethod = DeliveryMethod.PROGRESSIVE_HTTP,
    isUrl: Boolean = true,
    track: AudioTrackType? = null,
  ): AudioStream = AudioStream.Builder()
    .setId("$itag-${track ?: "default"}")
    .setContent("https://example.invalid/videoplayback?itag=$itag", isUrl)
    .setMediaFormat(format)
    .setDeliveryMethod(delivery)
    .setAverageBitrate(bitrate)
    .setItagItem(ItagItem.getItag(itag))
    .apply { if (track != null) setAudioTrackType(track) }
    .build()

  @Test
  fun picksTheHighestBitrate() {
    val best = YouTubeAudio.best(
      listOf(
        stream(139, MediaFormat.M4A, 48_000),
        stream(251, MediaFormat.WEBMA_OPUS, 141_000),
        stream(140, MediaFormat.M4A, 129_000),
      ),
    )
    assertEquals(251, best?.itag)
  }

  @Test
  fun opusWinsATie() {
    val best = YouTubeAudio.best(listOf(stream(140, MediaFormat.M4A, 128_000), stream(250, MediaFormat.WEBMA_OPUS, 128_000)))
    assertEquals(250, best?.itag)
  }

  @Test
  fun skipsStreamsExoPlayerCannotFetchDirectly() {
    val best = YouTubeAudio.best(
      listOf(
        stream(251, MediaFormat.WEBMA_OPUS, 160_000, delivery = DeliveryMethod.DASH),
        stream(251, MediaFormat.WEBMA_OPUS, 150_000, isUrl = false),
        stream(140, MediaFormat.M4A, 129_000),
      ),
    )
    assertEquals(140, best?.itag)
  }

  @Test
  fun keepsTheOriginalLanguage() {
    val best = YouTubeAudio.best(
      listOf(
        stream(251, MediaFormat.WEBMA_OPUS, 160_000, track = AudioTrackType.DUBBED),
        stream(251, MediaFormat.WEBMA_OPUS, 140_000, track = AudioTrackType.ORIGINAL),
      ),
    )
    assertEquals(140_000, best?.averageBitrate)
  }

  @Test
  fun nothingPlayableMeansNull() {
    assertNull(YouTubeAudio.best(emptyList()))
    assertNull(YouTubeAudio.best(listOf(stream(251, MediaFormat.WEBMA_OPUS, 160_000, delivery = DeliveryMethod.HLS))))
  }
}
