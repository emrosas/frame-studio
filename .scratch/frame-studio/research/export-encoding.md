# How should exports encode MP4 and GIF in the web app, in Electron and from the CLI?

Research for [issue 14](../issues/14-export-encoding.md). Checked 2026-09-23 on an Apple M1 Pro with macOS 27.0, against Playwright 1.55.0's headless shell (Chromium 140.0.7339.16), Playwright 1.63.0's Chrome Headless Shell 153.0.8010.12, an open-source Chromium 151.0.7880.0 build, Electron 44.4.5 (Chromium 152.0.7977.130), the system WebKit that Safari 27.0 uses, Homebrew ffmpeg 7.1.1, Mediabunny 1.59.1 and gifenc 1.0.3. Google Chrome and Firefox are not installed on this machine and I had no Windows or Linux machine, so those parts rest on source code and docs.

## Question

MP4 and GIF export has to run in three places: the dev CLI, the Electron app and a browser tab. A tab has no ffmpeg, and an Electron bundle with a GPL ffmpeg carries GPL duties. Which encoder path serves all three? The ticket asks six things: where WebCodecs H.264 works, what happens to audio, whether frame count and timing come out exact, what each path costs in licensing and download size, how GIF encoders compare on the `bear-test` frames, and whether one path can serve everything.

## Short answer

Yes for video. WebCodecs `VideoEncoder`, with Mediabunny muxing the chunks into MP4, runs inside the page that draws the frames. That page can be the CLI's headless browser, a hidden Electron window or the user's tab, and the three differ only in where the finished bytes go. I made 43 files from synthetic frames, 36 to 1800 frames at 12, 24 and 30 fps, in four Chromium builds, and 5 more from the real `bear-test` scene. In every one ffprobe counted exactly the frames that went in and the video stream lasted exactly frameCount / fps. In the synthetic files a barcode drawn into each frame also decoded in order, with nothing dropped or repeated.

The browser build decides whether H.264 is there at all. Chromium encodes H.264 with the OS encoder, which is VideoToolbox on macOS and Media Foundation on Windows, or with OpenH264. It compiles OpenH264 in only when `proprietary_codecs` is on, and that means Chrome, Chrome for Testing and Electron. The headless shell from Playwright 1.55.0, which ticket 03 pinned, is an open-source build running SwiftShader GL. It rejected every `avc1` config until I launched it with `--enable-gpu`, and on Linux it would have no H.264 encoder at all. Playwright 1.57 and later download Chrome for Testing instead, and the 1.63.0 headless shell encoded H.264 through OpenH264 without a GPU. Electron 44 had VideoToolbox, OpenH264 and AAC.

Audio needs work whichever path we pick. AAC through `AudioEncoder` exists in Chromium on macOS and Windows and in Safari 26, but not in Chromium on Linux or in Firefox. The encoder doesn't report its 2112 priming samples. A WebCodecs AAC track muxed as it comes plays 44 ms late in ffmpeg and Chromium, while AVFoundation, which QuickTime uses, assumes the 2112 and plays it on time. Only an edit list plus a `roll` sample group, which is what ffmpeg writes, lined up in all three decoders. Mediabunny writes neither for AAC unless we shift the timestamps, and it never writes the roll group. Opus carries its pre-skip in the stream and stayed within 312 samples, 6.5 ms, in every decoder, but Microsoft doesn't list Opus in MP4 among the formats Windows plays.

GIF can live in the page too. Stock gifenc is fast and 4 KB gzipped, but its 5-6-5 bit palette turned the white bear into 251,251,246 and averaged 44.5 dB PSNR against 55.0 dB for ffmpeg's `palettegen`. Keeping gifenc's writer and building the palette in our own code, with exact frequent colours and frame differencing, gave 57.5 dB at 8.3 MB against ffmpeg's 8.0 MB.

On licensing, this path ships no encoder of ours in the web app and needs no ffmpeg in the Electron bundle, which removes the GPL and LGPL questions. Electron itself contains OpenH264 compiled from source. Cisco's patent grant covers only Cisco's own binary downloaded separately by the user, so the H.264 patent position of a shipped Electron app is a question for a lawyer, as it is for every Electron app. ffmpeg.wasm is GPL, 32 MB, and by its own benchmark runs at 4% of native speed, so it's out.

## Where WebCodecs H.264 encoding works

### How Chromium picks an encoder

