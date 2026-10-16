# YouTube Search in a Cloudflare Worker — Implementation Guide

**Decision: use Option 1 (direct InnerTube JSON API).** `youtube-search-api` was rejected — see "Why not the npm package" at the bottom.

Everything in this doc was measured live (workerd via `wrangler dev` + direct curl), not assumed.

---

## 1. What you are actually doing

YouTube's own web/app clients do not use the public Data API (v3, key + quota). They call a private JSON RPC called **InnerTube**:
every client posts JSON to `https://www.youtube.com/youtubei/v1/<endpoint>` with a `context.client` block describing which
client it pretends to be. We impersonate the standard `WEB` client with a plain `fetch()`.

Why this fits a Cloudflare Worker:
- It is one HTTP POST + JSON parse → only needs `fetch` (a Worker native API).
- No API key, no quota, no cookies required (tested without a key → HTTP 200).
- No Node/binary deps (bundle measured at **2.00 KiB / 0.91 KiB gzip**).

## 2. The endpoint contract

```
POST https://www.youtube.com/youtubei/v1/search?prettyPrint=false
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
Origin: https://www.youtube.com          (recommended, not strictly required)
Cookie: SOCS=CAI                          (optional; kills EU consent interstitial — see §7)

{
  "context": {
    "client": {
      "clientName": "WEB",
      "clientVersion": "2.20250915.01.00",   // any recent version works; tested 2.20240301 & 2.20250915
      "hl": "en",                             // UI language
      "gl": "US"                              // country → changes results/ordering
    }
  },
  "query": "daft punk",
  "params": "EgIQAQ=="                        // OPTIONAL: "video only" filter (see §4)
}
```

- `?key=...` is **not** needed for search (tested: works with and without).
- `prettyPrint=false` shrinks the payload (page 1 ≈ 428 KB → same order either way; it is a big JSON either way).
- **POST to the full path** `youtube.com/youtubei/v1/search`. Posting to `youtube.com` root returns HTTP 400 HTML
  (that bug exists in the snippet that inspired this project).
- Response is `application/json`. If you ever get `text/html`, YouTube served a consent/error page — handle it (§7).

## 3. Response anatomy (search, page 1)

```
data
└─ contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents
   ├─ [0] itemSectionRenderer.contents[]      ← the actual results (array)
   │     ├─ videoRenderer            ← regular video (main one you want)
   │     ├─ lockupViewModel          ← playlist/mix cards (has contentId + contentType)
   │     ├─ gridShelfViewModel       ← "people also watched" style shelves (skip)
   │     └─ channelRenderer / radioRenderer / playlistRenderer (legacy, may appear)
   └─ [1] continuationItemRenderer            ← pagination token (see §5)
```

Empty-query result (verified): `itemSectionRenderer.contents[0].backgroundPromoRenderer` with
`"No results found"` → **return `[]`, do not throw.**

`videoRenderer` fields you care about (all verified present):

| Field | Path | Example |
|---|---|---|
| id | `videoId` | `"dQw4w9WgXcQ"` |
| title | `title.runs[0].text` | `"Rick Astley - Never Gonna Give You Up..."` |
| duration | `lengthText.simpleText` | `"3:34"` — **absent for LIVE streams** |
| is live | `isLive === true` or missing `lengthText` + LIVE badge in `badges[]` | |
| channel | `ownerText.runs[0].text` (or `shortBylineText`) | |
| views | `viewCountText.simpleText` | `"1.5B views"` |
| published | `publishedTimeText.simpleText` | `"14 years ago"` |
| thumbnail | `thumbnail.thumbnails[].url` (last = largest) | |
| description snippet | `detailedMetadataSnippets[0].snippetText.runs[].text` | |
| duration seconds | parse `lengthText` (`"1:23:45"` → 5025) | |

Typical yield: **13–19 videos per page** (14 videoRenderer + 1 lockup + 2 grid shelves in one sample).

## 4. Filters via `params`

`params` is an opaque base64 protobuf string; YouTube does not document it, but these are stable and verified today:

| Client | `params` | Effect (verified) |
|---|---|---|
| `WEB` | `"EgIQAQ=="` | video-only → 19 `videoRenderer` + 1 `channelRenderer`, shelves gone |
| `WEB_REMIX` (YT Music) | `"EgWKAQIIAWoKEAoQAxAEEAkQBQ=="` | Songs tab only → 20 `musicShelfRenderer` items |

If `params` ever breaks, omit it — you still get results (just mixed types).

## 5. Pagination (page 2+)

Token lives at `sectionListRenderer.contents[1].continuationItemRenderer.continuationEndpoint.continuationCommand.token`.

```jsonc
POST https://www.youtube.com/youtubei/v1/search?prettyPrint=false
{ "context": { "client": { ...same... } }, "continuation": "<token>" }
```

Response has **no** `contents`; results are at:
`onResponseReceivedCommands[].appendContinuationItemsAction.continuationItems[]`,
where each entry is itself an `itemSectionRenderer` — flatten it:

