import { hfFileUrl, parseTrackName } from '../core/catalog';

type Mode = 'bass' | 'bass-reverb';
type Version = {status:string;path:string|null;bytes:number|null;duration:number|null;sha256:string|null;recipe:string|null;attempts:number;retry_after:number;last_error:string|null;updated_at:number};
type Track = {ref:string;original_id:string;original_path:string;original_hash:string;storage_key:string;active:boolean;lease_until:number;updated_at:number;stage:string|null;stage_updated_at:number|null;status:string;versions:Partial<Record<Mode,Version>>};
type Event = {id:number;track_ref?:string;actor:string;action:string;message:string;created_at:number};
type Overview = {counts:Record<string,number>;versions:{ready:number;pending:number;processing:number;failed:number;bytes:number};tracks:Track[];at:number;last_sync:number;runs:any[];events:Event[]};
const labels:Record<string,string> = {ready:'Ready',pending:'Pending',processing:'Processing',failed:'Failed',expired:'Expired lease',inactive:'Original unavailable',downloading:'Downloading',uploading:'Uploading',publishing:'Publishing',bass:'Bass','bass-reverb':'Bass + Reverb'};
const escape = (value:unknown) => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const date = (value:number) => value ? new Date(value * 1000).toLocaleString() : 'Not reported';
const bytes = (value:number) => !value ? 'Not reported' : value >= 1024**3 ? `${(value / 1024**3).toFixed(2)} GB` : `${(value / 1024**2).toFixed(1)} MB`;
const badge = (status:string,text = labels[status] || status) => `<span class="audio-badge ${escape(status)}">${escape(text)}</span>`;
const name = (track:Track) => parseTrackName(track.original_path);
const eligible = (track:Track) => track.active && !['ready','processing'].includes(track.status);
const command = '/Users/thegt/.local/bin/aura-version-worker --once';