- `proprietary_codecs` is `is_chrome_branded || is_castos || is_cast_android || is_chrome_for_testing_branded`, so a plain Chromium build has it off ([features.gni#31 at 152.0.7977.130](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/build/config/features.gni#31)).
- OpenH264 is compiled in unless `is_ios || (is_android && current_cpu == "arm") || !proprietary_codecs` ([media_options.gni#70](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/media/media_options.gni#70)). On arm64 desktop it runs plain C++, because its NEON code is built only for ChromeOS ([issue 545486499](https://issues.chromium.org/issues/545486499), [third_party/openh264/BUILD.gn#44](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/third_party/openh264/BUILD.gn#44)).
- The platform encoders aren't gated on `proprietary_codecs`. VideoToolbox is always registered on macOS, and the file defines `SOFTWARE_ENCODING_SUPPORTED BUILDFLAG(IS_MAC)`, so VideoToolbox's software encoder is offered too ([vt_video_encode_accelerator_mac.mm#48](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/gpu/mac/vt_video_encode_accelerator_mac.mm#48)). Media Foundation uses hardware encoders only: "Failed finding a hardware encoder MFT" ([media_foundation_video_encode_accelerator_win.cc#493](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc#493)).
- Linux has VA-API compiled in, but `kAcceleratedVideoEncodeLinux` is `FEATURE_DISABLED_BY_DEFAULT` ([media_switches.cc#808](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/base/media_switches.cc#808)). Chromium's own doc says "VA-API on Linux is not supported, but it can be enabled using the flags below, and it might work on certain configurations" ([vaapi.md#123](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/docs/gpu/vaapi.md#123)). So on Linux, H.264 means OpenH264.
- The OS software encoder is allowed only when no bundled one exists: `return kHasOSSoftwareH264Encoder && !kHasBundledH264Encoder;` with `kHasOSSoftwareH264Encoder = BUILDFLAG(IS_MAC) || BUILDFLAG(IS_ANDROID)` ([supported_types.cc#608](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/base/supported_types.cc#608)).

That gives this mapping for `hardwareAcceleration`, which the spec calls hints that browsers "may ignore ... in some or all circumstances for any reason" ([WebCodecs, HardwareAcceleration](https://w3c.github.io/webcodecs/#enumdef-hardwareacceleration)):

| Build | `prefer-hardware` | `no-preference` | `prefer-software` |
| --- | --- | --- | --- |
| With OpenH264: Chrome, Chrome for Testing, Electron | OS hardware encoder | OS hardware encoder, falling back to OpenH264 | OpenH264 |
| macOS without OpenH264 | VideoToolbox hardware | VideoToolbox, which picks hardware or software | VideoToolbox software |
| Windows or Linux without OpenH264 | OS hardware encoder | OS hardware encoder | Unsupported |

Every VideoToolbox and Media Foundation encoder runs in the GPU process. Playwright's old headless shell appends `--use-gl=angle --use-angle=swiftshader-webgl` unless told otherwise ([headless_content_main_delegate.cc#266 at 140](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/lib/headless_content_main_delegate.cc#266)), and software GL disables accelerated video encode ([gpu_util.cc#492](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/gpu/config/gpu_util.cc#492)). That is why the 1.55.0 shell had no H.264 until `--enable-gpu`. Ticket 03 already showed that `--enable-gpu` with `--disable-accelerated-2d-canvas` keeps the canvas on CPU raster.

Playwright's docs say "Chromium does not have all the codecs that Google Chrome or Microsoft Edge are bundling" ([browsers.md, media codecs](https://playwright.dev/docs/browsers#media-codecs)). Its 1.57 release notes say "Playwright now runs on Chrome for Testing builds rather than Chromium. Headed mode uses `chrome`; headless mode uses `chrome-headless-shell`" ([release notes, 1.57](https://playwright.dev/docs/release-notes#version-157)), and 1.63 extends that to Linux arm64. The 1.63.0 shell's binary contains the OpenH264 encoder strings that the 1.55.0 shell lacks.

### By browser and OS

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Chrome, Chrome for Testing | VideoToolbox, OpenH264 | Media Foundation hardware, OpenH264 | OpenH264 |
| Electron 44 | VideoToolbox, OpenH264 (measured) | Same as Chrome (source) | Same as Chrome (source) |
| Chromium without proprietary codecs | VideoToolbox, only with a GPU process | Media Foundation hardware only | None without the VA-API flag |
| Edge | Chromium path; OpenH264 unverified | Media Foundation; OpenH264 unverified | Unverified |
| Safari 16.4 and later | VideoToolbox | | |
| Firefox 130 and later | VideoToolbox | Media Foundation | System ffmpeg with libx264, if installed |

- Electron sets `ffmpeg_branding = "Chrome"` and `proprietary_codecs = true` ([all.gn#L20 at v44.4.5](https://github.com/electron/electron/blob/v44.4.5/build/args/all.gn#L20)). Its release build keeps ffmpeg as a separate shared library for "users ... who have an LGPL requirement" ([release.gn](https://github.com/electron/electron/blob/main/build/args/release.gn)). The 44.4.5 `LICENSES.chromium.html` lists OpenH264 under Cisco's BSD licence, and the Electron Framework binary contains the OpenH264 encoder.
- Safari added "the video portion of Web Codecs API" in 16.4 ([WebKit blog](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)). WebKit accepts `avc1.` but not `avc3.` for encoding, and forwards neither `hardwareAcceleration` nor `bitrateMode` to the encoder ([WebCodecsVideoEncoder.cpp#L77](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.cpp#L77)). H.264 goes through libwebrtc's VideoToolbox encoder with frame reordering off, so there are no B-frames ([RTCVideoEncoderH264.mm#L820](https://github.com/WebKit/WebKit/blob/main/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCVideoEncoderH264.mm#L820)).
- Firefox 130 "Enabled the Web Codecs API on desktop platforms" ([release notes](https://www.mozilla.org/en-US/firefox/130.0/releasenotes/)). Its Apple encoder module handles H.264 only ([AppleEncoderModule.cpp#L25](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/platforms/apple/AppleEncoderModule.cpp#L25)). Its bundled ffvpx has `CONFIG_LIBX264_ENCODER 0` and `CONFIG_LIBOPENH264_ENCODER 0` ([config_components_audio_video.h](https://github.com/mozilla-firefox/firefox/blob/main/media/ffvpx/config_components_audio_video.h)), so Linux relies on the system's libavcodec: "Prioritize libx264 for now since it's the only h264 codec we tested" ([FFmpegDataEncoder.cpp#L79](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/platforms/ffmpeg/FFmpegDataEncoder.cpp#L79)). The OpenH264 plugin encoder is off by default, `media.gmp.encoder.enabled: false` ([StaticPrefList.yaml](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml)).
- MDN's compat data gives `VideoEncoder` as Chrome 94, Edge mirroring Chrome, Firefox 130 and Safari 16.4, with no Firefox for Android ([VideoEncoder.json](https://github.com/mdn/browser-compat-data/blob/main/api/VideoEncoder.json)).

### Does isConfigSupported tell the truth?

The spec only promises best effort: "User Agents describe support on a best-effort basis given the resources that are available at the time of the query" ([Check Configuration Support](https://w3c.github.io/webcodecs/#check-configuration-support)). `configure()` runs the check again, and "If supported is false, queue a task to run the Close VideoEncoder algorithm with NotSupportedError" ([configure](https://w3c.github.io/webcodecs/#dom-videoencoder-configure)).

In Chromium the hardware branch compares the config against a static list of supported profiles, sizes and frame rates and creates no encoder. The software branch creates an OpenH264 encoder and initializes it ([video_encoder.cc#1729 at 151](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/third_party/blink/renderer/modules/webcodecs/video_encoder.cc#1729)). The tracker has cases where "supported" was wrong. An Intel Mac failed to encode `avc1.4d0028` at 568x320 ([40245635](https://issues.chromium.org/issues/40245635)). The macOS AAC encoder crashed the GPU process in Chrome 151 while `isConfigSupported` still said yes ([549893457](https://issues.chromium.org/issues/549893457)). Windows hardware answered no above 1080p30 ([40249559](https://issues.chromium.org/issues/40249559)).

In my runs every Chromium and Electron answer held. Each config reported as supported encoded five 1080p frames, and each one reported as unsupported failed at `configure()`. WebKit is looser. It said yes to `avc1.42E01E`, Baseline level 3.0, at 1920x1080, which Chromium rejects. It also returned the same answer for all three `hardwareAcceleration` values. So the export code should treat a yes as a hint, run `configure()`, and report the first `error` callback clearly.

### Profiles, levels and sizes

- The codec string is `avc1.` plus six hex digits for profile_idc, constraint flags and level_idc ([AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [RFC 6381 section 3.4](https://www.rfc-editor.org/rfc/rfc6381#section-3.4)). `avc1.640028` is High profile, level 4.0.
- Chromium checks only the frame size against the level: `max_coded_area = media::H264LevelToMaxFS(config->level) * 16ull * 16ull` ([video_encoder.cc#496 at 140](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/modules/webcodecs/video_encoder.cc#496)). Level 3.0 allows 1620 macroblocks, and 1920x1080 codes as 1920x1088, which is 8160. So `avc1.42E01E` fails with "exceeds the maximum coded area (414720) supported by the AVC level (3.0)". Level 4.0 allows 8192 macroblocks and 245760 per second, about 30.1 fps at 1080p ([h264_level_limits.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/parsers/h264_level_limits.cc)).
- The encoders choose their own level. VideoToolbox uses the `_AutoLevel` profile constants, and `decoderConfig.codec` just echoes the string we passed in. The avcC in `decoderConfig.description` is the truth, and every file I made carried High profile at level 4.0 there.
- VideoToolbox caps H.264 at 4096x2304 and 120 fps ([vt_video_encode_accelerator_mac.mm#132](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/gpu/mac/vt_video_encode_accelerator_mac.mm#132), [#56](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/gpu/mac/vt_video_encode_accelerator_mac.mm#56)). Media Foundation's default cap is 1920x1080 at 30 fps ([mf_video_encoder_util.h#34](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/gpu/windows/mf_video_encoder_util.h#34)), so 1080p30 sits exactly at the edge on Windows hardware. OpenH264 answered no between 3840x2440 and 3840x2540 in [414645305](https://issues.chromium.org/issues/414645305).
- Baseline, Main and High at level 4.0 or above, at 1920x1080, at 12, 24 and 30 fps, were supported and encoded in every build that had an H.264 encoder at all.

## Audio

### Which codecs AudioEncoder offers

- Chromium implements Opus and AAC only, and anything else is "Unsupported codec type" ([audio_encoder.cc at 151](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/third_party/blink/renderer/modules/webcodecs/audio_encoder.cc)). FLAC answered no everywhere I tried.
- Opus is libopus in the renderer, on every platform. It writes an OpusHead with pre-skip from `OPUS_GET_LOOKAHEAD` ([audio_opus_encoder.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/audio/audio_opus_encoder.cc)).
- AAC comes from the OS encoder. `kPlatformAudioEncoder` is enabled by default on Windows, macOS and Android and disabled elsewhere ([media_switches.cc#510](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/base/media_switches.cc#510)). The Linux path is `NOTIMPLEMENTED(); return nullptr;` ([gpu_mojo_media_client.cc#253](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/mojo/services/gpu_mojo_media_client.cc#253)). So no Chromium build on Linux encodes AAC, Chrome and Electron included. On macOS the encoder is AudioToolbox, and it has no `proprietary_codecs` gate, which is why the open-source 151 build and the 1.55.0 shell both encoded AAC while unable to decode it.
- Chromium accepts AAC at 44100 or 48000 Hz with 1, 2 or 6 channels. Windows also restricts the bitrate to 96, 128, 160 or 192 kbps. The output is always AAC-LC, even when `mp4a.40.5` is requested (`kMPEG4Object_AAC_LC` in [audio_toolbox_audio_encoder.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.176/media/filters/mac/audio_toolbox_audio_encoder.cc)).
- Safari 26 added `AudioEncoder` ([WebKit blog](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)) and accepts `mp4a.40.2` and `opus` ([WebCodecsAudioEncoder.cpp#L84](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsAudioEncoder.cpp#L84)).
- Firefox encodes only `opus` and `vorbis` ([AudioEncoder.cpp#L149](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webcodecs/AudioEncoder.cpp#L149)).

48 kHz stereo, as settled in ticket 04, fits every encoder that exists.

### Priming decides audio sync

An AAC encoder emits priming samples before the real audio. Apple's note says "the most common delay used was 2112 audio samples" and recommends that decoders "assume there is an encoding delay of 2112 samples" ([TN2258](https://developer.apple.com/library/archive/technotes/tn2258/_index.html)). Apple's file format docs signal it with an edit list whose media time is 2112 plus a `roll` sample group, and add that "You cannot use the edit list by itself to determine the encoder delay ... The sample group atoms provide the encoder delay" ([QTFF, representing encoder delay explicitly](https://developer.apple.com/documentation/quicktime-file-format/example_representing_encoder_delay_explicitly)).

WebCodecs gives the muxer no way to know. Chromium's AudioToolbox and Media Foundation encoders stamp the first chunk at 0 and never query the priming count. The spec issue is still open, with dalecurtis for Chromium writing "Chrome doesn't do anything today for this" and padenot for Mozilla writing on 2026-09-03 "We're going to make an updated proposal on this one" ([w3c/webcodecs#626](https://github.com/w3c/webcodecs/issues/626)).

I measured the effect with a 10 ms burst placed at every whole second (see [Audio alignment](#audio-alignment)). A WebCodecs AAC track muxed as it comes decoded 2112 samples late, 44 ms, in ffmpeg and in Chromium's `decodeAudioData`. That is more than a frame at 24 and 30 fps, and it breaks M7's one-frame rule. AVFoundation assumed 2112 and got it right. Shifting the packets back by 2112 made Mediabunny write an edit list, which fixed ffmpeg and Chromium, but AVFoundation then skipped the priming twice and played 44 ms early. Remuxing that file with `ffmpeg -c copy` added the `sgpd` and `sbgp` roll boxes, and then all three decoders agreed to within one sample. The offset stayed at 2111 or 2112 samples for all 120 seconds of the long run, so it doesn't drift.

Opus behaves better. The OpusHead's pre-skip travels in the `dOps` box, and ffmpeg and Chromium honour it, so Mediabunny's Opus file was exact there. AVFoundation ignored pre-skip without an edit list and played 312 samples late, 6.5 ms. ffmpeg's own Opus file has both an edit list and pre-skip, and Chromium applied both and played 312 samples early. The Opus-in-ISOBMFF draft says pre-skip "is informative only, and that task falls on the Edit List Box" ([Opus in ISOBMFF 0.6.8](https://opus-codec.org/docs/opus_in_isobmff.html)), and that draft has been "incomplete" since 2016. Every Opus error I saw was under one frame even at 60 fps.

### Opus in MP4 playback

Safari 17 "adds support for one or two channel Opus audio in WebM and MPEG-4 containers" ([WebKit blog](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)), and AVFoundation on macOS 27 reported the Mediabunny Opus file as playable and decoded it. Chromium always allows Opus in MP4. Microsoft's list of formats Media Foundation plays in MPEG-4 names AAC, ALAC, FLAC, MP3 and AC-3 but not Opus ([supported media formats](https://learn.microsoft.com/en-us/windows/win32/medfound/supported-media-formats-in-media-foundation)). AAC is the safer choice for a file that people download and open, as long as we signal the priming ourselves.

## Timing

WebCodecs copies each `VideoFrame`'s timestamp and duration onto its chunk: "Let timestamp be the [[timestamp]] from the VideoFrame associated with output" ([output EncodedVideoChunks](https://w3c.github.io/webcodecs/#output-encodedvideochunks)). With `latencyMode: 'quality'`, the default, the encoder "MUST not drop frames" ([LatencyMode](https://w3c.github.io/webcodecs/#enumdef-latencymode)).

Timestamps are integer microseconds, and 1e6 / 12 isn't an integer. `VideoFrameInit` declares `long long timestamp` without `[EnforceRange]` ([VideoFrameInit](https://w3c.github.io/webcodecs/#dictdef-videoframeinit)), so WebIDL truncates the fraction ([ConvertToInt](https://webidl.spec.whatwg.org/#abstract-opdef-converttoint)). I saw exactly that: passing 2 × 1e6 / 12 gave a chunk timestamp of 166666. Rounding ourselves gives 166667.

The muxer then decides the file's clock. Mediabunny's `frameRate` track option means "all timestamps and durations of this track will be snapped to this frame rate" (`mediabunny.d.ts` in 1.59.1, and the [writing media files guide](https://github.com/Vanilagy/mediabunny/blob/main/docs/guide/writing-media-files.md)). With `frameRate: 12` it chose a timescale of 12, wrote one `stts` entry of 36 samples at 1 tick each, and kept the last sample's duration. Without the option it used its default timescale of 57600, "LCM of a bunch of common frame rates", and even the truncated timestamps rounded to exactly 4800 ticks at 12 fps and 1920 at 30 fps. Both came out constant frame rate with `r_frame_rate` equal to `avg_frame_rate`.

So exact frame count and duration are reachable on every path I tested. Round the timestamps anyway and pass `frameRate`, so the file doesn't depend on the muxer's rounding.

The container's duration is the longest track's. With AAC as it comes, the audio track ran 3.072 s against 3.000 s of video, which is the priming plus the padding of the last 1024-sample packet. With Opus it ran 3.020 s. ffmpeg's native AAC file came out at exactly 3.000 s because its edit list trims both ends. M3's duration check should read the video stream, and M7's muxer step should set the audio edit list's duration to the scene duration.

GIF has its own clock. The delay field counts "hundredths (1/100) of a second" ([GIF89a](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)), so 12 fps can't be exact per frame. Both ffmpeg and my gifenc writer used 8, 8 and 9 centiseconds in turn, 64 frames at 8 and 32 at 9, for exactly 8.00 s over 96 frames. The rule is `delay(i) = round((i + 1) * 100 / fps) - round(i * 100 / fps)`.

## Licensing and size

### ffmpeg as a binary

- A default ffmpeg build is LGPL. "None of these parts are used by default, you have to explicitly pass `--enable-gpl`", and libx264 and libx265 require it ([LICENSE.md](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)). Homebrew's ffmpeg 7.1.1 on this Mac is `--enable-gpl --enable-version3 --enable-libx264` and prints GPL version 3 under `ffmpeg -L`.
- ffmpeg's LGPL checklist includes "Compile FFmpeg without "--enable-gpl" and without "--enable-nonfree"", "Use dynamic linking", "Distribute the source code of FFmpeg, no matter if you modified it or not" and "Make sure your program is not using any GPL libraries (notably libx264)" ([legal.html](https://ffmpeg.org/legal.html)).
- A GPL binary inside an Electron bundle means shipping its source or a written offer valid for three years, plus the licence text ([GPLv2 sections 1 and 3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt)). Calling it as a separate program keeps our MIT code MIT, since "pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs" ([GPL FAQ, mere aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)).
- Running a GPL ffmpeg on our own server isn't distribution. "The GPL permits anyone to make a modified version and use it without ever distributing it to others", and only the Affero GPL changes that ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods)).
- An LGPL build can still encode H.264 through the OS. `h264_videotoolbox` with `aac_at` worked here and needs no GPL component.
- x264 is also sold under a commercial licence ([x264 page](https://www.videolan.org/developers/x264.html)).

The recommended path bundles no ffmpeg. Electron's own `libffmpeg` reports "libavcodec license: LGPL version 2.1 or later", and Chromium's build config for Chrome branding compiles in no encoders or muxers ([config_components.h for mac arm64](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/refs/heads/master/chromium/config/Chrome/mac/arm64/config_components.h)), so it can't be used for export anyway.

### H.264 patents

Via LA's AVC page covers encoder and decoder units "sold to End Users and OEMs": "For the first 1 to 100,000 units: $0.00", then $0.20 each up to 5 million, then $0.10, with a cap of "$9.75M per year" ([Via LA AVC/H.264](https://www.via-la.com/licensing-programs/avc-h-264/)). It adds that "The actual License agreement provides the only definitive and reliable statement of license terms." A 2022 briefing on Via LA's site says "Internet Broadcast AVC Video (not title-by-title, not subscription) – no royalty for life of the AVC Patent Portfolio License" ([avcweb.pdf](https://via-la.com/wp-content/uploads/2025/09/avcweb.pdf)). The 2026 page no longer shows that line.

What that means for each path, as my reading and not legal advice:

- Our own encoder. Bundled x264, OpenH264 compiled into Electron, and ffmpeg.wasm served to browsers all put an H.264 encoder in our distribution. That falls under the per-unit terms. Whether a free, open-source download counts as "sold", and whether the zero-cost tier still needs a signed licence, I couldn't confirm.
- The OS encoder. "Apple Inc." and "Microsoft Corporation" are on Via LA's list of "Licensees and affiliates in good standing", though the page warns that "no conclusion may be drawn from this list that any particular products they manufacture are licensed". Both OS licences pass the use limit to the user. macOS says "THE AVC FUNCTIONALITY IN THIS PRODUCT IS LICENSED HEREIN ONLY FOR THE PERSONAL AND NON-COMMERCIAL USE OF A CONSUMER" ([macOS Tahoe licence, section D](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)), and Windows 11 has the same wording in section 14.b ([Windows 11 terms](https://www.microsoft.com/content/dam/microsoft/usetm/documents/windows/11/oem-(pre-installed)/UseTerms_OEM_Windows_11_English.pdf)). So the OS vendor covers the encoder, and the use restriction falls on the user.
- Our server. No Via LA category clearly covers a service that encodes files for users. That is a question for Via LA.

### Cisco's OpenH264

Cisco pays the royalty for its own binary only when "The Cisco-provided binary is separately downloaded to an end user's device, and not integrated into or combined with third party software prior to being downloaded", the user can enable and disable it, and the app shows "OpenH264 Video Codec provided by Cisco Systems, Inc." ([BINARY_LICENSE.txt](http://www.openh264.org/BINARY_LICENSE.txt)). The FAQ adds that a team using the source "is responsible for paying all applicable license fees" ([OpenH264 FAQ](https://www.openh264.org/faq.html)). Chromium and Electron build OpenH264 from source, so Cisco's coverage doesn't reach them. The grant itself is limited to "THE PERSONAL USE OF A CONSUMER OR OTHER USES IN WHICH IT DOES NOT RECEIVE REMUNERATION".

For us, that means Electron's compiled-in OpenH264 is in the same position as bundling our own encoder. Preferring VideoToolbox or Media Foundation at run time doesn't remove OpenH264 from the binary. Downloading Cisco's binary at install time would satisfy Cisco's terms, but Chromium links OpenH264 in from `third_party/openh264`, and I found no way to make it load Cisco's binary instead.

### Download size

| Piece | Licence | Minified | Gzipped |
| --- | --- | --- | --- |
| Mediabunny, MP4 output with packet sources | MPL-2.0 | 120,130 B | 32,500 B |
| Mediabunny with `CanvasSource` and `AudioBufferSource` | MPL-2.0 | 216,454 B | 54,992 B |
| mp4-muxer 5.2.2, deprecated | MIT | 31,202 B | 9,116 B |
| gifenc 1.0.3 | MIT | 9,782 B | 4,220 B |
| ffmpeg.wasm `@ffmpeg/core` 0.12.10 wasm | GPL-2.0-or-later | 32,232,419 B | 10,184,930 B |
| Current viewer bundle, for scale | | 245,832 B | |

- Mediabunny's README says it is MPL-2.0, "a very permissive weak copyleft license", with the one duty to publish changes to its own files ([Mediabunny README](https://github.com/Vanilagy/mediabunny)). Remotion sponsors it, but it isn't an animation library and doesn't pull Remotion in. mp4-muxer's npm notice says it "is superseded by Mediabunny" ([mp4-muxer](https://github.com/Vanilagy/mp4-muxer)).
- gifenc is MIT and has "no dithering support" ([gifenc](https://github.com/mattdesl/gifenc)). gifski, a well-known higher-quality encoder with a wasm build, is "AGPL 3 or later" ([gifski](https://github.com/ImageOptim/gifski)), which would reach any server or page that ships it.
- ffmpeg.wasm's core is built with `--enable-gpl --enable-libx264 --enable-libx265` ([Dockerfile](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/Dockerfile)). Its benchmark shows the single-thread core at 0.04x native ([performance.md](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/performance.md)). The multi-threaded core needs `SharedArrayBuffer`, which needs cross-origin isolation, and it dropped Node support in 0.12.
- Sizes were measured with esbuild 0.28.2 using `--bundle --minify --format=esm`. A research helper measured the larger Mediabunny bundle, mp4-muxer and ffmpeg.wasm in a separate run with the same tools. I measured the other rows.

Both libraries are export tooling. They belong in the viewer's export module or `tools/`, never in `src/engine`, `src/rigs`, `src/audio` or the single-file embed, and the viewer can load them lazily when an export starts.

## GIF

On `bear-test` (96 frames, 12 fps), ffmpeg's `palettegen` and `paletteuse` did well. Its error sat at shape edges and the colours stayed exact. On the half-size copy, dithering cost 0.6 dB and made the file 6% bigger, because this art is mostly flat fills and the mottled orange ground is subtle. Per-frame palettes gained under 1 dB and made the file 3.5 times bigger. `stats_mode=diff` with Bayer dithering lost 7 dB.

Stock gifenc was the weak one. Its quantizer works on 5-6-5 bit colour, so pure white became 251,251,246 and the polar bear took on a cream tint, visible side by side at 1:1. An amplified difference image also showed the mottle blobs in the ground stepping into contours. Its 4-4-4 mode kept white close but lost 6 dB more. All GIFs came out at 6 to 8 MB for 8 seconds at 1080p and about 2.4 to 3.3 MB at 960x540, except the per-frame palette files.

The hard gouache still, `bears-gouache` at 1080x1920 with 16,979 distinct colours, ranked the same way: ffmpeg 47.3 dB, stock gifenc 45.2 dB.

The fix is small. gifenc's `GIFEncoder` does the LZW and file writing well, and it accepts any palette and index array. My test builder took the 128 most frequent exact colours from a sample of every fourth frame, filled the remaining 127 slots with gifenc's quantizer, mapped each pixel to its nearest entry with a per-colour cache, and marked pixels unchanged since the previous frame with a transparent index. That scored 57.5 dB at 1080p and 51.1 dB on the gouache still, beating ffmpeg on both, with white exact and no contour blobs in the difference image. Without frame differencing the same file was 30 MB, so the transparency step matters for size.

## Colour metadata

This wasn't asked, but it affects every MP4 a user opens in QuickTime. The WebCodecs encoders tag their output differently, and AVFoundation colour-manages by those tags. I decoded the `#ffa200` ground of frame 40 in each file:

| File | `colr` primaries, transfer, matrix, full range | ffmpeg decode | AVFoundation decode |
| --- | --- | --- | --- |
| Chromium 140 VideoToolbox | 6, 1, 6, no | 254,162,0 | 250,172,0 |
| Electron 44 OpenH264 | 6, 6, 6, no | 254,162,0 | 250,172,0 |
| Chrome Headless Shell 153 OpenH264 | 1, 13, 1, yes | 255,162,0 | 255,162,0 |
| ffmpeg libx264, untagged | none | 254,162,0 | 255,172,0 |
| ffmpeg libx264 tagged BT.709 with `+write_colr` | 2, 2, 1, no | 254,162,0 | 254,172,0 |

The last row came from `-vf scale=out_color_matrix=bt709:out_range=tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -movflags +write_colr`, yet ffmpeg 7.1.1 wrote 2, meaning unspecified, for primaries and transfer. Only the file tagged with BT.709 primaries, the sRGB transfer and full range decoded exactly in AVFoundation. The others shifted the orange by 10 levels of green. ffmpeg decoded every file within one level, which fits its RGB conversion applying the matrix and range but not the primaries. I didn't trace why Chromium 153 tags differently from 152. This needs its own ticket before M3's MP4 is called done.

## One path or a split?

One path works: the render page encodes its own frames with WebCodecs and Mediabunny, and writes GIFs with gifenc and our palette code. Each shell only supplies the page and a place to put bytes.

- The CLI runs Playwright's headless shell. It calls `renderFrame(n)` as M3 already plans, and the page hands encoded bytes to Node, which writes the file. This needs Playwright 1.57 or later for OpenH264, or 1.55 with `--enable-gpu` on macOS only.
- Electron runs the same page in a hidden `BrowserWindow`, or the visible viewer, and sends bytes over IPC to the main process.
- The web app runs it in the user's tab and saves with a download or the File System Access API. Where `isConfigSupported` says no, the future backend runs the same page in the same pinned headless shell on a server.

The frames and the encoder then match within each shell, which is what ADR 0001 already promises for pixels.

The cheaper-looking split, ffmpeg for the CLI and Electron and WebCodecs for the browser, means two muxers, two timing paths, two sets of colour tags and two audio priming rules to keep in step. It also brings back the ffmpeg bundling question for Electron, and a Linux user of the CLI would need a system ffmpeg. The one split I'd accept is on the server later, where a GPL ffmpeg has no distribution duties, if the backend ever needs something WebCodecs can't do.

## Experiments

### Setup

Everything ran from `/tmp/fs-encode`, outside the repo, with `mediabunny@1.59.1`, `gifenc@1.0.3`, `pngjs@7.0.0` and `esbuild@0.28.2`. A small Node server served the test pages on `127.0.0.1:8123`, a secure context, and accepted `POST /save` to write files.

| Label | Binary and launch |
| --- | --- |
| hs140 | `chromium_headless_shell-1187/chrome-mac/headless_shell --remote-debugging-port=<p> --user-data-dir=/tmp/<dir> --disable-accelerated-2d-canvas --disable-skia-runtime-opts` |
| hs140 gpu | Same plus `--enable-gpu` |
| c151 | `/Applications/Chromium.app/Contents/MacOS/Chromium --headless=new`, Chromium 151.0.7880.0, open-source build |
| hs153 | `PLAYWRIGHT_BROWSERS_PATH=/tmp/fs-pw163/browsers npx playwright@1.63.0 install chromium-headless-shell`, then `chrome-headless-shell` with the hs140 flags |
| e44 | `npm i electron@44` gave 44.4.5. A `BrowserWindow({ show: false })` loaded the same pages. The host shell sets `ELECTRON_RUN_AS_NODE=1`, so it had to be unset |
| WebKit | A Swift command-line host with a `WKWebView`, calling `callAsyncJavaScript` |

The video probe config was `{ codec, width: 1920, height: 1080, framerate, bitrate: 8_000_000, hardwareAcceleration, avc: { format: 'avc' } }`. The audio probe was `{ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }`. For each answer, the probe also configured a real encoder and encoded five frames, or one second of sine for audio.

The MP4 test drew procedural 1920x1080 frames on an `OffscreenCanvas` with `{ willReadFrequently: true, colorSpace: 'srgb', alpha: false }`. Each frame had a gradient, 400 translucent dots, a moving disc, and a 12-bit barcode of the frame index in 80 px blocks. The core loop:

```js
const vsrc = new EncodedVideoPacketSource('avc');
output.addVideoTrack(vsrc, { frameRate: fps });
const enc = new VideoEncoder({
  output: (chunk, meta) => { const p = EncodedPacket.fromEncodedChunk(chunk); queue = queue.then(() => vsrc.add(p, meta)); },
  error: (e) => { vError = String(e); },
});
enc.configure({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8_000_000, framerate: fps,
  hardwareAcceleration, avc: { format: 'avc' }, latencyMode: 'quality' });
for (let f = 0; f < frames; f++) {
  drawFrame(ctx, f, fps);
  const frame = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
  while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
  enc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
  frame.close();
}
await enc.flush(); await queue; await output.finalize(); // Output uses Mp4OutputFormat({ fastStart: 'in-memory' }) and BufferTarget
```

The audio was rendered as M7 would render it, with an `OfflineAudioContext` at 48000 Hz stereo: a 220 Hz sine at gain 0.05, plus one buffer holding a 10 ms, 1 kHz burst at amplitude 0.8 at every whole second. That keeps the fan-in at two. `AudioEncoder` got it in 4800-frame `AudioData` blocks.

Verification, per file:

```sh
ffprobe -v error -count_frames -show_entries stream=codec_name,profile,level,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_frames,nb_read_frames -of json f.mp4
ffmpeg -v error -i f.mp4 -f null -          # plays cleanly when this prints nothing
ffprobe -v error -select_streams v:0 -show_entries frame=pts,duration -of csv=p=0 f.mp4
ffmpeg -v error -i f.mp4 -map 0:v:0 -fps_mode passthrough -vf crop=960:80:40:40,scale=12:1:flags=area -f rawvideo -pix_fmt gray -   # 12 bytes per frame, threshold 128, read the index
ffmpeg -v error -i f.mp4 -map 0:a:0 -ac 1 -ar 48000 -f f32le -   # first sample above 0.3 after each second
```

The burst starts at sample 48000 and first exceeds 0.3 at 48003, so 48003 is "on time". AVFoundation was checked with a Swift tool using `AVURLAsset.load(.isPlayable)`, `AVAssetReaderTrackOutput` to 48 kHz mono float, and `AVAssetImageGenerator` for colour. Chromium's decoder was checked with `decodeAudioData` in Electron 44.

### Support answers

1920x1080 at 30 fps, answers for `no-preference / prefer-hardware / prefer-software`. The answers at 12 and 24 fps were identical.

| Config | hs140 | hs140 gpu | c151 | hs153 | e44 | WebKit |
| --- | --- | --- | --- | --- | --- | --- |
| avc1.42E028, .4D4028, .640028, .640033 | no/no/no | yes/yes/yes | yes/yes/yes | yes/no/yes | yes/yes/yes | yes/yes/yes |
| avc1.640033 at 4096x2304 | no/no/no | yes/yes/yes | yes/yes/yes | yes/no/yes | yes/yes/yes | not run |
| avc1.42E01E, level 3.0 | no, NotSupportedError | no | no | no | no | yes/yes/yes |
| vp09.00.40.08 | yes/no/yes | yes/no/yes | yes/no/yes | yes/no/yes | yes/no/yes | yes/yes/yes |
| av01.0.08M.08 | yes/no/yes | yes/no/yes | yes/no/yes | yes/no/yes | yes/no/yes | no/no/no |
| AudioEncoder mp4a.40.2, 48 kHz stereo | yes | yes | yes | yes | yes | yes |
| AudioEncoder opus | yes | yes | yes | yes | yes | yes |
| AudioEncoder flac | no | no | no | no | no | no |
| Can decode avc1 and AAC | no | no | no | yes | yes | not run |

Every 1080p "yes" in the Chromium columns encoded five frames, and every 1080p "no" failed at `configure()` with `OperationError: Encoder creation error` or the level `NotSupportedError`. Electron's `prefer-software` runs printed `[OpenH264] ... Warning: bEnableFrameSkip = 0` to stderr. In the WebKit host, VP9 encoded five frames in 130 ms, but `avc1.640028` and `avc1.42E01E` produced no chunk and no error within 15 s, with the window hidden and shown. I read that as a limit of an unsigned command-line WebKit host, not as Safari's behaviour, and didn't test Safari itself.

### MP4 encode results

Synthetic frames, 1920x1080, `avc1.640028`, 8 Mbps target. Every file listed played cleanly, was High profile at level 4.0, had `nb_read_frames` equal to the frames sent, decoded its barcodes as 0 to N-1 in order, and had one PTS step throughout.

| Build, setting | Encoder | Frames and fps | ms per frame | Bytes | Video duration | r and avg frame rate | Time base |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hs140 gpu, no-preference | VideoToolbox | 36 at 12 | 11.7 | 997,496 | 3.000000 | 12/1, 12/1 | 1/12 |
| hs140 gpu, prefer-software | VideoToolbox software | 36 at 12 | 24.5 | 1,745,614 | 3.000000 | 12/1, 12/1 | 1/12 |
| hs140 gpu, no-preference | VideoToolbox | 72 at 24 | 11.5 | 1,439,256 | 3.000000 | 24/1, 24/1 | 1/24 |
| hs140 gpu, no-preference | VideoToolbox | 90 at 30 | 11.6 | 1,583,851 | 3.000000 | 30/1, 30/1 | 1/30 |
| hs140 gpu, truncated timestamps, no `frameRate` | VideoToolbox | 36 at 12 | 11.5 | 985,911 | 3.000000 | 12/1, 12/1 | 1/57600 |
| hs140 gpu, truncated timestamps, no `frameRate` | VideoToolbox | 90 at 30 | 11.5 | 1,572,266 | 3.000000 | 30/1, 30/1 | 1/57600 |
| hs140 gpu, Mediabunny `CanvasSource` | VideoToolbox | 36 at 12 | 11.2 | 997,496 | 3.000000 | 12/1, 12/1 | 1/12 |
| hs140 gpu, no-preference | VideoToolbox | 1440 at 12 | 11.4 | 99,916,576 | 120.000000 | 12/1, 12/1 | 1/12 |
| hs140 gpu, prefer-software | VideoToolbox software | 1800 at 30 | 16.2 | 61,777,589 | 60.000000 | 30/1, 30/1 | 1/30 |
| c151, no-preference | VideoToolbox | 36 at 12 | 10.5 | 997,496 | 3.000000 | 12/1, 12/1 | 1/12 |
| c151, prefer-software | VideoToolbox software | 36 at 12 | 21.8 | 1,745,614 | 3.000000 | 12/1, 12/1 | 1/12 |
| e44, no-preference | VideoToolbox | 36 at 12 | 10.4 | 997,432 | 3.000000 | 12/1, 12/1 | 1/12 |
| e44, prefer-software | OpenH264 | 36 at 12 | 16.7 | 1,971,028 | 3.000000 | 12/1, 12/1 | 1/12 |
| e44, no-preference | VideoToolbox | 1440 at 12 | 10.2 | 99,913,617 | 120.000000 | 12/1, 12/1 | 1/12 |
| e44, prefer-software | OpenH264 | 1800 at 30 | 10.8 | 45,525,491 | 60.000000 | 30/1, 30/1 | 1/30 |
| hs153, no-preference | OpenH264 | 36 at 12 | 16.6 | 2,125,419 | 3.000000 | 12/1, 12/1 | 1/12 |
| hs153, no-preference | OpenH264 | 90 at 30 | 12.9 | 2,634,303 | 3.000000 | 30/1, 30/1 | 1/30 |
| ffmpeg libx264, `-crf 18`, native AAC | x264 | 36 at 12 | | 1,174,682 | 3.000000 | 12/1, 12/1 | 1/12288 |

The 24 and 30 fps runs, the Opus runs and the shifted AAC runs were repeated in c151, e44 and hs153 with the same frame counts and durations. The libx264 files used B-frames, so their video track has an edit list with media time 2048 at timescale 12288. The WebCodecs files had no B-frames and no video edit list.

The ffmpeg comparison commands:

```sh
ffmpeg -framerate 12 -i f%04d.png -i audio.wav -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 12 -c:a aac -b:a 128k -movflags +faststart ff-x264-aac.mp4
ffmpeg -framerate 12 -i f%04d.png -i audio.wav -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 12 -c:a libopus -b:a 128k -movflags +faststart ff-x264-opus.mp4
ffmpeg -framerate 12 -i f%04d.png -i audio.wav -c:v h264_videotoolbox -b:v 8M -profile:v high -pix_fmt yuv420p -r 12 -c:a aac_at -b:a 128k -movflags +faststart ff-vt-aacat.mp4
```

Those took 1.37 s, 1.25 s and 0.64 s for 36 frames, including PNG decode. All three had exactly 36 frames, 3.000000 s of video and 12/1 for both frame rates.

On the real `bear-test` scene, rendered by the repo's engine through the Vite dev server into a 1920x1080 `<canvas>` and encoded in the same page, 96 frames took 5.6 s, or 58 ms a frame. Only about 3 ms of that was encoding. Recording the draw calls took 10 ms, and Chromium's deferred CPU raster, which runs when the frame is snapshotted, took 45 ms. Quality against the captured PNGs, compared in YUV:

| Encoder | Bytes for 96 frames | SSIM | PSNR, dB |
| --- | --- | --- | --- |
| WebCodecs VideoToolbox, hs140 gpu and e44 | 2,268,196 and 2,268,084 | 0.99833 | 52.6 |
| WebCodecs VideoToolbox software, hs140 gpu | 2,203,387 | 0.99839 | 52.9 |
| WebCodecs OpenH264, hs153 | 2,142,082 | 0.99667 | 50.4 |
| WebCodecs OpenH264, e44 | 1,869,239 | 0.99682 | 50.2 |
| ffmpeg libx264 `-crf 18` | 701,388 | 0.99877 | 55.4 |
| ffmpeg `h264_videotoolbox -b:v 8M` | 2,542,367 | 0.99870 | 56.0 |

x264 made a file under a third the size at higher quality. The WebCodecs files differ in colour tags, so part of their PSNR gap may be conversion rather than compression.

### Audio alignment

Onset of the first burst relative to the correct sample. Positive means late. One sample is 21 µs.

| File | Boxes | ffmpeg 7.1.1 | Chromium 152 `decodeAudioData` | AVFoundation, macOS 27 |
| --- | --- | --- | --- | --- |
| WebCodecs AAC through Mediabunny | none | +2112 | +2113 | 0 |
| Same, packets shifted by -2112 samples | `elst` media time 2112 | 0 | +1 | -2112 |
| Shifted file remuxed with `ffmpeg -c copy` | `elst` 2112, `sgpd`/`sbgp` roll -1 | 0 | +1 | 0 |
| WebCodecs Opus through Mediabunny | `dOps` pre-skip 312, no `elst` | 0 | +1 | +312 |
| ffmpeg native `aac` | `elst` 1024, roll -1 | -1 | 0 | -1 |
| ffmpeg `libopus` | `elst` 312, pre-skip 312 | 0 | -312 | 0 |
| ffmpeg `aac_at` | `elst` 2112, roll -1 | -1 | 0 | -1 |

The Chromium and AVFoundation columns come from the hs140 gpu files. In ffmpeg, the c151, e44 and hs153 files gave the same offsets, which fits all four using AudioToolbox and libopus. In the 120 s AAC runs from hs140 gpu and e44, the error was +2111 or +2112 at every one of the 119 bursts. Every one of these files was reported playable by AVFoundation, the Opus ones included.

### GIF results

`bear-test`, 96 frames at 12 fps, captured with the repo's `render()` on a `<canvas>` with `{ willReadFrequently: true, colorSpace: 'srgb' }` in hs140 and saved with `toBlob('image/png')`. Each frame had 6,000 to 8,000 distinct colours. The half-size copy came from `ffmpeg -i bear/f%04d.png -vf scale=960:540:flags=lanczos`. PSNR is the RGB average over all frames against the source PNGs, from:

```sh
ffmpeg -i out.gif -i bear/f%04d.png -lavfi "[0:v]settb=1/12,setpts=N,format=rgb24[a];[1:v]settb=1/12,setpts=N,format=rgb24[b];[a][b]psnr" -f null -
```

| Encoder | 1080p bytes | 1080p time | 1080p PSNR | 540p bytes | 540p time | 540p PSNR |
| --- | --- | --- | --- | --- | --- | --- |
| ffmpeg `palettegen` + `paletteuse`, default sierra2_4a dither | 8,045,182 | 8.00 s | 55.0 | 2,934,202 | 2.20 s | 52.5 |
| ffmpeg, `paletteuse=dither=none` | 7,486,906 | 2.16 s | 55.6 | 2,765,369 | 0.66 s | 53.1 |
| ffmpeg, `palettegen=stats_mode=diff`, `paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle` | 7,197,880 | 1.79 s | 47.7 | 2,745,817 | 0.58 s | 46.1 |
| ffmpeg, `palettegen=stats_mode=single`, `paletteuse=new=1` | 28,096,477 | 8.99 s | 55.8 | 8,335,615 | 3.17 s | 52.7 |
| gifenc `quantize` rgb565 + `applyPalette`, one global palette | 8,253,555 | 2.68 s | 44.5 | 3,265,166 | 0.79 s | 39.8 |
| gifenc, rgb444 | 6,019,512 | 2.38 s | 38.3 | 2,382,789 | 0.65 s | 35.3 |
| gifenc writer, exact-colour palette, frame differencing | 8,317,377 | 5.41 s | 57.5 | 3,243,210 | 1.46 s | 54.5 |

The base ffmpeg command was `ffmpeg -framerate 12 -i bear/f%04d.png -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif`, and the other rows change only the filter options. ffmpeg times include PNG decoding. gifenc ran in Node 26 and its times exclude the 4.5 s spent decoding PNGs, which a page wouldn't pay because it already has the pixels. Every GIF had 96 frames and lasted exactly 8.00 s. On the `bears-gouache` still, the scores were 47.3 dB for ffmpeg's default, 48.1 dB without dither, 45.2 dB for stock gifenc and 51.1 dB for the exact-colour builder.

## Recommendation for M3

1. Encode in the page. Build one export module in the viewer that takes a frame range and a byte sink. It encodes with WebCodecs `VideoEncoder` and muxes with Mediabunny's `Output`, `Mp4OutputFormat` and `EncodedVideoPacketSource`. Keep the page-driving part behind `window.studio.renderFrame(n)` as ticket 07 says. The CLI sink writes through Playwright, Electron's goes over IPC to the main process, and the web app's is a download. That is the whole per-shell difference.
2. Move the CLI to a Chrome for Testing Playwright before pinning. Playwright 1.63.0 encoded H.264 through OpenH264 in its default headless shell with no GPU, and Chrome for Testing builds should behave the same on Linux and Windows. Pin it exactly, and re-run ticket 03's pixel checks on it before recording any reference image, because ticket 03's pin of 1.55.0 was chosen for a cached build, not for codecs. If M3 has to stay on 1.55.0 for now, add `--enable-gpu` to the macOS launch and accept that Linux has no H.264.
3. Use `{ codec: 'avc1.640028', width, height, framerate: fps, bitrate: 8_000_000, avc: { format: 'avc' }, latencyMode: 'quality', hardwareAcceleration: 'no-preference' }` with a key frame every two seconds. High 4.0 covers 1080p up to 30 fps. Call `isConfigSupported` first, then treat the encoder's `error` callback as the real answer. If either fails, name the browser and the config in the message.
4. Set `timestamp = Math.round(frame * 1e6 / fps)` and `duration = Math.round(1e6 / fps)`, and pass `{ frameRate: fps }` to `addVideoTrack`. Respect backpressure by awaiting Mediabunny's `add()` promises and holding `encodeQueueSize` to a few frames.
5. Make the M3 export test check the file, not the code. Draw a frame-index barcode in a test scene or render mode. Check that the stream has exactly `frameCount` frames, that `r_frame_rate` and `avg_frame_rate` equal `fps`, that the video stream duration equals `frameCount / fps`, and that the barcodes decode as 0 to N-1 in order. ffprobe does all of that. Mediabunny's demuxer might replace ffprobe in the test and drop the ffmpeg dependency entirely, but I didn't try it.
6. For GIF, use gifenc's `GIFEncoder` with our own palette code: the most frequent exact colours, gifenc's quantizer for the remaining slots, exact nearest-colour mapping with a cache, and a transparent index for unchanged pixels. Accumulate centisecond delays so the total is exact. Keep ffmpeg's `palettegen` as a reference in a quality test only.
7. Leave room for audio, which lands in M7. Target AAC-LC at 48 kHz stereo and 128 kbps. Signal priming ourselves: shift the packets back by the encoder delay, write an edit list with that media time and a segment duration equal to the scene's, and add the `roll` sample group. Mediabunny 1.59.1 writes the edit list but not the roll group, so either contribute it upstream or patch the `stbl` after muxing. The delay is 2112 on AudioToolbox. Measure Media Foundation's on a Windows machine. Where no AAC encoder exists, meaning Chromium on Linux and Firefox, fall back to Opus in MP4. Stick to 128 kbps, which is valid on Windows and is what I ran on Electron 44 without hitting [549893457](https://issues.chromium.org/issues/549893457).
8. Open a ticket for colour tags. Every MP4 should decode `#ffa200` as 255,162,0 in AVFoundation as well as ffmpeg. Chrome Headless Shell 153's tags did, and Chromium 140's and Electron 44's didn't.
9. Keep ffmpeg out of every shipped build. It remains useful as a dev-only checking tool. CLAUDE.md's "Headless rendering and export" section, which says MP4 goes "via ffmpeg (H.264)", should change when M3 lands.
10. Before a public Electron release, get legal advice on shipping Electron's compiled-in OpenH264, and on H.264 encoding as a service if the backend goes ahead. Add Mediabunny's MPL-2.0 notice and gifenc's MIT notice to the app's licences.

## Not verified

- Windows and Linux. Media Foundation behaviour, OpenH264 in Chrome for Testing and Electron on Linux, VA-API, and the absence of AAC on Linux rest on Chromium source. I had neither OS.
- Google Chrome and Edge, which aren't installed here. Whether Edge bundles OpenH264 is unknown.
- Safari itself. The WKWebView host answered `isConfigSupported` but never produced an H.264 chunk, so Safari's real encode path is untested.
- Firefox, which isn't installed. Everything about it comes from its source and release notes.
- Media Foundation's AAC priming count.
- Opus-in-MP4 playback in Windows' built-in players and in upload pipelines such as YouTube or social apps.
- Whether a free, open-source download needs a Via LA licence, whether the zero-cost tier needs a signed agreement, whether the Internet Broadcast rule survives in the 2026 terms, how server-side encoding is treated, and when the last AVC patents expire. Via LA's pages give no expiry dates.
- The terms Google attaches to encoding with the OpenH264 inside Chrome for Testing, for the dev CLI and a future backend.
- Why Chromium 153 writes different colour tags from 152, and which Chromium change did it.
- Whether 96 to 192 kbps is enough to avoid the Chromium 147 to 155 AAC crash in general. I only know that 128 kbps worked in my Electron 44 runs.
- x264's commercial licence terms. The licensing site blocked automated access.
- The sizes of the larger Mediabunny bundle, mp4-muxer and ffmpeg.wasm come from a research helper's separate run with the same tools. I didn't repeat them.

## Sources

- W3C WebCodecs editor's draft, sections on Check Configuration Support, `configure()`, HardwareAcceleration, LatencyMode, VideoFrameInit and output of EncodedVideoChunks: https://w3c.github.io/webcodecs/
- WebCodecs AVC, AAC and Opus codec registrations: https://www.w3.org/TR/webcodecs-avc-codec-registration/, https://www.w3.org/TR/webcodecs-aac-codec-registration/, https://www.w3.org/TR/webcodecs-opus-codec-registration/
- WebIDL, ConvertToInt and IntegerPart: https://webidl.spec.whatwg.org/#abstract-opdef-converttoint
- RFC 6381 section 3.4: https://www.rfc-editor.org/rfc/rfc6381#section-3.4. RFC 7845 section 4.2: https://www.rfc-editor.org/rfc/rfc7845#section-4.2
- w3c/webcodecs issue 626, audio priming and padding: https://github.com/w3c/webcodecs/issues/626
- MDN browser-compat-data, `api/VideoEncoder.json` and `api/AudioEncoder.json`: https://github.com/mdn/browser-compat-data
- Chromium source at tags 140.0.7339.16, 151.0.7922.176 and 152.0.7977.130: `build/config/features.gni`, `media/media_options.gni`, `media/base/supported_types.cc`, `media/base/media_switches.cc`, `third_party/blink/renderer/modules/webcodecs/{video_encoder,audio_encoder}.cc`, `media/gpu/mac/vt_video_encode_accelerator_mac.mm`, `media/gpu/windows/{media_foundation_video_encode_accelerator_win.cc,mf_video_encoder_util.h}`, `media/filters/mac/audio_toolbox_audio_encoder.cc`, `media/audio/audio_opus_encoder.cc`, `media/mojo/services/gpu_mojo_media_client.cc`, `media/parsers/h264_level_limits.cc`, `third_party/openh264/BUILD.gn`, `headless/lib/headless_content_main_delegate.cc`, `gpu/config/gpu_util.cc`, `docs/gpu/vaapi.md`, linked inline.
- Chromium issues 549893457, 545486499, 40245635, 40249559 and 414645305: https://issues.chromium.org/
- Electron `build/args/all.gn` at v44.4.5 and `build/args/release.gn`: https://github.com/electron/electron. The `LICENSES.chromium.html` and `libffmpeg.dylib` shipped in the Electron 44.4.5 darwin-arm64 build.
- Chromium's ffmpeg build config for Chrome branding, `chromium/config/Chrome/mac/arm64/config_components.h`: https://chromium.googlesource.com/chromium/third_party/ffmpeg/
- Playwright docs, browsers and release notes: https://playwright.dev/docs/browsers, https://playwright.dev/docs/release-notes
- WebKit blog posts for Safari 16.4, 17.0 and 26.0, and WebKit source `WebCodecsVideoEncoder.cpp`, `WebCodecsAudioEncoder.cpp`, `AudioEncoderCocoa.cpp`, `RTCVideoEncoderH264.mm`: https://webkit.org/blog/, https://github.com/WebKit/WebKit
- Firefox 130 release notes and Gecko source `AppleEncoderModule.cpp`, `WMFEncoderModule.cpp`, `FFmpegDataEncoder.cpp`, `media/ffvpx/config_components_audio_video.h`, `StaticPrefList.yaml`, `dom/media/webcodecs/AudioEncoder.cpp`: https://www.mozilla.org/en-US/firefox/130.0/releasenotes/, https://github.com/mozilla-firefox/firefox
- Apple TN2258 and QuickTime File Format, representing encoder delay explicitly: https://developer.apple.com/library/archive/technotes/tn2258/_index.html, https://developer.apple.com/documentation/quicktime-file-format/example_representing_encoder_delay_explicitly
- Opus in ISOBMFF 0.6.8: https://opus-codec.org/docs/opus_in_isobmff.html
- Microsoft, supported media formats in Media Foundation: https://learn.microsoft.com/en-us/windows/win32/medfound/supported-media-formats-in-media-foundation
- GIF89a specification, Graphic Control Extension delay time: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
- FFmpeg legal page and LICENSE.md: https://ffmpeg.org/legal.html, https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md
- GNU GPLv2 and GPL FAQ: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt, https://www.gnu.org/licenses/gpl-faq.html
- x264: https://www.videolan.org/developers/x264.html
- Via LA AVC/H.264 programme page with its fee table and licensee list, and the 2022 briefing: https://www.via-la.com/licensing-programs/avc-h-264/, https://via-la.com/wp-content/uploads/2025/09/avcweb.pdf
- Apple macOS Tahoe software licence agreement, section D, and Windows 11 licence terms, section 14.b: https://www.apple.com/legal/sla/docs/macOSTahoe.pdf, https://www.microsoft.com/content/dam/microsoft/usetm/documents/windows/11/oem-(pre-installed)/UseTerms_OEM_Windows_11_English.pdf
- Cisco OpenH264 binary licence and FAQ: http://www.openh264.org/BINARY_LICENSE.txt, https://www.openh264.org/faq.html
- ffmpeg.wasm repository, Dockerfile and performance doc: https://github.com/ffmpegwasm/ffmpeg.wasm
- Mediabunny README and docs, and the `frameRate` option in `mediabunny.d.ts` 1.59.1: https://github.com/Vanilagy/mediabunny, https://mediabunny.dev
- mp4-muxer README: https://github.com/Vanilagy/mp4-muxer
- gifenc README: https://github.com/mattdesl/gifenc. gifski README: https://github.com/ImageOptim/gifski
