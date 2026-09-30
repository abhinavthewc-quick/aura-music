import { toast } from '../core/dom';
import { navClick } from '../ui/nav';
import { radioAudio } from './radio';
import { $, state } from '../core/state';
/* ===== 4288-4645 ===== */
    // AURA Ambient Effects — procedural Web Audio, so no extra state.audio files are required.
    export const AURA_EFFECT_KEY='auraAmbientEffect_v1';
    export const ambientEffectConfig=[
      {key:'rain',icon:'fa-cloud-rain',name:'Gentle Rain',desc:'Steady, soft rainfall.'},
      {key:'thunder',icon:'fa-cloud-bolt',name:'Thunderstorm',desc:'Distant thunder with rain.'},
      {key:'ocean',icon:'fa-water',name:'Ocean Waves',desc:'Rhythmic waves on a shore.'},
      {key:'forest',icon:'fa-tree',name:'Forest Wildlife',desc:'Leaves, wind and distant birds.'},
      {key:'birds',icon:'fa-dove',name:'Birdsong',desc:'Morning chirps, trills and a soft breeze.'},
      {key:'fire',icon:'fa-fire',name:'Crackling Campfire',desc:'Warm pops and wood crackle.'},
      {key:'coffee',icon:'fa-mug-hot',name:'Coffee Shop',desc:'Low chatter and cup ambience.'},
      {key:'tea',icon:'fa-mug-saucer',name:'Tea Sipping & Pouring',desc:'Pouring water and a gentle sip.'},
      {key:'vinyl',icon:'fa-record-vinyl',name:'Vinyl Crackle',desc:'Warm vintage pops and static.'},
      {key:'library',icon:'fa-book-open',name:'Library Silence',desc:'Pages and distant footsteps.'},
      {key:'crickets',icon:'fa-moon',name:'Soft Night Crickets',desc:'Evening crickets and a faint breeze.'},
      {key:'train',icon:'fa-train',name:'Train Ride Rhythm',desc:'Click-clack tracks and engine hum.'},
      {key:'plane',icon:'fa-plane',name:'Airplane Cabin Hum',desc:'Steady low-frequency cabin noise.'},
      {key:'car',icon:'fa-car',name:'Rain on Car Roof',desc:'Pitter-patter heard from inside.'}
    ];
    export const ambientEffects=Object.fromEntries(ambientEffectConfig.map(e=>[e.key,e.name]));

    /* ---------- Ambient effects: layered mixer ----------
       Multiple ambience layers can play at once, each with its own
       independent gain node (and its own volume slider), all summed into
       a shared effectMaster -> effectPanner -> destination chain. */
    export let effectCtx=null,effectMaster=null,effectPanner=null,effectNoiseBuffer=null;
    /* Loudness balance: each effect has a different natural level, so trim them to sit evenly */
    export const EFFECT_TRIM={rain:.6,thunder:1.2,ocean:1.2,forest:3.5,birds:6,fire:3.4,coffee:6,tea:9,vinyl:5,library:14,crickets:9,train:8,plane:5,car:7};
    export const effectTrim=k=>EFFECT_TRIM[k]||1;
    export const activeLayers={}; // key -> { gain: GainNode, nodes:[], timers:[] }

    export function ensureEffectAudio(){
      if(!effectCtx){
        effectCtx=new (window.AudioContext||window.webkitAudioContext)();
        effectMaster=effectCtx.createGain(); effectMaster.gain.value=Number($('effectVolume').value)/100;
        effectPanner=effectCtx.createStereoPanner();
        const comp=effectCtx.createDynamicsCompressor(); comp.threshold.value=-16; comp.ratio.value=6; comp.attack.value=.01; comp.release.value=.25;
        effectMaster.connect(comp).connect(effectPanner).connect(effectCtx.destination);
      }
      if(effectCtx.state==='suspended') effectCtx.resume();
    }
    export function makeNoiseBuffer(){
      const len=effectCtx.sampleRate*2, b=effectCtx.createBuffer(1,len,effectCtx.sampleRate), d=b.getChannelData(0);
      for(let i=0;i<len;i++) d[i]=(Math.random()*2-1); return b;
    }
    export function noise(gain,filterType,freq,q,dest,bucket){
      const src=effectCtx.createBufferSource(); src.buffer=effectNoiseBuffer||(effectNoiseBuffer=makeNoiseBuffer()); src.loop=true;
      const f=effectCtx.createBiquadFilter(); f.type=filterType; f.frequency.value=freq; f.Q.value=q||0.7;
      const g=effectCtx.createGain(); g.gain.value=gain; src.connect(f).connect(g).connect(dest); src.start(); bucket.push(src,g,f); return {src,g,f};
    }
    export function tone(freq,gain,type,dest,bucket){
      const o=effectCtx.createOscillator(),g=effectCtx.createGain(); o.type=type||'sine';o.frequency.value=freq;g.gain.value=gain;o.connect(g).connect(dest);o.start();bucket.push(o,g);return {o,g};
    }
    export function pulseTone(freq,gain,interval,duration,type,dest,bucket,layerKey){
      const tick=()=>{
        if(!activeLayers[layerKey])return;
        const t=effectCtx.currentTime; const o=effectCtx.createOscillator(),g=effectCtx.createGain();
        o.type=type||'sine';o.frequency.value=freq;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(gain,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
        o.connect(g).connect(dest);o.start(t);o.stop(t+duration+.03);
      };
      tick(); bucket.timers.push(setInterval(tick,interval));
    }

    /* ---- richer synthesis helpers: every effect is built from different ingredients ---- */
    export function noiseBurst(dest,o){
      o=o||{}; const dur=o.dur||.05, gain=o.gain||.3, attack=o.attack||.003, delay=o.delay||0;
      const t=effectCtx.currentTime+delay;
      const src=effectCtx.createBufferSource(); src.buffer=effectNoiseBuffer||(effectNoiseBuffer=makeNoiseBuffer()); src.loop=true;
      const f=effectCtx.createBiquadFilter(); f.type=o.type||'bandpass'; f.Q.value=o.q||1;
      f.frequency.setValueAtTime(o.freq||1500,t); if(o.sweepTo) f.frequency.linearRampToValueAtTime(o.sweepTo,t+dur);
      const g=effectCtx.createGain(); g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(gain,t+attack); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
      src.connect(f).connect(g).connect(dest); src.start(t,Math.random()); src.stop(t+dur+.05);
    }
    export function pingTone(dest,o){
      o=o||{}; const dur=o.dur||.25, gain=o.gain||.05, freq=o.freq||2500, t=effectCtx.currentTime+(o.delay||0);
      const osc=effectCtx.createOscillator(), g=effectCtx.createGain();
      osc.type=o.type||'sine'; osc.frequency.setValueAtTime(freq,t); if(o.glide) osc.frequency.exponentialRampToValueAtTime(freq*o.glide,t+dur);
      g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(gain,t+(o.attack||.004)); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
      osc.connect(g).connect(dest); osc.start(t); osc.stop(t+dur+.05);
    }
    export function lfoOn(param,freq,depth,bucket,type?){
      const l=effectCtx.createOscillator(), lg=effectCtx.createGain(); l.type=type||'sine'; l.frequency.value=freq; lg.gain.value=depth;
      l.connect(lg).connect(param); l.start(); bucket.push(l,lg); return l;
    }
    export function scheduleRandom(layer,key,fn,min,max){
      let id; const loop=()=>{ if(!activeLayers[key]) return; try{fn();}catch(e){} id=setTimeout(loop,min+Math.random()*(max-min)); };
      id=setTimeout(loop,Math.random()*min); layer.timers.push(()=>clearTimeout(id));
    }
    export const rnd=(a,b)=>a+Math.random()*(b-a);
    export function buildEffectGraph(name,dest,bucket,timerBucket){
      const b=bucket, key=name;
      if(name==='rain'){noise(.62,'highpass',1300,.7,dest,b);noise(.16,'lowpass',4500,.7,dest,b);pulseTone(3200,.035,900,.07,'square',dest,timerBucket,key)}
      if(name==='thunder'){
        noise(.3,'highpass',1500,.7,dest,b); noise(.08,'lowpass',5000,.7,dest,b);
        const boom=()=>{ noiseBurst(dest,{type:'bandpass',freq:1100,q:.8,dur:.35,gain:.55});
          noiseBurst(dest,{type:'lowpass',freq:170,q:.7,dur:4.6,attack:.5,gain:1.1,delay:.15});
          noiseBurst(dest,{type:'lowpass',freq:110,q:.7,dur:3.4,attack:.8,gain:.8,delay:1.4}); };
        setTimeout(()=>{ if(activeLayers[key]) boom(); },1200);
        scheduleRandom(timerBucket,key,boom,9000,17000);
      }
      if(name==='ocean'){
        const n1=noise(.5,'lowpass',650,.4,dest,b); lfoOn(n1.g.gain,.09,.38,b); lfoOn(n1.f.frequency,.09,380,b);
        const n2=noise(.12,'highpass',2200,.5,dest,b); lfoOn(n2.g.gain,.09,.1,b);
        const n3=noise(.25,'lowpass',420,.5,dest,b); lfoOn(n3.g.gain,.061,.2,b);
      }
      if(name==='birds'){
        noise(.035,'lowpass',800,.7,dest,b);
        const chirp=()=>{ if(!activeLayers[key]) return; const t=effectCtx.currentTime, notes=2+Math.floor(Math.random()*4), base=2300+Math.random()*2200;
          for(let i=0;i<notes;i++){ const st=t+i*(.09+Math.random()*.05), o=effectCtx.createOscillator(), g=effectCtx.createGain(), f0=base*(.9+Math.random()*.3), f1=f0*(1.15+Math.random()*.5);
            o.type='sine'; o.frequency.setValueAtTime(f0,st); o.frequency.exponentialRampToValueAtTime(f1,st+.07);
            g.gain.setValueAtTime(.0001,st); g.gain.linearRampToValueAtTime(.05+Math.random()*.03,st+.015); g.gain.exponentialRampToValueAtTime(.0001,st+.1);
            o.connect(g).connect(dest); o.start(st); o.stop(st+.12); } };
        const trill=()=>{ if(!activeLayers[key]) return; const t=effectCtx.currentTime, o=effectCtx.createOscillator(), lfo=effectCtx.createOscillator(), lg=effectCtx.createGain(), g=effectCtx.createGain(), f=3000+Math.random()*1500;
          o.type='sine'; o.frequency.setValueAtTime(f,t); o.frequency.linearRampToValueAtTime(f*1.25,t+.6);
          lfo.frequency.value=22+Math.random()*10; lg.gain.value=260; lfo.connect(lg).connect(o.frequency);
          g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(.035,t+.08); g.gain.linearRampToValueAtTime(.03,t+.45); g.gain.exponentialRampToValueAtTime(.0001,t+.7);
          o.connect(g).connect(dest); o.start(t); lfo.start(t); o.stop(t+.75); lfo.stop(t+.75); };
        chirp(); timerBucket.timers.push(setInterval(chirp,1700),setInterval(chirp,2900),setInterval(trill,5200),setInterval(chirp,4300));
      }
      if(name==='forest'){
        const w=noise(.16,'bandpass',480,.5,dest,b); lfoOn(w.g.gain,.13,.09,b); lfoOn(w.f.frequency,.07,180,b);
        const r=noise(.02,'highpass',3600,.7,dest,b); lfoOn(r.g.gain,.3,.015,b);
        scheduleRandom(timerBucket,key,()=>{ const f=rnd(360,450);
          pingTone(dest,{freq:f,dur:.55,gain:.07,glide:.88,attack:.08}); pingTone(dest,{freq:f*.97,dur:.6,gain:.06,glide:.85,attack:.08,delay:.75}); },7000,14000);
        scheduleRandom(timerBucket,key,()=>{ pingTone(dest,{freq:690,dur:.28,gain:.035,glide:.82}); pingTone(dest,{freq:545,dur:.4,gain:.035,glide:.9,delay:.32}); },15000,30000);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:rnd(1500,3200),q:.8,dur:.6,attack:.2,gain:.05}),2500,7000);
      }
      if(name==='fire'){
        noise(.3,'lowpass',170,.7,dest,b); noise(.018,'highpass',4500,.7,dest,b);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:rnd(1500,5200),q:2.2,dur:rnd(.012,.05),gain:rnd(.2,.6)}),60,260);
        scheduleRandom(timerBucket,key,()=>{ noiseBurst(dest,{type:'lowpass',freq:900,q:.8,dur:.1,gain:.85}); pingTone(dest,{freq:190,dur:.09,gain:.07,glide:.6}); },1600,4200);
      }
      if(name==='coffee'){
        [[350,.23],[720,.37],[1150,.51]].forEach(([f,r])=>{ const n=noise(.075,'bandpass',f,1.3,dest,b); lfoOn(n.g.gain,r,.05,b); lfoOn(n.f.frequency,r*.6,f*.25,b); });
        scheduleRandom(timerBucket,key,()=>{ const f=rnd(3200,4700); pingTone(dest,{freq:f,dur:.2,gain:.04}); pingTone(dest,{freq:f*1.5,dur:.16,gain:.02,delay:.03}); },1800,5200);
        scheduleRandom(timerBucket,key,()=>{ for(let i=0;i<5;i++) pingTone(dest,{freq:rnd(2600,3400),dur:.07,gain:.02,delay:i*.11}); },9000,18000);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'highpass',freq:3200,dur:2.2,attack:.25,gain:.07}),14000,26000);
      }
      if(name==='tea'){
        noise(.02,'lowpass',420,.7,dest,b);
        const pour=()=>{
          noiseBurst(dest,{type:'bandpass',freq:900,sweepTo:2700,q:1.4,dur:3.4,attack:.5,gain:.2});
          for(let i=0;i<9;i++) pingTone(dest,{freq:rnd(500,1100),dur:.09,gain:.018,glide:1.6,delay:.4+i*.32});
          pingTone(dest,{freq:4100,dur:.3,gain:.03,delay:3.6});
          noiseBurst(dest,{type:'lowpass',freq:700,dur:.4,attack:.05,gain:.2,delay:5.2}); pingTone(dest,{freq:190,dur:.14,gain:.05,glide:.6,delay:5.35});
        };
        setTimeout(()=>{ if(activeLayers[key]) pour(); },500);
        scheduleRandom(timerBucket,key,pour,9500,15000);
      }
      if(name==='vinyl'){
        noise(.028,'highpass',4000,.7,dest,b); noise(.05,'bandpass',2600,1.4,dest,b);
        pulseTone(46,.035,1800,.5,'sine',dest,timerBucket,key);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:rnd(2500,6500),q:1.5,dur:rnd(.006,.02),gain:rnd(.25,.7)}),110,850);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'highpass',freq:1600,dur:.05,gain:.85}),3000,7500);
      }
      if(name==='library'){
        noise(.028,'lowpass',260,.7,dest,b);
        let flip=false; scheduleRandom(timerBucket,key,()=>{ flip=!flip; noiseBurst(dest,{type:'bandpass',freq:flip?3200:2600,q:2,dur:.02,gain:.1}); },995,1005);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:2200,q:.6,dur:.55,attack:.14,gain:.13}),6000,14000);
        scheduleRandom(timerBucket,key,()=>{ const n=4+Math.floor(Math.random()*3); for(let i=0;i<n;i++) noiseBurst(dest,{type:'lowpass',freq:320,dur:.09,gain:.28,delay:i*.55}); },12000,24000);
      }
      if(name==='crickets'){
        [[4300,13],[4750,15.5],[5150,12]].forEach(([f,r],i)=>{
          const o=effectCtx.createOscillator(), am=effectCtx.createGain(), env=effectCtx.createGain(); o.type='sine'; o.frequency.value=f;
          am.gain.value=.012; env.gain.value=.5; o.connect(am).connect(env).connect(dest); o.start(); b.push(o,am,env);
          lfoOn(am.gain,r,.012,b,'square'); lfoOn(env.gain,.28+i*.11,.5,b);
        });
        const br=noise(.03,'lowpass',520,.7,dest,b); lfoOn(br.g.gain,.1,.02,b);
      }
      if(name==='train'){
        noise(.22,'lowpass',240,.7,dest,b);
        const clack=()=>{ noiseBurst(dest,{type:'bandpass',freq:1250,q:1.6,dur:.06,gain:.38}); pingTone(dest,{freq:72,dur:.14,gain:.14,glide:.7});
          noiseBurst(dest,{type:'bandpass',freq:1000,q:1.6,dur:.05,gain:.26,delay:.13}); pingTone(dest,{freq:66,dur:.12,gain:.1,glide:.7,delay:.13}); };
        clack(); timerBucket.timers.push(setInterval(clack,880));
        scheduleRandom(timerBucket,key,()=>{ pingTone(dest,{freq:311,type:'triangle',dur:1.5,gain:.03,attack:.08}); pingTone(dest,{freq:370,type:'triangle',dur:1.5,gain:.025,attack:.08}); },30000,60000);
      }
      if(name==='plane'){
        const r=noise(.4,'lowpass',260,.5,dest,b); lfoOn(r.g.gain,.05,.05,b);
        noise(.012,'highpass',2500,.7,dest,b);
        const t1=tone(105,.02,'sine',dest,b), t2=tone(158,.012,'sine',dest,b); lfoOn(t1.o.frequency,.08,2.5,b); lfoOn(t2.o.frequency,.06,3,b);
        scheduleRandom(timerBucket,key,()=>{ pingTone(dest,{freq:880,dur:1,gain:.04,attack:.01}); pingTone(dest,{freq:660,dur:1.1,gain:.035,delay:.5,attack:.01}); },40000,70000);
      }
      if(name==='car'){
        noise(.24,'lowpass',210,.7,dest,b); tone(62,.014,'sine',dest,b);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:rnd(1200,3000),q:2,dur:rnd(.02,.05),gain:rnd(.15,.4)}),40,170);
        scheduleRandom(timerBucket,key,()=>noiseBurst(dest,{type:'bandpass',freq:600,q:.8,dur:.6,attack:.22,gain:.1}),3400,3700);
      }
    }
    export function updateEffectStatus(){
      const names=Object.keys(activeLayers).map(k=>ambientEffects[k]);
      $('effectNowPlaying').textContent = names.length ? names.join(' + ') : 'Off';
      try{
        if(names.length) localStorage.setItem(AURA_EFFECT_KEY, JSON.stringify(Object.keys(activeLayers)));
        else localStorage.removeItem(AURA_EFFECT_KEY);
      }catch(e){}
    }
    export function stopAmbientLayer(name){
      const layer=activeLayers[name];
      if(!layer) return;
      layer.timers.forEach(t=>{ if(typeof t==='function') t(); else clearInterval(t); });
      layer.nodes.forEach(n=>{try{if(n.stop)n.stop()}catch(e){}});
      layer.nodes.forEach(n=>{try{n.disconnect()}catch(e){}});
      try{layer.gain.disconnect()}catch(e){}
      delete activeLayers[name];
      const row=document.querySelector(`.effect-row[data-effect="${name}"]`);
      if(row) row.classList.remove('active');
      updateEffectStatus();
    }
    export function startAmbientLayer(name,initialVolume){
      ensureEffectAudio();
      if(activeLayers[name]) return;
      const gainNode=effectCtx.createGain();
      gainNode.gain.value=((initialVolume!=null?initialVolume:50)/100)*effectTrim(name);
      gainNode.connect(effectMaster);
      const layer={gain:gainNode,nodes:[],timers:[]};
      activeLayers[name]=layer;
      buildEffectGraph(name,gainNode,layer.nodes,layer);
      const row=document.querySelector(`.effect-row[data-effect="${name}"]`);
      if(row) row.classList.add('active');
      updateEffectStatus();
    }
    export function toggleAmbientLayer(name){
      if(activeLayers[name]) stopAmbientLayer(name);
      else{
        const row=document.querySelector(`.effect-row[data-effect="${name}"]`);
        const slider=row ? row.querySelector('.effect-row-slider') : null;
        startAmbientLayer(name, slider ? Number(slider.value) : 50);
      }
    }
    export function stopAllAmbient(){
      Object.keys(activeLayers).forEach(stopAmbientLayer);
    }
    export function renderEffectsGrid(){
      $('effectsGrid').innerHTML = ambientEffectConfig.map(e => `
        <div class="effect-row" data-effect="${e.key}">
          <div class="effect-row-top" onclick="toggleAmbientLayer('${e.key}')">
            <i class="fa-solid ${e.icon}"></i>
            <b>${e.name}</b>
            <span class="effect-row-pct">50%</span>
          </div>
          <input class="effect-row-slider" type="range" min="0" max="100" value="50" data-effect-slider="${e.key}">
        </div>
      `).join('');
      $('effectsGrid').querySelectorAll('.effect-row-slider').forEach(slider => {
        slider.oninput = (e) => {
          e.stopPropagation();
          const key = slider.dataset.effectSlider;
          const layer = activeLayers[key];
          if(layer) layer.gain.gain.setTargetAtTime((Number(slider.value)/100)*effectTrim(key), effectCtx.currentTime, .03);
          const pct=slider.parentElement.querySelector('.effect-row-pct'); if(pct) pct.textContent=slider.value+'%';
        };
        slider.onclick = e => e.stopPropagation();
      });
    }

    /* Spatial (Vibe) toggle — a slow auto-pan LFO on the ambience mix for
       an immersive, moving feel vs a flat centered Stereo mix. */
    export let auraSpatialLFO=null;
    export function setSpatialMode(on){
      ensureEffectAudio();
      $('spatialModeLabel').textContent = on ? 'Spatial' : 'Stereo';
      if(on){
        if(!auraSpatialLFO){
          auraSpatialLFO=effectCtx.createOscillator(); auraSpatialLFO.frequency.value=.12;
          const lfoGain=effectCtx.createGain(); lfoGain.gain.value=.65;
          auraSpatialLFO.connect(lfoGain).connect(effectPanner.pan);
          auraSpatialLFO.start();
        }
      }else if(auraSpatialLFO){
        try{auraSpatialLFO.stop();auraSpatialLFO.disconnect();}catch(e){}
        auraSpatialLFO=null;
        effectPanner.pan.setTargetAtTime(0,effectCtx.currentTime,.15);
      }
    }

    /* Muffle toggle — applies a real low-pass filter to the actual radio
       and music playback (not just the ambience layer). Routes those
       elements through Web Audio only once this is first switched on, so
       normal playback stays simple and robust until someone opts in. */
    export let auraMasterCtx=null, auraMuffleRadioFilter=null, auraMuffleAudioFilter=null;
    export function ensureMuffleChain(){
      if(auraMasterCtx) return;
      auraMasterCtx=new (window.AudioContext||window.webkitAudioContext)();
      auraMuffleRadioFilter=auraMasterCtx.createBiquadFilter(); auraMuffleRadioFilter.type='lowpass'; auraMuffleRadioFilter.frequency.value=20000;
      auraMuffleAudioFilter=auraMasterCtx.createBiquadFilter(); auraMuffleAudioFilter.type='lowpass'; auraMuffleAudioFilter.frequency.value=20000;
      try{ auraMasterCtx.createMediaElementSource(radioAudio).connect(auraMuffleRadioFilter).connect(auraMasterCtx.destination); }catch(e){}
      try{ auraMasterCtx.createMediaElementSource(state.audio).connect(auraMuffleAudioFilter).connect(auraMasterCtx.destination); }catch(e){}
    }
    export function setMuffleMode(on){
      ensureMuffleChain();
      if(auraMasterCtx.state==='suspended') auraMasterCtx.resume();
      const freq=on?700:20000;
      if(auraMuffleRadioFilter) auraMuffleRadioFilter.frequency.setTargetAtTime(freq,auraMasterCtx.currentTime,.05);
      if(auraMuffleAudioFilter) auraMuffleAudioFilter.frequency.setTargetAtTime(freq,auraMasterCtx.currentTime,.05);
      $('muffleModeLabel').textContent = on ? 'Muffled' : 'Clear';
    }

    /* ---------- Pomodoro focus timer ---------- */
    export let pomodoroSecondsLeft=25*60, pomodoroPhaseName='focus', pomodoroInterval=null, pomodoroRunning=false;
    export function formatPomodoroTime(s){
      const m=Math.floor(s/60), sec=s%60;
      return `${m}:${sec<10?'0':''}${sec}`;
    }
    export function updatePomodoroDisplay(){
      $('pomodoroDisplay').textContent=formatPomodoroTime(pomodoroSecondsLeft);
      $('pomodoroPhase').textContent = pomodoroRunning
        ? (pomodoroPhaseName==='focus' ? 'Focusing…' : 'On a break…')
        : 'Ready to focus';
    }
    export function pomodoroTick(){
      pomodoroSecondsLeft--;
      if(pomodoroSecondsLeft<=0){
        const nextPhase = pomodoroPhaseName==='focus' ? 'break' : 'focus';
        const mins = Number(nextPhase==='focus' ? $('pomodoroWorkMin').value : $('pomodoroBreakMin').value) || (nextPhase==='focus'?25:5);
        pomodoroPhaseName=nextPhase;
        pomodoroSecondsLeft=mins*60;
        toast(nextPhase==='break' ? "Focus session done — take a break! 🎉" : "Break's over — back to focus 💪", 'circle-check');
      }
      updatePomodoroDisplay();
    }
    export function togglePomodoro(){
      if(pomodoroRunning){
        clearInterval(pomodoroInterval); pomodoroInterval=null; pomodoroRunning=false;
        $('pomodoroStartBtn').innerHTML='<i class="fa-solid fa-play"></i> Start';
      }else{
        pomodoroRunning=true;
        $('pomodoroStartBtn').innerHTML='<i class="fa-solid fa-pause"></i> Pause';
        pomodoroInterval=setInterval(pomodoroTick,1000);
      }
      updatePomodoroDisplay();
    }
    export function resetPomodoro(){
      clearInterval(pomodoroInterval); pomodoroInterval=null; pomodoroRunning=false;
      pomodoroPhaseName='focus';
      pomodoroSecondsLeft=(Number($('pomodoroWorkMin').value)||25)*60;
      $('pomodoroStartBtn').innerHTML='<i class="fa-solid fa-play"></i> Start';
      updatePomodoroDisplay();
    }

    export function openEffects(){ const _c=document.querySelector('.effects-card'); if(_c && $('radioEffectsPane').contains(_c)){ $('effectsModal').appendChild(_c); setRadioSegment('stations'); } $('sideMenu').style.display='none'; $('effectsModal').classList.add('active'); $('effectsModal').setAttribute('aria-hidden','false'); }

    // Radio tab "Stations / Effects" segmented control — Effects just opens
    // the same Ambient Effects panel used elsewhere, so there's one shared
    // implementation instead of a duplicate inline copy.
    export function setRadioSegment(which){
      const stationsBtn = $('radioSegStations'), effectsBtn = $('radioSegEffects');
      if(!stationsBtn || !effectsBtn) return;
      const card=document.querySelector('.effects-card'), pane=$('radioEffectsPane');
      const eff = which === 'effects';
      if(eff && card && !pane.contains(card)) pane.appendChild(card);
      $('radioStationsPane').style.display = eff ? 'none' : '';
      pane.style.display = eff ? 'block' : 'none';
      stationsBtn.classList.toggle('active',!eff);
      effectsBtn.classList.toggle('active',eff);
    }
    export function openRadioEffectsTab(){
      navClick($('navRadioBtn'),'tabRadio');
      setRadioSegment('effects');
    }
