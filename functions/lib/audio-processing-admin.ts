import { archiveTree, MODES, type VersionDatabase } from './version-registry';

const now = () => Math.floor(Date.now() / 1000);
const reject = (message: string, status = 400): never => { throw Object.assign(new Error(message), {status}); };
const joined = `SELECT t.ref, t.original_id, t.original_path, t.original_hash, t.storage_key,
  t.active, t.lease_until, t.updated_at, p.stage, p.updated_at AS stage_updated_at,
  r.mode, r.status, r.path, r.duration, r.bytes, r.sha256, r.recipe, r.attempts,
  r.retry_after, r.last_error, r.updated_at AS rendition_updated_at
  FROM audio_tracks t LEFT JOIN audio_job_progress p ON p.track_ref = t.ref
  LEFT JOIN audio_renditions r ON r.track_ref = t.ref`;

export function groupAudioRows(rows: any[], timestamp = now()): any[] {
  const tracks = new Map<string, any>();
  for (const row of rows) {
    if (!tracks.has(row.ref)) tracks.set(row.ref, {
      ref:row.ref, original_id:row.original_id, original_path:row.original_path,
      original_hash:row.original_hash, storage_key:row.storage_key, active:!!row.active,
      lease_until:row.lease_until, updated_at:row.updated_at, stage:row.stage,
      stage_updated_at:row.stage_updated_at, versions:{},
    });
    if (row.mode) tracks.get(row.ref).versions[row.mode] = {
      status:row.status,path:row.path,duration:row.duration,bytes:row.bytes,sha256:row.sha256,
      recipe:row.recipe,attempts:row.attempts,retry_after:row.retry_after,last_error:row.last_error,
      updated_at:row.rendition_updated_at,
    };
  }
  return [...tracks.values()].map(track => {
    const versions = MODES.map(mode => track.versions[mode]?.status || 'pending');
    track.status = !track.active ? 'inactive' : versions.every(status => status === 'ready') ? 'ready'
      : track.lease_until > timestamp ? 'processing'
      : versions.includes('processing') ? 'expired' : versions.includes('failed') ? 'failed' : 'pending';
    return track;
  });
}

export async function audioEvent(db: VersionDatabase, actor: string, action: string, message: string, ref: string | null = null): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO audio_processing_events (track_ref,actor,action,message,created_at) VALUES (?,?,?,?,?)')
      .bind(ref,actor,action,message.slice(0,1000),now()),
    db.prepare('DELETE FROM audio_processing_events WHERE id <= (SELECT MAX(id) - 2000 FROM audio_processing_events)'),
  ]);
}

