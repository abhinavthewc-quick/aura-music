const MUSIC_PARAMS = 'EgWKAQIIAWoKEAoQAxAEEAkQBQ=='; // YT Music "Songs" tab only

interface YtResult {
  source: 'youtube';
  id: string;
  videoId: string;
  title: string;
  artist: string;
  img: string;
  full: boolean;
  sub?: string;
}

const YT_POST_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://music.youtube.com',
  Cookie: 'SOCS=CAI', // kills the EU consent interstitial
};

const runsText = (r: any): string =>
  Array.isArray(r?.runs) ? r.runs.map((x: any) => x.text).join('') : (r?.simpleText ?? '');

async function ytSearchMusic(q: string): Promise<YtResult[]> {
  const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: YT_POST_HEADERS,
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250915.01.00', hl: 'en', gl: 'US' } },
      query: q,
      params: MUSIC_PARAMS,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error('YouTube search HTTP ' + res.status);
  const data: any = await res.json();
  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const out: YtResult[] = [];
  for (const sec of sections) {
    for (const item of sec?.musicShelfRenderer?.contents || []) {
      const r = item?.musicResponsiveListItemRenderer;
      const videoId = r?.playlistItemData?.videoId;
      if (!videoId) continue;
      const cols = (r?.flexColumns || []).map((f: any) =>
        runsText(f?.musicResponsiveListItemFlexColumnRenderer?.text),
      );
      const title = cols[0] || 'Unknown Title';
      const sub = cols[1] || '';
      // sub is typically "Artist • Album • 3:45" or "Artist • 3:45"
      const artist = sub ? sub.split('•')[0].trim() : 'YouTube Music';
      const thumb =
        r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ||
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

      out.push({
        source: 'youtube',
        id: videoId,
        videoId,
        title,
        artist,
        img: thumb,
        full: true,
        sub,
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

export const onRequestGet = async ({ request }: { request: Request }): Promise<Response> => {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);

  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  try {
    const results = await ytSearchMusic(q);
    return new Response(JSON.stringify({ ok: true, results }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, results: [] }), {
      status: 200, // Return 200 with empty results so client doesn't crash
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};