/* ===== 4726-4747 ===== */
    export function closeEffects(){ $('effectsModal').classList.remove('active'); $('effectsModal').setAttribute('aria-hidden','true'); }
    $('openEffectsBtn').onclick=openEffects; $('effectsCloseBtn').onclick=closeEffects; $('effectsModal').onclick=e=>{if(e.target===$('effectsModal'))closeEffects()};

    export function openAbout(){ $('sideMenu').style.display='none'; $('aboutModal').classList.add('active'); $('aboutModal').setAttribute('aria-hidden','false'); }
    export function closeAbout(){ $('aboutModal').classList.remove('active'); $('aboutModal').setAttribute('aria-hidden','true'); }
    $('openAboutBtn').onclick=openAbout; $('aboutCloseBtn').onclick=closeAbout; $('aboutModal').onclick=e=>{if(e.target===$('aboutModal'))closeAbout()};

    renderEffectsGrid();
    $('stopEffectBtn').onclick=stopAllAmbient;
    $('effectVolume').oninput=e=>{ $('effectVolumePct').textContent=e.target.value+'%'; if(effectMaster)effectMaster.gain.setTargetAtTime(Number(e.target.value)/100,effectCtx.currentTime,.03)};
    $('spatialToggle').onchange=e=>setSpatialMode(e.target.checked);
    $('muffleToggle').onchange=e=>setMuffleMode(e.target.checked);
    $('pomodoroStartBtn').onclick=togglePomodoro;
    $('pomodoroResetBtn').onclick=resetPomodoro;
    $('pomodoroWorkMin').onchange=()=>{ if(!pomodoroRunning) resetPomodoro(); };
    updatePomodoroDisplay();
    try{
      const savedEffects=JSON.parse(localStorage.getItem(AURA_EFFECT_KEY)||'[]');
      if(Array.isArray(savedEffects)) savedEffects.forEach(name=>{ if(ambientEffects[name]) startAmbientLayer(name,50); });
    }catch(e){}


