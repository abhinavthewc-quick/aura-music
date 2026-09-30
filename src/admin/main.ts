import sodium from 'libsodium-wrappers';
import './admin.css';

const API = 'https://api.github.com';
const WORKFLOW_FILE = 'upload-music.yml';
const SECRET_NAMES = ['HF_TOKEN', 'HF_BUCKET_ID', 'YOUTUBE_COOKIES'] as const;
const LS_PAT = 'auraAdmin_pat';
const LS_REPO = 'auraAdmin_repo';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing #' + id);
  return el as T;
};

const patInput = $<HTMLInputElement>('patInput');
const repoInput = $<HTMLInputElement>('repoInput');
const urlsInput = $<HTMLTextAreaElement>('urlsInput');
const cookiesInput = $<HTMLTextAreaElement>('cookiesInput');
const cfgStatus = $('cfgStatus');
const secretsStatus = $('secretsStatus');
const downloadStatus = $('downloadStatus');
const secretChips = $('secretChips');
const previewList = $('previewList');
const runsList = $('runsList');
const urlCount = $('urlCount');
const toastHost = $('toastHost');

/* ---------- storage ---------- */
const getPat = () => localStorage.getItem(LS_PAT) || '';
const getRepo = () => localStorage.getItem(LS_REPO) || '';

/* ---------- toast ---------- */
function toast(msg: string, kind: 'ok' | 'err' | '' = '') {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function setStatus(el: HTMLElement, msg: string, kind: 'ok' | 'err' | '' = '') {
  el.textContent = msg;
  el.className = 'adm-status ' + kind;
}

/* ---------- github api ---------- */
async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const pat = getPat();
  if (!pat) throw new Error('No GitHub token — save one in step 1 first.');
  if (!getRepo() && path.includes('{repo}')) throw new Error('No repository set — save owner/name in step 1 first.');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + pat,
  };
  if (init?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path.split('{repo}').join(getRepo()), { ...init, headers });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      if (j.message) msg += ' — ' + j.message;
    } catch { /* keep status */ }
    if (res.status === 401) msg += ' (token invalid or expired)';
    if (res.status === 404) msg += ' (repo not found or token lacks access)';
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/* ---------- secrets ---------- */
async function saveSecret(name: string, value: string) {
  if (!value.trim()) throw new Error('Empty value — nothing to save.');
  const pub = await api<{ key: string; key_id: string }>(
    '/repos/{repo}/actions/secrets/public-key',
  );
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(pub.key, sodium.base64_variants.ORIGINAL),
  );
  await api('/repos/{repo}/actions/secrets/' + name, {
    method: 'PUT',
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id: pub.key_id,
    }),
  });
}

async function deleteSecret(name: string) {
  await api('/repos/{repo}/actions/secrets/' + name, { method: 'DELETE' });
}

async function refreshSecretChips() {
  try {
    const data = await api<{ secrets: { name: string }[] }>('/repos/{repo}/actions/secrets?per_page=100');
    const have = new Set(data.secrets.map((s) => s.name));
    secretChips.innerHTML = '';
    for (const name of SECRET_NAMES) {
      const chip = document.createElement('span');
      chip.className = 'adm-chip' + (have.has(name) ? '' : ' missing');
      chip.textContent = (have.has(name) ? '✓ ' : '✗ ') + name;
      secretChips.appendChild(chip);
    }
  } catch {
    secretChips.innerHTML = '<span class="adm-chip dim">could not check secrets</span>';
  }
}

/* ---------- preview ---------- */
const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/;

function parseUrls(): string[] {
  const lines = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!YT_RE.test(l)) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function updateUrlCount() {
  const all = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const valid = parseUrls().length;
  if (!all.length) { urlCount.textContent = ''; return; }
  urlCount.textContent = valid === all.length ? `${valid} link${valid === 1 ? '' : 's'} ready` : `${valid}/${all.length} valid YouTube links`;
}

interface Oembed { title: string; author_name: string; thumbnail_url: string; }

async function fetchInfo(url: string): Promise<Oembed | null> {
  const res = await fetch(
    'https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json',
  );
  if (!res.ok) return null;
  return (await res.json()) as Oembed;
}

async function previewLinks() {
  const urls = parseUrls();
  previewList.innerHTML = '';
  updateUrlCount();
  if (!urls.length) return;
  previewList.innerHTML = '<span class="adm-chip dim">fetching titles…</span>';
  const results = await Promise.allSettled(
    urls.map(async (u) => ({ u, info: await fetchInfo(u) })),
  );
  previewList.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'adm-prev-item';
    if (r.status === 'fulfilled' && r.value.info) {
      const { u, info } = r.value;
      item.innerHTML =
        `<img src="" alt="">` +
        `<div><div class="t"></div><div class="s"></div></div>`;
      (item.querySelector('img') as HTMLImageElement).src = info.thumbnail_url;
      item.querySelector('.t')!.textContent = info.title;
      item.querySelector('.s')!.textContent = info.author_name + ' · ' + YT_RE.exec(u)?.[1];
    } else {
      item.classList.add('bad');
      item.innerHTML = '<div><div class="t">Could not read this link</div><div class="s">not a valid YouTube URL?</div></div>';
    }
    previewList.appendChild(item);
  }
}

/* ---------- dispatch ---------- */
async function dispatchDownload() {
  const urls = parseUrls();
  if (!urls.length) throw new Error('Paste at least one valid YouTube link first.');
  await api('/repos/{repo}/actions/workflows/' + WORKFLOW_FILE + '/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { urls: urls.join('\n') } }),
  });
}

/* ---------- runs ---------- */
interface Run {
  id: number; status: string; conclusion: string | null;
  created_at: string; html_url: string; display_title: string;
}