```js
let items = [];
for (const cmd of data.onResponseReceivedCommands || []) {
  for (const it of cmd.appendContinuationItemsAction?.continuationItems || []) {
    if (it.itemSectionRenderer) items.push(...(it.itemSectionRenderer.contents || []));
    else items.push(it);
  }
}
// verified: page 2 → 13 more videoRenderer items
```

## 6. Music-specific variant (recommended for a music app)

For songs/artists/albums instead of raw videos, impersonate the YouTube Music client:

```
POST https://music.youtube.com/youtubei/v1/search?prettyPrint=false
Origin: https://music.youtube.com
{ "context": { "client": { "clientName": "WEB_REMIX",
                           "clientVersion": "1.20250915.01.00",
                           "hl": "en", "gl": "US" } },
  "query": "daft punk get lucky",
  "params": "EgWKAQIIAWoKEAoQAxAEEAkQBQ==" }   // songs only
```

Verified shape (one shelf, 20 items, ~197 KB):

```
contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content
  .sectionListRenderer.contents[].musicShelfRenderer.contents[]
  .musicResponsiveListItemRenderer
```

`musicResponsiveListItemRenderer` parsing (verified):

```js
const cols = r.flexColumns.map(f =>
  f.musicResponsiveListItemFlexColumnRenderer.text.runs.map(x => x.text).join(""));
// cols[0] = "Get Lucky (feat. Pharrell Williams and Nile Rodgers)"
// cols[1] = "Daft Punk, Pharrell Williams & Nile Rodgers • Random Access Memories • 6:10"
// cols[2] = "1.9B plays"
const videoId = r.playlistItemData?.videoId;   // "4D7u5KF7SP8"
const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail.thumbnails.at(-1)?.url;
```

Without `params`, page 1 starts with `musicCardShelfRenderer` (the top result card) followed by
`itemSectionRenderer` sections — skip/handle it separately.

## 7. Error handling & edge cases

| Case | Signal | Action |
|---|---|---|
| No results | `backgroundPromoRenderer` present | return `[]` |
| Consent interstitial (mostly EU IPs) | `content-type: text/html` or `response.json()` throws | retry once with header `Cookie: SOCS=CAI` (verified works with `gl=DE`) |
| Rate limit / transient | HTTP 429/5xx | retry ×2 with backoff (300 ms, 1 s), honor `Retry-After` |
| Structure drift | missing nested path | optional chaining everywhere; if `contents` missing → return `[]` + log keys for debugging |
| Slow upstream | ~1 s normal | `AbortSignal.timeout(8000)` on fetch; return 504 |
| LIVE videos | no `lengthText` | `duration: null`, surface `isLive` |

Measured latency in workerd: **6/6 success, 772–1102 ms** per search (avg ≈ 970 ms; dominated by YouTube returning ~430 KB).
No 429s observed during ~20 requests, but there is no official quota → treat it as "best effort, add caching".

## 8. Caching (do this — it halves latency and risk)

Key: `q` (lowercased, trimmed) + `gl` + `hl` + endpoint variant. Worker Cache API:

```js
const cacheKey = new Request(`${url.origin}/ytsearch?${new URLSearchParams({q, gl, hl, mode})}`);
const hit = await caches.default.match(cacheKey);
if (hit) return hit;                 // instant, ~0 ms
// ... fetch YouTube ...
const res = new Response(JSON.stringify(body), { headers: {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
}});
ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
```

(Optionally front it with KV if you need cross-PoP sharing or a stale-while-revalidate policy.)

## 9. Reference implementation (tested)

