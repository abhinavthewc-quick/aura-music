# OCI audio cache

Cloudflare `/api/audio` streams public catalogue audio from Hugging Face and
optionally stores requested files in OCI S3-compatible Object Storage. The
player starts streaming on a miss while `waitUntil` warms the complete file.
Each original, bass and reverb file is an independent object.

## Configure and activate

```sh
python3 tooling/cache/configure_pages.py --init
```

Fill `~/.config/aura-music/oci-cache.json` with the namespace, dedicated bucket,
region and a fresh OCI S3 access/secret key pair. The file and generated admin
token are private (0600) and remain outside Git. Existing config/tokens are
preserved. See the [configuration example](../tooling/config/oci-cache.example.json).

The old credentials appeared in historical Git content. Replace/revoke that
pair in OCI; removing the current defaults does not revoke a key or erase Git
history. No OCI API login is installed on this Mac, so a replacement pair must
be supplied by the owner or created using their OCI IAM/API login.

```sh
# Read-only S3 access check. No Pages settings or bucket objects are changed.
python3 tooling/cache/configure_pages.py
# Explicitly install verified configuration in Production and Preview.
python3 tooling/cache/configure_pages.py --activate
npm run build
wrangler pages deploy dist --project-name aura-music --branch main --commit-dirty=true
```

Activation checks OCI access first, then uses Wrangler's audited secret bulk
operation. Its stdin contains only `OCI_NAMESPACE`, `OCI_BUCKET_NAME`,
`OCI_REGION`, `OCI_ACCESS_KEY`, `OCI_SECRET_KEY` and `AUDIO_ADMIN_TOKEN`. It never
reads redacted old secret values into an update. Existing Pages service settings
and database bindings are left intact. Redeployment applies the new settings.

Absent/invalid OCI settings disable cache reads/writes. A failed lookup, warm
upload or metadata check leaves the Hugging Face stream available.

## Cache identities and freshness

Objects live under `aura-cache/v2/<archive hash>/<content identity>/<audio path>`.
The archive hash separates HF buckets, and the content identity includes the
canonical path plus current revision. D1 supplies original Xet hashes and ready
rendition SHA-256/update revisions. Old root/version URLs resolve to the same
canonical source. Unregistered uploads can use a strong HF ETag; without one
they stream without populating OCI.

Regeneration/publication changes the D1 revision, producing a different OCI key
even when the public filename stays the same. Ready-version API records include
the revision. Unversioned browser responses require revalidation; `cache=2` on
new player URLs bypasses responses retained from the old proxy. Requests whose
`v` parameter matches the current revision can cache the response for one hour.
Client-supplied revisions do not select the OCI key: server metadata does.

A background warm rechecks the source revision and, when available, compares
the downloaded SHA-256 with the published checksum before eviction/upload.
Partial, empty, oversized or truncated downloads never become cache entries.
Original replacements made outside the worker require a registry sync so D1
reflects the new source; registered originals use D1's recorded hash.

## Bounds and maintenance

- Maximum cached file size: 25 MiB. Larger files still stream from HF.
- Target: 30 audio objects per archive cache prefix, shared across modes.
- Eviction: oldest uploaded managed audio first; objects outside the prefix and
  non-audio data are preserved, including old unprefixed cache objects.
- Four pending warm jobs per Cloudflare isolate, with serialized eviction/write.
- Capacity is best effort across isolates, rather than a global distributed
  storage quota. Use OCI budget alerts/quotas for infrastructure enforcement.

Metadata probes are bounded; invalid paths/multiple byte ranges fail locally.
The server keeps credentials and signed requests private. GET/HEAD preserves
byte ranges for native playback and seeking. HEAD checks never warm the cache.

```sh
# Private aggregate counts for the managed prefix, using the token file.
python3 tooling/cache/oci_cache.py status
# Manually warm one song and all its published versions; wait for OCI hits.
python3 tooling/cache/oci_cache.py warm --limit 1
# Choose a specific original or processed path.
python3 tooling/cache/oci_cache.py warm --path 'versions/TRACK_KEY/bass.mp3'
# Compare bounded 256 KiB requests through the proxy and direct HF.
python3 tooling/cache/oci_cache.py benchmark --path 'originals/Artist - Song.opus'
```

Warm selection uses the complete paginated HF tree and D1 records. It is a
manual sample rather than a popularity ranking. A benchmark proxy request may
warm the cache. No Mac background service or audio-processing run is installed.
Legacy `scripts/sync_oci_hot_cache.py` and `scripts/benchmark_buckets.py` now
delegate to these tools without embedded credentials; old `--prune` is retired
in favor of bounded automatic eviction.

## Verification

```sh
npm test --prefix tooling
npm run typecheck
npm run lint
npm test
npm run build
```

The tooling suite exercises real SQLite revisions, hit/miss fallback, source
changes during downloads, checksum rejection, scoped eviction, bounded buffers,
range handling, credential privacy and safe activation arguments. Live
activation is verified by warming real audio, observing `HIT-OCI`, comparing
returned ranges against HF, and checking the private aggregate status.