export async function audioAdmin(db: VersionDatabase, body: any, actor: string, bucket: string): Promise<any> {
  const timestamp = now();
  if (body.action === 'audioOverview' || body.action === 'audioJobs') {
    // One bounded registry snapshot keeps search, counts and status filters in sync.
    const {results} = await db.prepare(joined + ' ORDER BY t.ref, r.mode LIMIT 20000').all();
    const tracks = groupAudioRows(results,timestamp);
    if (body.action === 'audioJobs') return {tracks,at:timestamp};
    const counts = {total:tracks.length,ready:0,pending:0,processing:0,failed:0,expired:0,inactive:0};
    for (const track of tracks) counts[track.status]++;
    const versions = {ready:0,pending:0,processing:0,failed:0,bytes:0};
    for (const track of tracks.filter(track => track.active)) for (const rendition of Object.values<any>(track.versions)) {
      versions[rendition.status]++;
      if (rendition.status === 'ready') versions.bytes += rendition.bytes || 0;
    }
    const runs = await db.prepare('SELECT host,parallelism,recipe,status,started_at,heartbeat_at,finished_at,attempted,failed,last_error FROM audio_worker_runs ORDER BY started_at DESC LIMIT 12').all();
    const events = await db.prepare('SELECT id,track_ref,actor,action,message,created_at FROM audio_processing_events ORDER BY id DESC LIMIT 40').all();
    return {counts,versions,runs:runs.results,events:events.results,at:timestamp,
      last_sync:Math.max(0,...tracks.map(track => track.updated_at)),tracks};
  }
  if (body.action === 'audioJob') {
    if (typeof body.ref !== 'string' || body.ref.length > 1024) reject('Choose a song');
    const rows = await db.prepare(joined + ' WHERE t.ref = ?').bind(body.ref).all();
    const track = groupAudioRows(rows.results,timestamp)[0];
    if (!track) reject('Song not found',404);
    const events = await db.prepare('SELECT id,actor,action,message,created_at FROM audio_processing_events WHERE track_ref = ? ORDER BY id DESC LIMIT 50').bind(body.ref).all();
    return {track,events:events.results,at:timestamp};
  }
  if (body.action === 'audioReconcile') {
    const tree = await archiveTree(bucket,true);
    const paths = JSON.stringify([...tree.keys()]);
    const originals = JSON.stringify([...tree.values()].filter(file => file.size > 0 && !file.path.startsWith('versions/') && /\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$/i.test(file.path)).map(file => file.path));
    await db.batch([
      db.prepare('UPDATE audio_tracks SET active = 0, lease_owner = NULL, lease_until = 0 WHERE original_path NOT IN (SELECT value FROM json_each(?))').bind(originals),
      db.prepare(`UPDATE audio_renditions SET status = 'pending',path = NULL,duration = NULL,bytes = NULL,
        retry_after = 0,updated_at = ? WHERE status = 'ready' AND path NOT IN (SELECT value FROM json_each(?))`).bind(timestamp,paths),
    ]);
    await audioEvent(db,actor,'reconcile','Checked registry files against the complete Hugging Face archive');
    return {ok:true};
  }
  if (!['audioRetry','audioRecover','audioRegenerate'].includes(body.action)) reject('Unknown processing action');
  let refs: string[];
  if (body.all === true && body.action !== 'audioRegenerate') {
    const {results} = await db.prepare(`SELECT DISTINCT t.ref FROM audio_tracks t JOIN audio_renditions r ON r.track_ref = t.ref
      WHERE t.active = 1 AND t.lease_until <= ? AND r.status = ?`).bind(timestamp,body.action === 'audioRecover' ? 'processing' : 'failed').all();
    refs = results.map(row => row.ref);
  } else {
    if (!Array.isArray(body.refs) || !body.refs.length || body.refs.length > 100 || body.refs.some(ref => typeof ref !== 'string' || ref.length > 1024)) reject('Choose 1–100 songs');
    refs = [...new Set<string>(body.refs)];
  }
  if (body.action === 'audioRegenerate' && (refs.length !== 1 || !MODES.includes(body.mode))) reject('Choose one song and version');
  // Acquire a short administrative lease atomically. A running worker can never
  // be reset, and a simultaneous claim cannot slip between validation and update.
  const adminOwner = crypto.randomUUID();
  const expected = body.expected_updated_at;
  const acquired = await db.prepare(`UPDATE audio_tracks SET lease_owner = ?,lease_until = ?
    WHERE ref IN (SELECT value FROM json_each(?)) AND active = 1 AND lease_until <= ?
    ${body.action !== 'audioRegenerate' ? `AND EXISTS (SELECT 1 FROM audio_renditions r WHERE r.track_ref = audio_tracks.ref AND ${body.action === 'audioRecover' ? "r.status = 'processing'" : "r.status != 'ready'"})` : ''}
    ${body.action === 'audioRegenerate' ? 'AND EXISTS (SELECT 1 FROM audio_renditions r WHERE r.track_ref = audio_tracks.ref AND r.mode = ? AND r.updated_at = ?)' : ''}
    RETURNING ref`).bind(adminOwner,timestamp + 60,JSON.stringify(refs),timestamp,
      ...(body.action === 'audioRegenerate' ? [body.mode,expected] : [])).all();
  const accepted = acquired.results.map(row => row.ref);
  if (refs.length && !accepted.length) reject('These songs are active, unavailable, or changed. Refresh and try again.',409);
  const keys = JSON.stringify(accepted);
  if (accepted.length) await db.batch([
    db.prepare(`UPDATE audio_renditions SET status = 'pending',retry_after = 0,updated_at = ?,
      path = NULL,duration = NULL,bytes = NULL,sha256 = NULL,recipe = NULL
      WHERE track_ref IN (SELECT value FROM json_each(?)) AND ${body.action === 'audioRegenerate' ? 'mode = ?' : "status != 'ready'"}
      AND EXISTS (SELECT 1 FROM audio_tracks t WHERE t.ref = track_ref AND t.lease_owner = ?)`)
      .bind(timestamp,keys,...(body.action === 'audioRegenerate' ? [body.mode] : []),adminOwner),
    db.prepare('DELETE FROM audio_job_progress WHERE track_ref IN (SELECT value FROM json_each(?))').bind(keys),
    db.prepare(`INSERT INTO audio_processing_events (track_ref,actor,action,message,created_at)
      SELECT value,?,?,?,? FROM json_each(?)`)
      .bind(actor,body.action,body.action === 'audioRegenerate' ? `Queued ${body.mode} for regeneration` : 'Queued unfinished versions for the next manual worker run',timestamp,keys),
    db.prepare('UPDATE audio_tracks SET lease_owner = NULL,lease_until = 0 WHERE lease_owner = ?').bind(adminOwner),
    db.prepare('DELETE FROM audio_processing_events WHERE id <= (SELECT MAX(id) - 2000 FROM audio_processing_events)'),
  ]);
  return {ok:true,queued:accepted.length,skipped:refs.length - accepted.length};
}