```js
const YT = {
  search: "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
  music:  "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
};
const HEADERS = (origin) => ({
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Origin: origin,
  Cookie: "SOCS=CAI",
});

async function ytPost(url, origin, body) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: HEADERS(origin),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`YouTube ${res.status}`);
        await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error(`non-json response (${ct})`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const ctx = (clientName, clientVersion, hl = "en", gl = "US") => ({
  context: { client: { clientName, clientVersion, hl, gl } },
});

// ---- video search (WEB) ----
async function searchVideos(query, { hl = "en", gl = "US", limit = 20, videoOnly = true, continuation = null } = {}) {
  const body = { ...ctx("WEB", "2.20250915.01.00", hl, gl) };
  if (continuation) body.continuation = continuation;
  else { body.query = query; if (videoOnly) body.params = "EgIQAQ=="; }
  const data = await ytPost(YT.search, "https://www.youtube.com", body);

  let items;
  if (continuation) {
    items = [];
    for (const cmd of data.onResponseReceivedCommands || [])
      for (const it of cmd.appendContinuationItemsAction?.continuationItems || [])
        if (it.itemSectionRenderer) items.push(...(it.itemSectionRenderer.contents || []));
        else items.push(it);
  } else {
    items = data.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
  }

  const videos = items.filter(i => i.videoRenderer).map(({ videoRenderer: v }) => ({
    videoId: v.videoId,
    title: v.title?.runs?.map(r => r.text).join("") ?? null,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    duration: v.lengthText?.simpleText ?? null,
    isLive: !!v.isLive,
    channel: v.ownerText?.runs?.[0]?.text ?? null,
    views: v.viewCountText?.simpleText ?? null,
    published: v.publishedTimeText?.simpleText ?? null,
    thumbnail: v.thumbnail?.thumbnails?.at(-1)?.url ?? null,
  })).slice(0, limit);

  const nextTok = data.contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?.sectionListRenderer?.contents?.find(c => c.continuationItemRenderer)
    ?.continuationItemRenderer.continuationEndpoint.continuationCommand.token ?? null;

  return { videos, nextPageToken: nextTok };
}

// ---- song search (YT Music, WEB_REMIX) ----
async function searchSongs(query, { hl = "en", gl = "US", limit = 20 } = {}) {
  const data = await ytPost(YT.music, "https://music.youtube.com", {
    ...ctx("WEB_REMIX", "1.20250915.01.00", hl, gl),
    query,
    params: "EgWKAQIIAWoKEAoQAxAEEAkQBQ==",
  });
  const shelf = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.sectionListRenderer?.contents?.find(c => c.musicShelfRenderer);
  const rows = shelf?.musicShelfRenderer?.contents || [];
  return rows.map(r => {
    const m = r.musicResponsiveListItemRenderer;
    const cols = (m?.flexColumns || []).map(f =>
      f.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join("") ?? "");
    return {
      videoId: m?.playlistItemData?.videoId ?? null,
      title: cols[0] ?? null,
      meta: cols[1] ?? null,            // "Artist • Album • 6:10"
      plays: cols[2] ?? null,
      thumbnail: m?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ?? null,
    };
  }).filter(x => x.videoId).slice(0, limit);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    if (!q) return new Response(JSON.stringify({ error: "missing q" }), { status: 400, headers: { "Content-Type": "application/json" } });

    try {
      const results = url.searchParams.get("mode") === "music"
        ? await searchSongs(q, { gl: url.searchParams.get("gl") || "US" })
        : await searchVideos(q, { gl: url.searchParams.get("gl") || "US" });
      return new Response(JSON.stringify({ count: results.length, results }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
  },
};
```

## 10. Testing checklist

```bash
npm i -D wrangler
npx wrangler dev worker.js --port 8787 --compatibility-date 2026-10-01

# video search
curl -s --get --data-urlencode "q=daft punk" http://127.0.0.1:8787/ | head -c 400
# music search
curl -s --get --data-urlencode "q=daft punk get lucky" "http://127.0.0.1:8787/?mode=music" | head -c 400
# empty query must be 400; gibberish query must be count:0 with HTTP 200
curl -s "http://127.0.0.1:8787/?q=xqzplmorb%2094817%20notavideo"
```

Expected: results in ~1 s, 13–19 videos (or 20 songs in music mode), 200 status.
Bundle check: `npx wrangler deploy --dry-run --compatibility-date 2026-10-01 --outdir dist worker.js` → should say ~2 KiB.

## 11. Deployment notes

- `wrangler.toml` / config **must** include `compatibility_date` or wrangler errors out.
- No bindings required; optional: KV or Cache API for caching, a rate-limiter (Durable Object / KV counter) if public.
- Treat results as unauthenticated, quota-free, best-effort: always have the retry + cache path, never assume availability.
- This violates YouTube ToS in the strictest reading — same status as every alternative here (the npm package scrapes the HTML
  results page too). Keep traffic low and cache aggressively.

## 12. Why NOT `youtube-search-api` (Option 2) — measured failures

1. **Broken import shape**: `import YouTubedl from "youtube-search-api"` → `undefined` in wrangler's bundle (CJS module
   sets `__esModule:true` but never `exports.default`) → `TypeError: Cannot read properties of undefined`.
   Needs `import { GetListByKeyword }` instead.
2. **Hard failure in the Workers runtime even after fixing (1)**: the package depends on axios 1.20, whose fetch adapter
   hardcodes `cache: 'default'` (`axios/lib/adapters/fetch.js:21`). workerd rejects it:
   `TypeError: Unsupported cache mode: default`. Reproduced with a minimal worker (`fetch(url,{cache:"default"})` → same error).
   Only workaround: patch `node_modules/axios` or add a bundler alias — at which point it is no longer zero-dependency.
3. **Bundle**: 162.83 KiB / 36.44 KiB gzip vs 2.00 KiB / 0.91 KiB gzip for raw fetch (~80×).
4. Works fine in plain Node (2.9 s/search) — that is why docs claim it is "Workers-compatible". It is not.

## 13. Anti-patterns (bugs found in the original snippet)

- POSTing to `https://youtube.com` (root) instead of `/youtubei/v1/search` → HTTP 400 HTML.
- `` `https://youtube.com{videoId}` `` — missing `$`; must be `` `...${videoId}` ``.
- Assuming one fixed JSON path — always optional-chain and fall back to `[]`.
- Assuming duration exists (LIVE items have none) or that all items are videos (lockups, grids, channels).
