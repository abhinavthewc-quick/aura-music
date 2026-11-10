# Public resource discovery

Aura publishes these static documents from `public/`:

| URL | Content |
| --- | --- |
| `/llms.txt` | Markdown overview and links, served as `text/plain`. |
| `/.well-known/ard.json` | ARD v0.91 manifest, served as `application/json`. |
| `/docs/public-resources.json` | JSON navigation guide, access conditions, and artist-directory response-field descriptions. |
| `/.well-known/ai-catalog.json` | Exact 301 redirect to `/.well-known/ard.json`, configured in `public/_redirects`. |

The ARD entries reference the guide and the existing read-only `GET /api/artists`
directory. Their `application/json` type describes the actual response artifact.
ARD v0.91 permits application extension media types; its conformance checker
reports this as information, rather than a warning. Each entry has a
domain-anchored identifier and three representative queries.

The guide describes Home and Library after browser sign-in, the separate public
Rooms join/create page, artist metadata, the sitemap, and crawler policy. The
artist directory returns `{ artists, trackArtists, revision }` with
`Cache-Control: no-store`; see `functions/api/artists.ts`,
`functions/lib/artistStore.ts`, and `lib/artistProfiles.ts`. Its public readability
is distinct from the existing `robots.txt` directive disallowing `/api/` crawling.

Vite copies these assets, including `.well-known/` and `_redirects`, to `dist/`.
Cloudflare Pages applies the legacy redirect. Ordinary Vite development/preview
servers do not interpret Pages redirect rules.

## Document checks

Run from the repository root with Node.js 20.19+:

```sh
node scripts/verify-discovery.mjs
```

This dependency-free check verifies Markdown structure and required links,
Aura's ARD resource contracts, guide URLs and access conditions, directory field
descriptions, sitemap/crawler-policy consistency, and the exact legacy redirect.
It emits JSON with artifact hashes and fails on missing or inconsistent content.
When a production build is available, also check the copied assets:

```sh
node scripts/verify-discovery.mjs --directory dist
```

For the full schema and conformance rules, supply an **already installed
Lighthouse 13.6.0 package directory**:

```sh
node scripts/verify-discovery.mjs --lighthouse /absolute/path/to/node_modules/lighthouse
```

This invokes `ConformanceTester.validate_manifest`, `LlmsTxt.audit`, and
`ArdSchema.audit` directly with local document content and successful-fetch
artifacts. It checks zero ARD errors/warnings and both document scores of 1.
These are document-only validations; no browser navigation is performed.

The pinned rules are ARD **0.91 (`f073b1e`)**, as bundled in Lighthouse 13.6.0:

- [Pinned ARD specification](https://github.com/ards-project/ard-spec/blob/f073b1ea9b01a5f068d0b0986426f2ea49fa30b2/spec/ard.md)
- [Pinned schema](https://raw.githubusercontent.com/ards-project/ard-spec/f073b1ea9b01a5f068d0b0986426f2ea49fa30b2/spec/schemas/ard-entry.schema.json): manifest is `$defs/ArdManifest`, entries are `$defs/ArdEntry`; the schema document's default root describes an entry.
- Lighthouse implementation: `third-party/ard/{ard.js,schema-validator.js}` and `core/audits/agentic/{llms-txt.js,ard-schema.js}` inside the package directory.

## HTTP verification

After the selected artifacts are served by Pages or a Pages-compatible local
server, run:

```sh
node scripts/verify-discovery.mjs --directory dist --base-url https://aura-music-01g.pages.dev
```

The HTTP mode makes seven unauthenticated GET requests: the three discovery
documents, `sitemap.xml`, `robots.txt`, the legacy URL, and `/api/artists`. It
checks status and media type, exact static content against the selected local
files, the legacy 301's same-origin canonical destination, and the artist
directory's response shape and `no-store` header. Redirects are inspected
manually so an HTML fallback cannot masquerade as a successful alias.

Use the local origin as `--base-url` for a Pages-compatible test server. A plain
Vite server will fail the legacy redirect check. A successful HTTP check proves
the discovery resources are served correctly; a coordinated live Lighthouse
run is still needed to measure the deployed Agentic Browsing result.
