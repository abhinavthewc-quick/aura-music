# Automatic artist profiles

Aura fills missing artist portraits and descriptions from Wikidata, Wikimedia
Commons and, when the identity matches, Wikipedia. Artist cards and detail pages
use a neutral placeholder when no suitable portrait is available. Recording and
album artwork remain attached to their tracks.

Existing saved portraits are retained. Automatic descriptions and photos are
display metadata: they do not rename artists, create artist ownership, change
track IDs, or rewrite playlists.

## Sources and matching

- Wikidata supplies artist identities and short factual descriptions. Searches
  examine at most 50 lightweight results and fetch at most five exact-name
  candidate entities. Matching rechecks entity names/aliases and musical identity;
  competing or truncated results remain ambiguous.
- Verified identity bindings resolve known ambiguous names. Uncertain matches,
  non-musicians and unrelated places are rejected.
- Commons portraits come from the matched entity's image claim, with a checked
  file page, creator and license. Artist detail pages and the admin preview show
  source and license links for automatic portraits, with a cropping notice.
- Wikipedia extracts are used only for a standard article whose Wikidata ID
  matches the artist. Excerpts identify Wikipedia contributors and CC BY-SA 4.0;
  Wikidata descriptions retain their CC0 source credit.

An artist can have a sourced description without a photograph. A missing image
does not cause Aura to substitute another person's picture.

## Manual control

Photo and biography each have an independent override:

| Field state | Displayed value |
| --- | --- |
| Manual value | The saved value |
| Explicitly cleared | Empty; automatic enrichment cannot refill it |
| Automatic enabled | Verified automatic value, then the stored fallback |

The artist editor's **Use automatic** actions remove the corresponding override.
Saving another field does not turn an untouched automatic biography into a
manual one. Open editor drafts keep their captured version and survive incoming
metadata refreshes.

The initial migration keeps every existing nonempty saved portrait or biography
as an override. Existing empty fields are treated as unspecified and eligible
for enrichment. Future clears are stored explicitly with the override enabled.
The initial production directory contained 18 version-one profiles and no saved
biographies.

## Loading and caching

The signed-out entry performs no artist lookups. After sign-in and library paint,
the client prioritizes relevant artists and schedules bounded background work.
Requests carry artist names, not account details, playlist contents or search
queries. The browser calls Aura's same-origin API; provider requests run in Pages
Functions.

`GET /api/artist-metadata?name=…` is a public cached metadata lookup. Responses use
`ready`, `not-found`, `ambiguous` or `retry`; `retryAfter` is in seconds. A resolved
result can contain either or both fields, with independent attribution. The API
does not grant access to admin operations.

Automatic results, negative results, leases and shared request budgets live in
separate D1 cache tables. Positive results normally last seven days and negative
results one day. Transient failures back off and retain an earlier successful
result. Durable claims coalesce concurrent lookups; provider limits apply across
Pages isolates. A new lookup can start every two seconds, with at most two active
jobs and 500 starts per UTC day. Requests have a 20-second overall deadline;
cached reads do not consume a provider job.

Idle lookups use Wikimedia's `maxlag=5` background-work protection. Opening an
artist sends `X-Aura-Artist-Intent: view`, using the documented interactive-read
mode while retaining the same shared budgets, timeouts and retry delays. See
[Wikimedia's maxlag guidance](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter).

The browser cache uses `auraAutomaticArtistMetadata_v1`, bounded to 320 entries
and 1 MiB of UTF-8 JSON. It keeps at most 32 queued priorities, considers up to
384 catalogue artists, and runs at most two requests concurrently. Three failed
attempts lead to a one-hour cooldown; upstream retry delays are also respected.
The browser timeout is 25 seconds, above the API deadline. Hidden, offline or
signed-out pages pause queued work; admin enrichment waits for the server's
existing admin gate.

Blocked storage or failed requests leave the library usable. Automatic refreshes
update portrait and description nodes in place, retaining track-control focus
without loading a song, seeking audio, or changing playlist bytes.

## Storage and development

`artist_profiles` retains manual/imported data. `img_override` and `bio_override`
record field intent; provider data never enters that table. Automatic cache
updates do not change profile versions, aliases or the artist-directory revision.
The override migration publishes its new public fields with one directory
revision increment.

Apply the artist database migrations before publishing the updated Functions:

```sh
npx wrangler d1 migrations apply aura-artists --remote --config wrangler.artists.jsonc
```

The integration uses the existing `ARTIST_DB` binding and keyless Wikimedia
APIs. Vite development proxies metadata requests to the deployed Pages Function;
the isolated artist fixtures supply local responses. Regression setup and commands are in
[Artist storage](artist-storage.md#concurrency-and-tests).

## Verified release — 11 November 2026

Implementation `f419616` is deployed on `aura-music-01g.pages.dev`. Production
checks preserved all 18 saved profiles and all 16 image BLOBs, with directory
revision 19 after the two migrations. Subsequent independent admin saves added
Ilaiyaraaja and Arijit Singh; final verification preserved those additions too,
at 20 profiles and revision 21. Existing configuration and the Rooms Worker
version were preserved.

Actual Pages → Wikimedia → D1 → public API checks returned:

| Artist | Portrait | Description | Result |
| --- | --- | --- | --- |
| Ed Sheeran | Verified | Wikipedia excerpt | Ready |
| Lana Del Rey | Verified | Wikipedia excerpt | Ready |
| Deepak Dev | Verified | Wikipedia excerpt | Ready |
| Sorana | None verified | Wikipedia excerpt | Ready |
| Torine | None selected | None selected | Ambiguous |

Every lookup used one provider job and its cached repeat used zero. All four
ready records had seven-day lifetimes, and the ambiguous result had a one-day
lifetime. The manual directory was unchanged after every lookup. Ed Sheeran's
lookup also verified recovery from an earlier retry record.

The cold provider/cache checks ran on `4555497`; `f419616` retains that provider
unchanged and adds the responsive artist-header correction. Final live Home and
Library verification passed **182 checks** across mobile and desktop, with all
**20 screenshots** visually reviewed. It checked real photos and displayed
source/license/crop credits, neutral fallbacks and readable names, while retaining
all 407 track records, recording artwork, playlist bytes and audio state.
Signed-out artist requests and cached Ed Sheeran reload requests were both zero.

Live verification caught and corrected a platform-specific fetch option:
Cloudflare `workerd` supports `redirect: 'manual'`, not `'error'`. The adapter
rejects all non-OK responses, including redirects, without following their
targets. Native-runtime fixture checks and production egress both passed after
the correction. Performance and full regression records are in
[Lighthouse verification](lighthouse.md#automatic-artist-profiles--11-november-2026).

Related code: `lib/artistMetadata.ts`, `src/core/artistMetadata.ts`,
`functions/api/artist-metadata.ts`, and `functions/lib/artistMetadataStore.ts`.