export function createAudioProcessing(options:{api:<T=any>(action:string,payload?:Record<string,unknown>)=>Promise<T>;toast:(message:string,kind?:'ok'|'err'|'')=>void}) {
  const el = <T extends HTMLElement=HTMLElement>(id:string) => document.getElementById(id) as T;
  const inspector = el<HTMLDialogElement>('audioInspector');
  let data:Overview|null = null, page = 0, busy = false, loading = false, timer:number|undefined, generation = 0;
  let inspected:string|null = null;
  const selected = new Set<string>();
  const visible = () => !el('panelProcessing').hidden && document.visibilityState === 'visible';
  const status = (message:string,error=false) => {el('audioStatus').textContent=message;el('audioStatus').className='adm-status '+(error ? 'err' : '');};
  const filtered = () => {
    const query=el<HTMLInputElement>('audioSearch').value.toLowerCase().trim(), filter=el<HTMLSelectElement>('audioFilter').value;
    const ranks:Record<string,number>={failed:0,expired:1,processing:2,pending:3,inactive:4,ready:5};
    return (data?.tracks || []).filter(track => (filter==='all' || filter==='attention' && ['failed','expired'].includes(track.status) || track.status===filter) &&
      (!query || [track.original_path,track.ref,...Object.values(track.versions).map(version => version.last_error || '')].join(' ').toLowerCase().includes(query)))
      .sort((a,b) => el<HTMLSelectElement>('audioSort').value==='recent' ? Math.max(...Object.values(b.versions).map(v=>v.updated_at),b.updated_at)-Math.max(...Object.values(a.versions).map(v=>v.updated_at),a.updated_at) :
        (el<HTMLSelectElement>('audioSort').value==='attention' ? ranks[a.status]-ranks[b.status] : 0) || name(a).title.localeCompare(name(b).title));
  };
  function controls() {
    el<HTMLButtonElement>('audioRetryFailed').disabled=busy || !data?.counts.failed;
    el<HTMLButtonElement>('audioRecover').disabled=busy || !data?.counts.expired;
    for (const id of ['audioReconcile','audioExport']) el<HTMLButtonElement>(id).disabled=busy || !data;
    el<HTMLButtonElement>('audioRetrySelected').disabled=busy || !selected.size;
    el('audioRetrySelected').textContent=selected.size ? `Queue selected (${selected.size})` : 'Queue selected';
    el<HTMLButtonElement>('audioRefresh').disabled=busy || loading;
  }
  function renderJobs() {
    const tracks=filtered();page=Math.max(0,Math.min(page,Math.ceil(tracks.length/40)-1));
    const current=tracks.slice(page*40,(page+1)*40);
    el('audioJobs').innerHTML=current.length ? `<table class="audio-table"><thead><tr><th scope="col"><span class="audio-sr">Select</span></th><th scope="col">Song</th><th scope="col">Bass</th><th scope="col">Bass + Reverb</th><th scope="col">Job</th><th scope="col">Details</th></tr></thead><tbody>${current.map(track => {
      const n=name(track),error=Object.values(track.versions).find(v=>v.last_error)?.last_error;
      const stage=track.status==='processing' && track.stage && !['ready','failed'].includes(track.stage) ? labels[track.stage] : labels[track.status];
      return `<tr data-track-ref="${escape(track.ref)}"><td><input type="checkbox" data-audio-select="${escape(track.ref)}" aria-label="Select ${escape(n.title)}" ${selected.has(track.ref)?'checked':''} ${eligible(track)&&!busy?'':'disabled'}></td><td class="audio-song"><strong>${escape(n.title)}</strong><span>${escape(n.artist)}</span>${error&&['failed','expired'].includes(track.status)?`<small class="audio-error">${escape(error)}</small>`:''}</td>${(['bass','bass-reverb'] as Mode[]).map(mode=>`<td data-label="${labels[mode]}">${badge(track.versions[mode]?.status || 'pending')}</td>`).join('')}<td data-label="Job">${badge(track.status,stage)}${track.status==='processing'?`<small>Lease until ${escape(date(track.lease_until))}</small>`:''}</td><td><button class="adm-btn ghost small" type="button" data-audio-inspect="${escape(track.ref)}" aria-label="Inspect ${escape(n.title)}">Inspect</button></td></tr>`;
    }).join('')}</tbody></table>` : `<div class="audio-empty"><strong>${data?.tracks.length ? 'No matching songs' : 'No processing records yet'}</strong><p>${data?.tracks.length ? 'Change the search or status filter to see more songs.' : 'Run the Mac worker once to scan your archive and register songs.'}</p></div>`;
    el('audioJobs').setAttribute('aria-busy','false');
    el('audioPageInfo').textContent=tracks.length ? `${page*40+1}–${Math.min((page+1)*40,tracks.length)} of ${tracks.length} songs` : '0 songs';
    el<HTMLButtonElement>('audioPrev').disabled=page===0;el<HTMLButtonElement>('audioNext').disabled=(page+1)*40>=tracks.length;
    const checkbox=el<HTMLInputElement>('audioSelectPage'), selectable=current.filter(eligible);
    checkbox.disabled=!selectable.length || busy;checkbox.checked=selectable.length>0&&selectable.every(track=>selected.has(track.ref));
    checkbox.indeterminate=selectable.some(track=>selected.has(track.ref))&&!checkbox.checked;
    controls();
  }
  const events = (items:Event[]) => items.length ? `<ol class="audio-events">${items.map(event=>`<li><time>${escape(date(event.created_at))}</time><div><strong>${escape(event.message)}</strong><span>${escape(event.actor)}${event.track_ref?` · ${escape(event.track_ref)}`:''}</span></div></li>`).join('')}</ol>` : '<p class="adm-hint">No activity recorded yet.</p>';
  function render() {
    if (!data) return;
    el('audioSummary').innerHTML=[['ready','Fully ready'],['pending','Pending'],['processing','Processing'],['failed','Failed'],['expired','Expired leases']].map(([key,label])=>`<button type="button" data-audio-filter="${key}" aria-label="Show ${label.toLowerCase()} songs"><strong>${data.counts[key]}</strong><span>${label}</span></button>`).join('');
    const total=(data.counts.total-data.counts.inactive)*2;
    el<HTMLProgressElement>('audioCoverage').max=Math.max(1,total);el<HTMLProgressElement>('audioCoverage').value=data.versions.ready;
    el('audioCoverageText').textContent=`${data.versions.ready} / ${total} · ${bytes(data.versions.bytes)}`;
    const run=data.runs[0];
    el('audioWorkerInfo').textContent=run ? `${run.host}: ${run.status==='running' ? data.at-run.heartbeat_at<240 ? 'reporting' : 'no recent heartbeat' : run.status}. ${run.parallelism} lanes. Last report ${date(run.heartbeat_at)}. ${run.status!=='running'?`${run.attempted} attempted, ${run.failed} failed.`:''}` : 'No run reported yet. Launch the updated Mac worker manually to send stages and heartbeats.';
    el('audioActivity').innerHTML=events(data.events);
    for (const ref of selected) if (!data.tracks.some(track=>track.ref===ref&&eligible(track))) selected.delete(ref);
    renderJobs();
  }
  async function load() {
    if (loading || busy || !visible()) return;
    const current=++generation;loading=true;controls();
    if (!data) status('Loading audio processing records…');
    try {
      const next=await options.api<Overview>('audioOverview');
      if (current!==generation || !visible()) return;
      data=next;render();status(`Updated ${date(data.at)}. ${data.counts.total} songs registered${data.counts.inactive?`, ${data.counts.inactive} originals unavailable`:''}.`);
    } catch (cause) {if (current===generation) status(`${(cause as Error).message}${data?' Showing the last successful snapshot.':''}`,true);}
    finally {if(current===generation){loading=false;controls();}}
  }
  async function inspect(ref:string) {
    inspected=ref;
    inspector.innerHTML='<form method="dialog"><button type="submit" class="adm-btn ghost" aria-label="Close song details">Close</button></form><h2 id="audioInspectorTitle">Song details</h2><p>Loading…</p>';
    if (!inspector.open) inspector.showModal();
    try {
      const detail=await options.api<{track:Track;events:Event[];at:number}>('audioJob',{ref});
      if (inspected!==ref || !inspector.open) return;
      const track=detail.track,n=name(track);
      inspector.innerHTML=`<form method="dialog"><button type="submit" class="adm-btn ghost" aria-label="Close song details">Close</button></form><h2 id="audioInspectorTitle">${escape(n.title)}</h2><p class="adm-hint">${escape(n.artist)} ${badge(track.status)}</p>
        <dl class="audio-metadata"><dt>Song ID</dt><dd>${escape(track.ref)}</dd><dt>Original file</dt><dd>${escape(track.original_path)}</dd><dt>Original content hash</dt><dd>${escape(track.original_hash)}</dd><dt>Last registry update</dt><dd>${escape(date(track.updated_at))}</dd><dt>Worker stage</dt><dd>${escape(track.stage ? labels[track.stage] || track.stage : 'Not reported')}${track.stage_updated_at?` · ${escape(date(track.stage_updated_at))}`:''}</dd><dt>Lease</dt><dd>${escape(track.lease_until ? `${track.lease_until>detail.at?'Active until':'Expired at'} ${date(track.lease_until)}` : 'No active lease')}</dd></dl>
        <div class="audio-version-details">${(['bass','bass-reverb'] as Mode[]).map(mode=>{
          const v=track.versions[mode];
          const retry=v?.status==='ready' ? 'Not queued' : !track.active ? 'Original unavailable' : track.lease_until>detail.at ? 'Active job' : v?.retry_after>detail.at ? date(v.retry_after) : 'Next manual run';
          return `<section><h3>${labels[mode]} ${badge(v?.status || 'pending')}</h3><dl class="audio-metadata"><dt>Attempts</dt><dd>${v?.attempts || 0}</dd><dt>Updated</dt><dd>${escape(date(v?.updated_at))}</dd><dt>Size / duration</dt><dd>${escape(bytes(v?.bytes))} / ${v?.duration?`${Math.round(v.duration)} seconds`:'Not reported'}</dd><dt>Retry eligible</dt><dd>${escape(retry)}</dd><dt>Published file</dt><dd>${v?.path?`<a href="${escape(hfFileUrl(v.path))}" target="_blank" rel="noopener noreferrer">${escape(v.path)}</a>`:'Not published'}</dd><dt>SHA-256</dt><dd>${escape(v?.sha256 || 'Not reported')}</dd><dt>Processing recipe</dt><dd>${escape(v?.recipe || 'Not reported')}</dd></dl>${v?.last_error?`<p class="audio-error">Last error: ${escape(v.last_error)}</p>`:''}
          ${v?.status==='ready'&&track.active&&track.lease_until<=detail.at?`<button class="adm-btn" type="button" data-audio-regenerate="${mode}" data-ref="${escape(ref)}" data-revision="${v.updated_at}">Regenerate ${labels[mode]}</button>`:''}</section>`;
        }).join('')}</div>${eligible(track)?`<button class="adm-btn primary" type="button" data-audio-retry="${escape(ref)}">Queue unfinished versions</button>`:''}<h3>Song activity</h3>${events(detail.events)}`;
    } catch(cause) {if(inspected===ref&&inspector.open) inspector.innerHTML=`<form method="dialog"><button type="submit" class="adm-btn ghost">Close</button></form><h2 id="audioInspectorTitle">Could not load song details</h2><p role="alert">${escape((cause as Error).message)}</p>`;}
  }
  async function mutate(action:string,payload:Record<string,unknown>,question:string) {
    if (busy || !window.confirm(question)) return;
    busy=true;controls();renderJobs();status('Updating processing records…');
    try {
      const result=await options.api<{queued?:number;skipped?:number}>(action,payload);
      options.toast(result.queued!==undefined ? `Queued ${result.queued} songs${result.skipped?`; ${result.skipped} skipped`:''}. Run the Mac worker to process them.` : 'Archive files checked.','ok');
      selected.clear();busy=false;await load();
      if(inspected&&inspector.open) await inspect(inspected);
    } catch(cause) {status((cause as Error).message,true);options.toast((cause as Error).message,'err');}
    finally{busy=false;controls();renderJobs();}
  }
  el('audioRefresh').addEventListener('click',()=>{void load();});
  for(const id of ['audioSearch','audioFilter','audioSort']) el(id).addEventListener(id==='audioSearch'?'input':'change',()=>{page=0;selected.clear();renderJobs();});
  el('audioSummary').addEventListener('click',event=>{const key=(event.target as HTMLElement).closest<HTMLElement>('[data-audio-filter]')?.dataset.audioFilter;if(key){el<HTMLSelectElement>('audioFilter').value=key;page=0;selected.clear();renderJobs();}});
  el('audioJobs').addEventListener('click',event=>{const ref=(event.target as HTMLElement).closest<HTMLElement>('[data-audio-inspect]')?.dataset.audioInspect;if(ref)void inspect(ref);});
  el('audioJobs').addEventListener('change',event=>{const checkbox=event.target as HTMLInputElement;if(checkbox.dataset.audioSelect){checkbox.checked?selected.add(checkbox.dataset.audioSelect):selected.delete(checkbox.dataset.audioSelect);renderJobs();}});
  el('audioSelectPage').addEventListener('change',()=>{for(const track of filtered().slice(page*40,(page+1)*40).filter(eligible))el<HTMLInputElement>('audioSelectPage').checked?selected.add(track.ref):selected.delete(track.ref);renderJobs();});
  el('audioPrev').addEventListener('click',()=>{page--;renderJobs();});el('audioNext').addEventListener('click',()=>{page++;renderJobs();});
  el('audioRetrySelected').addEventListener('click',()=>{void mutate('audioRetry',{refs:[...selected]},'Queue unfinished versions for the selected songs? Ready versions are preserved.');});
  el('audioRetryFailed').addEventListener('click',()=>{void mutate('audioRetry',{all:true},'Queue all failed songs for the next manual worker run?');});
  el('audioRecover').addEventListener('click',()=>{void mutate('audioRecover',{all:true},'Release expired job leases and queue their unfinished versions? Active workers are preserved.');});
  el('audioReconcile').addEventListener('click',()=>{void mutate('audioReconcile',{},'Check registry files against Hugging Face? Missing files will be marked pending or unavailable.');});
  el('audioCopyCommand').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(command);options.toast('Run command copied. Paste it into Terminal on your Mac.','ok');}catch{status(`Run on your Mac: ${command}`);}});
  el('audioExport').addEventListener('click',()=>{
    const cell=(value:unknown)=>`"${String(value??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')}"`;
    const rows=[['Song','Artist','ID','Original','Job status','Version','Version status','Bytes','Duration','Attempts','Retry time','Updated','File','SHA-256','Recipe','Last error'],...filtered().flatMap(track=>(['bass','bass-reverb'] as Mode[]).map(mode=>{const n=name(track),v=track.versions[mode];return[n.title,n.artist,track.ref,track.original_path,track.status,labels[mode],v?.status,v?.bytes,v?.duration,v?.attempts,v?.retry_after?date(v.retry_after):'',date(v?.updated_at),v?.path,v?.sha256,v?.recipe,v?.last_error];}))];
    const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=`aura-processing-${new Date().toISOString().slice(0,10)}.csv`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  inspector.addEventListener('close',()=>{inspected=null;});
  inspector.addEventListener('click',event=>{
    const target=(event.target as HTMLElement).closest<HTMLElement>('button');
    if(target?.dataset.audioRetry)void mutate('audioRetry',{refs:[target.dataset.audioRetry]},'Queue unfinished versions for this song?');
    if(target?.dataset.audioRegenerate)void mutate('audioRegenerate',{refs:[target.dataset.ref],mode:target.dataset.audioRegenerate,expected_updated_at:Number(target.dataset.revision)},`Regenerate ${labels[target.dataset.audioRegenerate]}? It will be unavailable until the Mac worker publishes it again. The original and other version are preserved.`);
  });
  return {
    show(){void load();window.clearInterval(timer);timer=window.setInterval(()=>{void load();},15000);},
    hide(){window.clearInterval(timer);timer=undefined;generation++;loading=false;if(inspector.open)inspector.close();},
    reset(){data=null;selected.clear();el('audioJobs').innerHTML='';el('audioSummary').innerHTML='';el('audioActivity').innerHTML='';controls();},
  };
}
