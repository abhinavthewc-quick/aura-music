import { archiveTree, authenticated, LEASE_SECONDS, MODES, originalId, publicVersions, renditionPath,
  safePath, trackRef, validKey, type RegistryEnv, type VersionDatabase } from '../lib/version-registry';
import { audioEvent } from '../lib/audio-processing-admin';

interface Context { request: Request; env: RegistryEnv }
const json = (body: unknown, status = 200, cache = false) => Response.json(body, {status, headers: {
  'Cache-Control': cache ? 'public, max-age=15, must-revalidate' : 'no-store',
  'X-Content-Type-Options': 'nosniff',
}});
const now = () => Math.floor(Date.now() / 1000);
function error(message: string, status = 400): never { throw Object.assign(new Error(message), {status}); }
function requireLease(body: any): void {
  if (typeof body.ref !== 'string' || typeof body.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(body.owner)) error('Invalid lease');
}
async function owned(db: VersionDatabase, body: any): Promise<any> {
  requireLease(body);
  const row = await db.prepare('SELECT * FROM audio_tracks WHERE ref = ? AND active = 1 AND lease_owner = ? AND lease_until > ?')
    .bind(body.ref, body.owner, now()).first();
  if (!row) error('Lease expired or owned by another worker', 409);
  return row;
}
async function finishTelemetry(db: VersionDatabase, body: any, stage: string, message: string): Promise<void> {
  try {
    await db.prepare('UPDATE audio_job_progress SET stage = ?,updated_at = ? WHERE track_ref = ? AND owner = ?')
      .bind(stage,now(),body.ref,body.owner).run();
    await audioEvent(db,'Mac worker',stage,message,body.ref);
  } catch { /* A telemetry outage cannot invalidate a committed publication. */ }
}
export const onRequestGet = async ({env}: Context): Promise<Response> => {
  if (!env.VERSION_DB) return json({error: 'Version registry unavailable'}, 503);
  try { return json(await publicVersions(env.VERSION_DB), 200, true); }
  catch { return json({error: 'Version registry unavailable'}, 503); }
};
export const onRequestPost = async ({request, env}: Context): Promise<Response> => {
  if (!await authenticated(request, env.VERSION_WORKER_TOKEN)) return json({error: 'Unauthorized'}, 401);
  if (!env.VERSION_DB) return json({error: 'Version registry unavailable'}, 503);
  const db = env.VERSION_DB, bucket = env.HF_BUCKET_ID || 'Angelrider/sonora';
  try {
    if (Number(request.headers.get('content-length')) > 1024 * 1024) error('Request too large', 413);
    const text = await request.text();
    if (text.length > 1024 * 1024) error('Request too large', 413);
    let body: any;
    try { body = JSON.parse(text); } catch { error('Invalid JSON'); }
    const timestamp = now();
    switch (body.action) {
      case 'runStarted': {
        if (!/^[a-f0-9-]{36}$/.test(body.owner) || typeof body.host !== 'string' || body.host.length > 100 ||
          !Number.isInteger(body.parallelism) || body.parallelism < 1 || body.parallelism > 4 ||
          typeof body.recipe !== 'string' || body.recipe.length > 512) error('Invalid worker report');
        await db.prepare(`INSERT INTO audio_worker_runs (owner,host,parallelism,recipe,status,started_at,heartbeat_at)
          VALUES (?,?,?,?,'running',?,?) ON CONFLICT(owner) DO NOTHING`)
          .bind(body.owner,body.host,body.parallelism,body.recipe,timestamp,timestamp).run();
        await audioEvent(db,'Mac worker','runStarted',`Manual run started with ${body.parallelism} processing lanes`);
        return json({ok:true});
      }
      case 'runFinished': {
        if (!/^[a-f0-9-]{36}$/.test(body.owner) || !['complete','failed','stopped'].includes(body.status) ||
          !Number.isInteger(body.attempted) || body.attempted < 0 || !Number.isInteger(body.failed) || body.failed < 0) error('Invalid worker report');
        await db.prepare(`UPDATE audio_worker_runs SET status = ?,finished_at = ?,heartbeat_at = ?,attempted = ?,failed = ?,last_error = ? WHERE owner = ?`)
          .bind(body.status,timestamp,timestamp,body.attempted,body.failed,typeof body.error === 'string' ? body.error.slice(0,1000) : null,body.owner).run();
        await audioEvent(db,'Mac worker','runFinished',`Run ${body.status}: ${body.attempted} songs attempted, ${body.failed} failed`);
        return json({ok:true});
      }
      case 'progress': {
        await owned(db,body);
        if (!['downloading','processing','uploading','publishing'].includes(body.stage)) error('Invalid processing stage');
        await db.batch([
          db.prepare('UPDATE audio_worker_runs SET heartbeat_at = ? WHERE owner = ?').bind(timestamp,body.owner),
          db.prepare(`INSERT INTO audio_processing_events (track_ref,actor,action,message,created_at)
            SELECT ?,'Mac worker',?,?,? WHERE NOT EXISTS
            (SELECT 1 FROM audio_job_progress WHERE track_ref = ? AND owner = ? AND stage = ?)`)
            .bind(body.ref,body.stage,body.stage,timestamp,body.ref,body.owner,body.stage),
          db.prepare(`INSERT INTO audio_job_progress (track_ref,owner,stage,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(track_ref) DO UPDATE SET owner = excluded.owner,stage = excluded.stage,updated_at = excluded.updated_at`)
            .bind(body.ref,body.owner,body.stage,timestamp),
          db.prepare('DELETE FROM audio_processing_events WHERE id <= (SELECT MAX(id) - 2000 FROM audio_processing_events)'),
        ]);
        return json({ok:true});
      }
      case 'status': {
        const counts = await db.prepare(`SELECT r.status, COUNT(*) AS count FROM audio_renditions r
          JOIN audio_tracks t ON t.ref = r.track_ref WHERE t.active = 1 GROUP BY r.status`).all();
        const tracks = await db.prepare('SELECT COUNT(*) AS count FROM audio_tracks WHERE active = 1').first();
        return json({tracks: tracks?.count || 0, renditions: counts.results});
      }
      case 'sync': {
        if (!Array.isArray(body.tracks) || !body.tracks.length || body.tracks.length > 20) error('Expected 1–20 tracks');
        const tree = await archiveTree(bucket);
        const statements = [];
        for (const track of body.tracks) {
          if (!safePath(track.original_path) || !/\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$/i.test(track.original_path) ||
            track.original_path.startsWith('versions/') || track.ref !== trackRef(track.original_path) ||
            track.original_id !== originalId(track.original_path) || !validKey(track.storage_key) ||
            (track.ref.startsWith('video:') && track.storage_key !== track.ref.slice(6))) error('Invalid track');
          const source = tree.get(track.original_path);
          if (!source?.xetHash || source.size <= 0) error('Original absent from archive', 409);
          statements.push(db.prepare(`UPDATE audio_renditions SET status = 'pending', path = NULL, duration = NULL,
            bytes = NULL, sha256 = NULL, recipe = NULL, retry_after = 0, updated_at = ? WHERE track_ref = ?
            AND EXISTS (SELECT 1 FROM audio_tracks WHERE ref = ? AND original_hash != ?)`)
            .bind(timestamp, track.ref, track.ref, source.xetHash));
          statements.push(db.prepare(`INSERT INTO audio_tracks
            (ref, original_id, original_path, original_hash, storage_key, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ref) DO UPDATE SET original_path = excluded.original_path, original_hash = excluded.original_hash,
            active = 1, updated_at = excluded.updated_at,
            lease_owner = CASE WHEN audio_tracks.original_hash != excluded.original_hash THEN NULL ELSE lease_owner END,
            lease_until = CASE WHEN audio_tracks.original_hash != excluded.original_hash THEN 0 ELSE lease_until END`)
            .bind(track.ref, track.original_id, track.original_path, source.xetHash, track.storage_key, timestamp));
          for (const mode of MODES) {
            const file = track.versions?.[mode], archived = file && tree.get(file.path);
            const validPath = file && (file.path === renditionPath(track.storage_key, mode) ||
              file.path === `versions/${mode}/${track.storage_key}.mp3`);
            const ready = validPath && archived?.size > 0;
            statements.push(db.prepare(`INSERT INTO audio_renditions
              (track_ref, mode, status, path, duration, bytes, recipe, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(track_ref, mode) DO NOTHING`).bind(track.ref, mode, ready ? 'ready' : 'pending',
                ready ? file.path : null, ready && Number.isFinite(file.duration) && file.duration > 0 ? file.duration : null,
                ready ? archived.size : null, ready ? 'imported-aubatch' : null, timestamp));
          }
        }
        await db.batch(statements);
        return json({ok: true, synced: body.tracks.length});
      }
      case 'reconcile': {
        // Derive removals from a fresh complete archive, never a caller's partial scan.
        const tree = await archiveTree(bucket, true);
        const paths = JSON.stringify([...tree.keys()]);
        const originals = JSON.stringify([...tree.values()].filter(file => file.size > 0 &&
          !file.path.startsWith('versions/') && /\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$/i.test(file.path)).map(file => file.path));
        await db.prepare(`UPDATE audio_tracks SET active = 0, lease_owner = NULL, lease_until = 0
          WHERE original_path NOT IN (SELECT value FROM json_each(?))`).bind(originals).run();
        await db.prepare(`UPDATE audio_renditions SET status = 'pending', path = NULL, duration = NULL,
          bytes = NULL, retry_after = 0, updated_at = ? WHERE status = 'ready'
          AND path NOT IN (SELECT value FROM json_each(?))`).bind(timestamp, paths).run();
        return json({ok: true});
      }
      case 'claimOne':
      case 'claim': {
        const limit = body.limit ?? 1;
        if (!Number.isInteger(limit) || limit < 1 || limit > 4 || !/^[a-f0-9-]{36}$/.test(body.owner)) error('Invalid claim');
        const targeted = body.action === 'claimOne';
        if (targeted && (limit !== 1 || typeof body.ref !== 'string' || body.ref.length > 1024 || !body.ref)) error('Choose one track');
        const {results} = await db.prepare(`UPDATE audio_tracks SET lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE ref IN (SELECT t.ref FROM audio_tracks t WHERE active = 1 AND lease_until <= ?
          AND EXISTS (SELECT 1 FROM audio_renditions r WHERE r.track_ref = t.ref AND r.status != 'ready' AND retry_after <= ?)
          ${targeted ? 'AND t.ref = ?' : ''}
          ORDER BY t.ref LIMIT ?) AND lease_until <= ? RETURNING *`)
          .bind(body.owner, timestamp + LEASE_SECONDS, timestamp, timestamp, timestamp,...(targeted ? [body.ref] : []), limit, timestamp).all();
        for (const track of results) {
          await db.prepare(`UPDATE audio_renditions SET status = 'processing', attempts = attempts + 1, updated_at = ?
            WHERE track_ref = ? AND status != 'ready'`).bind(timestamp, track.ref).run();
          const rows = await db.prepare('SELECT mode, status, path FROM audio_renditions WHERE track_ref = ?').bind(track.ref).all();
          track.missing = rows.results.filter(row => row.status !== 'ready').map(row => row.mode);
        }
        return json({tracks: results, lease_seconds: LEASE_SECONDS});
      }
      case 'heartbeat': {
        await owned(db, body);
        const updated = await db.prepare(`UPDATE audio_tracks SET lease_until = ? WHERE ref = ? AND lease_owner = ? AND lease_until > ?`)
          .bind(timestamp + LEASE_SECONDS, body.ref, body.owner, timestamp).run();
        if (!updated.meta.changes) error('Lease expired', 409);
        await db.prepare('UPDATE audio_worker_runs SET heartbeat_at = ? WHERE owner = ?').bind(timestamp,body.owner).run();
        return json({ok: true});
      }
      case 'complete': {
        const track = await owned(db, body);
        if (!body.versions || typeof body.versions !== 'object' || Array.isArray(body.versions) ||
          !Object.keys(body.versions).length || Object.keys(body.versions).some(mode => !MODES.includes(mode as any))) error('Invalid renditions');
        const statements = [];
        for (const mode of MODES) {
          const file = body.versions[mode];
          if (!file) continue;
          if (file.path !== renditionPath(track.storage_key, mode) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
            !Number.isFinite(file.duration) || file.duration <= 0 || file.duration > 86400 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
            typeof file.recipe !== 'string' || file.recipe.length > 512) error('Invalid rendition');
          const response = await fetch(`https://huggingface.co/buckets/${bucket}/resolve/${file.path}`, {
            method: 'HEAD', signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok || Number(response.headers.get('content-length')) !== file.bytes) error('Uploaded file is absent or incomplete', 409);
          statements.push(db.prepare(`UPDATE audio_renditions SET status = 'ready', path = ?, duration = ?, bytes = ?,
            sha256 = ?, recipe = ?, retry_after = 0, last_error = NULL, updated_at = ?
            WHERE track_ref = ? AND mode = ? AND EXISTS
              (SELECT 1 FROM audio_tracks WHERE ref = ? AND active = 1 AND lease_owner = ? AND lease_until > ?)`)
            .bind(file.path, file.duration, file.bytes, file.sha256, file.recipe, now(), body.ref, mode, body.ref, body.owner, now()));
        }
        const updates = await db.batch(statements);
        if (updates.some(update => !update.meta.changes)) error('Lease expired during publication', 409);
        await db.prepare('UPDATE audio_tracks SET lease_owner = NULL, lease_until = 0 WHERE ref = ? AND lease_owner = ?')
          .bind(body.ref, body.owner).run();
        await finishTelemetry(db,body,'ready','Uploaded versions verified and published');
        return json({ok: true});
      }
      case 'fail': {
        await owned(db, body);
        const message = typeof body.error === 'string' ? body.error.slice(0, 1000) : 'Processing failed';
        await db.batch([
          db.prepare(`UPDATE audio_renditions SET status = 'failed', last_error = ?, retry_after = ?, updated_at = ?
            WHERE track_ref = ? AND status != 'ready' AND EXISTS
              (SELECT 1 FROM audio_tracks WHERE ref = ? AND lease_owner = ? AND lease_until > ?)`)
            .bind(message, timestamp + 300, timestamp, body.ref, body.ref, body.owner, timestamp),
          db.prepare('UPDATE audio_tracks SET lease_owner = NULL, lease_until = 0 WHERE ref = ? AND lease_owner = ?')
            .bind(body.ref, body.owner),
        ]);
        await finishTelemetry(db,body,'failed',message);
        return json({ok: true});
      }
      case 'relocate': {
        if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 40) error('Invalid relocation');
        const tree = await archiveTree(bucket, true), statements = [];
        for (const file of body.files) {
          const row = await db.prepare(`SELECT r.path, t.storage_key FROM audio_renditions r
            JOIN audio_tracks t ON t.ref = r.track_ref WHERE r.track_ref = ? AND r.mode = ? AND r.status = 'ready'`)
            .bind(file.ref, file.mode).first();
          if (!row || file.path !== renditionPath(row.storage_key, file.mode)) error('Invalid relocation');
          const before = tree.get(row.path), after = tree.get(file.path);
          if (!before?.xetHash || before.xetHash !== after?.xetHash || before.size !== after.size) error('Relocation has different contents', 409);
          statements.push(db.prepare('UPDATE audio_renditions SET path = ?, updated_at = ? WHERE track_ref = ? AND mode = ? AND path = ?')
            .bind(file.path, timestamp, file.ref, file.mode, row.path));
        }
        await db.batch(statements);
        return json({ok: true});
      }
      default: return json({error: 'Unknown action'}, 400);
    }
  } catch (cause: any) {
    return json({error: cause.status ? cause.message : 'Version registry operation failed'}, cause.status || 502);
  }
};
