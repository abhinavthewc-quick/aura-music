# Preprocessed song versions

Aura can play **Original**, **Bass boosted**, or **Bass + reverb** from files
already processed outside the app. The Version selector appears in the desktop
player bar and the mobile/full player for catalogue tracks.

The three waveform buttons select Original, Bass boosted, or Bass + reverb with
one tap. A sliding mark follows the selected sound. The desktop bar and full
player stay synchronized, and arrow keys, Home, End and Space work with the
radio-group control. Unavailable renditions are disabled.

The choice is remembered on this device (`auraAudioVersion_v1`). Selecting a
catalogue song starts its original stream immediately and concurrently fetches
and decodes all available renditions into temporary playback buffers. Every
prepared lane runs on the same Web Audio clock at the same elapsed position.
A warm switch changes complementary gains over 120 ms; it does not pause,
reload, seek the native transport, create another listen, or fetch the file again.
The files are already processed; browser decoding is ordinary audio playback.

If a requested sound is still loading, the current sound continues until it is
ready. The newest selection wins, including while paused. Play/Pause, seeks,
volume, repeat and queue advancement retain the canonical original transport.
Radio, local files, YouTube and listening rooms retain their existing sources.
The version lanes share the existing Muffle output filter.

Only the current song has prepared buffers. Selecting another song, YouTube,
Radio or a Room aborts pending preparations and releases its old buffers and
playback nodes. Preparing full versions uses additional bandwidth and decoded
memory; the original native stream can overlap its background fetch. There is
no persistent audio download, and the whole library is not preloaded. Each
preparation tries the edge proxy and direct Hugging Face independently. A failed
alternate leaves the current sound available, and selecting it again retries.
Browsers without Web Audio retain Original playback.

## Database and archive

Cloudflare D1 now records version paths, readiness, recipes and processing jobs.
The listener reads `/api/versions`; only ready renditions of active originals
are selectable. The legacy `versions.json` fallback has been retired; the
listener, worker and importer use D1 for version records. An unavailable
registry leaves original playback available.

```text
originals/Artist - Song [abcdefghijk].opus
covers/Artist - Song [abcdefghijk].webp
versions/abcdefghijk/bass.mp3
versions/abcdefghijk/bass-reverb.mp3
manifest.json
```

Original song identities remain stable when storage paths move. Processed files
are attachments, excluded from the listener and admin libraries. Old stream
URLs resolve through the proxy after the migration.

See [Mac audio processing](audio-processing.md) for the installed **manual**
worker, configuration, D1 schema, upload/retry lifecycle, one-time migration and
verification commands. It downloads only eligible originals, uses the existing
aubatch tool and saved presets, uploads with `hf buckets sync`, and marks files
ready only after upload verification. There is no background login service.