async function refreshRuns() {
  try {
    const data = await api<{ workflow_runs: Run[] }>(
      `/repos/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=8`,
    );
    const runs = data.workflow_runs || [];
    if (!runs.length) {
      runsList.innerHTML = '<span class="adm-chip dim">no runs yet — start a download above</span>';
      return;
    }
    runsList.innerHTML = '';
    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'adm-run';
      const when = new Date(run.created_at).toLocaleString();
      const label = run.conclusion || run.status;
      row.innerHTML =
        `<span class="dot ${label}"></span>` +
        `<span class="title"></span>` +
        `<span class="meta">${label} · ${when}</span>` +
        `<a href="${run.html_url}" target="_blank" rel="noopener">logs</a>`;
      row.querySelector('.title')!.textContent = run.display_title;
      runsList.appendChild(row);
    }
  } catch {
    runsList.innerHTML = '<span class="adm-chip dim">could not load runs</span>';
  }
}

/* ---------- wiring ---------- */
function bind() {
  patInput.value = getPat();
  repoInput.value = getRepo();

  $('patRevealBtn').addEventListener('click', () => {
    const show = patInput.type === 'password';
    patInput.type = show ? 'text' : 'password';
    $('patRevealBtn').textContent = show ? 'Hide' : 'Show';
  });

  $('patSaveBtn').addEventListener('click', () => {
    localStorage.setItem(LS_PAT, patInput.value.trim());
    setStatus(cfgStatus, 'Token saved locally.', 'ok');
    toast('Token saved', 'ok');
    refreshSecretChips();
  });

  $('repoSaveBtn').addEventListener('click', () => {
    const v = repoInput.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    if (!/^[^/\s]+\/[^/\s]+$/.test(v)) { setStatus(cfgStatus, 'Repo must look like owner/name.', 'err'); return; }
    localStorage.setItem(LS_REPO, v);
    repoInput.value = v;
    setStatus(cfgStatus, 'Repository saved: ' + v, 'ok');
    refreshSecretChips();
    refreshRuns();
  });

  $('testBtn').addEventListener('click', async () => {
    const btn = $('testBtn');
    btn.disabled = true;
    setStatus(cfgStatus, 'Testing…');
    try {
      const repo = await api<{ full_name: string; private: boolean; default_branch: string }>(
        '/repos/{repo}',
      );
      setStatus(cfgStatus, `✓ Connected to ${repo.full_name} (${repo.private ? 'private' : 'public'}, branch ${repo.default_branch})`, 'ok');
      refreshSecretChips();
      refreshRuns();
    } catch (e) {
      setStatus(cfgStatus, '✗ ' + (e as Error).message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('hfTokenSaveBtn').addEventListener('click', async () => {
    try {
      await saveSecret('HF_TOKEN', $('hfTokenInput').value);
      ($('hfTokenInput') as HTMLInputElement).value = '';
      setStatus(secretsStatus, 'HF_TOKEN saved.', 'ok');
      toast('HF_TOKEN secret saved', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('hfBucketSaveBtn').addEventListener('click', async () => {
    try {
      const v = ($('hfBucketInput') as HTMLInputElement).value.trim();
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v)) {
        throw new Error('Bucket id must look like namespace/name, e.g. yourname/aura-music.');
      }
      await saveSecret('HF_BUCKET_ID', v);
      setStatus(secretsStatus, 'HF_BUCKET_ID saved.', 'ok');
      toast('HF_BUCKET_ID secret saved', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('cookiesSaveBtn').addEventListener('click', async () => {
    try {
      const val = cookiesInput.value;
      if (!/#( Netscape HTTP Cookie File|http.cookie)/i.test(val) && !/^\S+\s+TRUE\s+\//m.test(val)) {
        throw new Error('This does not look like a Netscape cookies.txt file.');
      }
      await saveSecret('YOUTUBE_COOKIES', val);
      setStatus(secretsStatus, 'YOUTUBE_COOKIES saved.', 'ok');
      toast('YouTube cookies uploaded', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('cookiesClearBtn').addEventListener('click', async () => {
    try {
      await deleteSecret('YOUTUBE_COOKIES');
      cookiesInput.value = '';
      setStatus(secretsStatus, 'YOUTUBE_COOKIES removed.', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('cookiesFile').addEventListener('change', async () => {
    const input = $<HTMLInputElement>('cookiesFile');
    const file = input.files?.[0];
    if (!file) return;
    cookiesInput.value = await file.text();
    toast('Loaded ' + file.name, 'ok');
    input.value = '';
  });

  let previewTimer: number | undefined;
  urlsInput.addEventListener('input', () => {
    updateUrlCount();
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => { previewLinks().catch(() => {}); }, 700);
  });

  $('fetchBtn').addEventListener('click', () => {
    previewLinks().catch(() => toast('Title fetch failed (network?)', 'err'));
  });

  $('downloadBtn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('downloadBtn');
    btn.disabled = true;
    setStatus(downloadStatus, 'Starting GitHub Actions run…');
    try {
      await dispatchDownload();
      setStatus(downloadStatus, '✓ Workflow dispatched — watch it below.', 'ok');
      toast('Download started on GitHub Actions', 'ok');
      urlsInput.value = '';
      previewList.innerHTML = '';
      updateUrlCount();
      setTimeout(refreshRuns, 2500);
    } catch (e) {
      setStatus(downloadStatus, '✗ ' + (e as Error).message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('runsRefreshBtn').addEventListener('click', () => refreshRuns());

  window.setInterval(() => {
    if (document.visibilityState === 'visible' && getPat() && getRepo()) refreshRuns();
  }, 10000);
}

bind();
if (getPat() && getRepo()) {
  refreshSecretChips();
  refreshRuns();
}
