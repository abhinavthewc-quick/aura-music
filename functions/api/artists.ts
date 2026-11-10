import { readArtistDirectory, type ArtistEnv, ArtistStoreError } from '../lib/artistStore.js';

export const onRequestGet = async ({ env }: { env: ArtistEnv }) => {
  try {
    const directory = await readArtistDirectory(env);
    return Response.json(directory, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (e) {
    return Response.json({ error: e instanceof ArtistStoreError ? e.message : 'Artist profiles are temporarily unavailable.' }, {
      status: e instanceof ArtistStoreError ? e.status : 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
};
