/* AURA orb: a spinning sphere of soft dots. Used for the full-screen intro loader and the small in-app loading states. */
(function(){
  var TAU=Math.PI*2, GA=Math.PI*(3-Math.sqrt(5)), D=3.2, reduce=false;
  try{ reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}
  // The orb is a 2D canvas that strokes one line per particle every frame, so
  // cost scales with particle count times device pixels. Both are cut on touch
  // and low-core devices: the sphere reads identically at these sizes, it just
  // stops burning the main thread while the app is still booting.
  var coarse=false;
  try{ coarse=window.matchMedia('(pointer: coarse)').matches; }catch(e){}
  var lowPower = coarse || (navigator.hardwareConcurrency||8) <= 4 ||
    ((navigator as any).deviceMemory||8) <= 4;
  var DPR_CAP = lowPower ? 1.5 : 2;
  var PARTICLE_SCALE = lowPower ? .55 : 1;

  function create(canvas,o){
    o=o||{};
    var ctx=canvas.getContext('2d'); if(!ctx) return null;
    var n=Math.max(40, Math.round((o.count||520) * PARTICLE_SCALE)), pts=[], i;
    for(i=0;i<n;i++){
      var y=1-(i+.5)/n*2, r=Math.sqrt(1-y*y), th=GA*i;
      pts.push({x:Math.cos(th)*r,y:y,z:Math.sin(th)*r,s:.5+Math.pow(Math.random(),2.3)*2.3,w:Math.random()*TAU,warm:Math.random()<.14});
    }
    var dpr=Math.min(window.devicePixelRatio||1,DPR_CAP), cw=0, ch=0, rot=Math.random()*TAU;
    var tilt=o.tilt==null?.38:o.tilt, speed=(o.speed||.9)*(reduce?.25:1);
    var col=o.color||[255,255,255], warm=o.warm||[240,206,164];
    var zoom=0, alive=true, last=0, t=0, raf=0;

    function fit(){
      var w=canvas.clientWidth||64, h=canvas.clientHeight||64;
      var nw=Math.round(w*dpr), nh=Math.round(h*dpr);
      if(nw!==cw||nh!==ch){ cw=canvas.width=nw; ch=canvas.height=nh; }
    }
    function draw(){
      fit(); ctx.clearRect(0,0,cw,ch);
      var base=Math.min(cw,ch)*(o.radius||.4);
      var fill=Math.sqrt(cw*cw+ch*ch)*.8;
      var e=zoom*zoom;
      var R=base+(fill-base)*e;
      var unit=(o.dot||1)*base*.011*(1+e*2.2);
      var cyf=o.cy==null?.5:o.cy, cx=cw/2, cy=ch*(cyf+(.5-cyf)*e), ct=Math.cos(tilt), st=Math.sin(tilt);
      var trail=.014*(1+zoom*2);
      var c1=Math.cos(rot), s1=Math.sin(rot), c0=Math.cos(rot-trail), s0=Math.sin(rot-trail);
      var fade=1-Math.max(0,(zoom-.55)/.45);
      var minW=.6*dpr;
      ctx.lineCap='round';
      for(var i=0;i<n;i++){
        var p=pts[i];
        var x1=p.x*c1+p.z*s1, z1=-p.x*s1+p.z*c1;
        var y2=p.y*ct-z1*st, z2=p.y*st+z1*ct;
        var k=D/(D-z2);
        var sx=cx+x1*R*k, sy=cy+y2*R*k;
        var xb=p.x*c0+p.z*s0, zb=-p.x*s0+p.z*c0;
        var yb=p.y*ct-zb*st, zb2=p.y*st+zb*ct, kb=D/(D-zb2);
        var sx0=cx+xb*R*kb, sy0=cy+yb*R*kb;
        var depth=(z2+1)/2;
        var a=(.1+.9*Math.pow(depth,1.5))*(.86+.14*Math.sin(t*1.6+p.w))*fade;
        if(a<.02) continue;
        var sz=p.s*unit*(.5+.9*depth)*k;
        var cc=p.warm?warm:col;
        ctx.strokeStyle='rgba('+cc[0]+','+cc[1]+','+cc[2]+','+a.toFixed(3)+')';
        ctx.lineWidth=sz>minW?sz:minW;
        ctx.beginPath(); ctx.moveTo(sx0,sy0); ctx.lineTo(sx+.01,sy); ctx.stroke();
      }
    }
    function step(ts){
      if(!alive) return;
      if(o.stopWhenDetached && !canvas.isConnected){ alive=false; return; }
      var dt=last?Math.min(.05,(ts-last)/1000):.016; last=ts; t+=dt;
      rot+=speed*(1+zoom*2.2)*dt;
      draw();
      raf=requestAnimationFrame(step);
    }
    raf=requestAnimationFrame(step);
    return { setZoom:function(z){ zoom=z; }, stop:function(){ alive=false; cancelAnimationFrame(raf); } };
  }

  function mountAll(){
    var list=document.querySelectorAll('canvas.aura-orb-mini:not([data-orb])');
    var light=document.body && document.body.classList.contains('light-theme');
    for(var i=0;i<list.length;i++){
      list[i].setAttribute('data-orb','1');
      create(list[i],{count:150,radius:.46,dot:2.6,speed:1.4,tilt:.4,stopWhenDetached:true,
        color:light?[120,72,30]:[255,255,255], warm:light?[168,100,42]:[240,206,164]});
    }
  }
  window.AuraOrb={create:create,mountAll:mountAll,reduce:reduce};
})();

/* Full-screen intro loader: plays the ReactDrops Liquid Glass Logo startup animation and smoothly dissolves into Aura Music. */
(async function(){
  var el=document.getElementById('auraLoader'); if(!el) return;
  var root=document.documentElement;
  // The intro is a scripted sequence, not a fixed wait: `speed` scales it. The
  // old 3800ms floor held the app behind a splash for nearly four seconds even
  // when everything was already parsed and painted. The sequence now finishes
  // in ~1.5s at speed 1.2, and the floor only guards against a flash.
  //
  // On touch devices the floor is cut further: the app is interactive at ~300ms
  // there, and a phone user is usually waiting on cellular, so a long branded
  // splash costs more than it buys. The animation still runs, just shorter.
  var coarsePointer=false;
  try{ coarsePointer=window.matchMedia('(pointer: coarse)').matches; }catch(e){}
  var MIN_MS=coarsePointer?350:1100, CAP_MS=coarsePointer?900:2200;
  var reduce=false;
  try{ reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}
  if(reduce) MIN_MS=200;
  // Slow networks must not extend the splash just because a web font is still
  // arriving. Text already paints with `font-display: swap`; after this window
  // the swap happens in place instead of behind a full-screen cover.
  var FONT_WAIT_MS=coarsePointer?700:1400;

  var canvas = document.getElementById('auraLiquidCanvas') as HTMLCanvasElement | null;
  var liquidRenderer: { pause(): void; dispose(): void } | null = null;

  // Phones pay for the splash in GPU time, not bytes. The renderer draws a
  // fullscreen fragment shader every frame, so cost scales with device pixels:
  // at DPR 3 a 393px-wide phone shades ~1.13 megapixels per frame, which is
  // enough to drop frames on mid-range hardware during a 1.5s intro. Cap the
  // DPR and thin the shader on touch devices; the animation still reads the
  // same at arm's length, it just stops competing with the app's own boot work.
  var coarse = false;
  try{ coarse = window.matchMedia('(pointer: coarse)').matches; }catch(e){}
  var lowPower = coarse || (navigator.hardwareConcurrency || 8) <= 4 ||
    ((navigator as any).deviceMemory || 8) <= 4;
  var saveData = false;
  try{ saveData = !!(navigator as any).connection?.saveData; }catch(e){}
  // The WebGL intro is the single most expensive thing on the boot path: it
  // downloads a shader chunk, compiles two programs, rasterises the logo at
  // device resolution and shades a full-screen quad every frame — while the app
  // is still parsing. On phones that work lands in the same main thread as the
  // first render and produced >1.4s of long tasks in profiling. Touch devices
  // (and reduced-motion / data-saver users) get the static mark instead, which
  // keeps the branded hand-off at a fraction of the cost.
  var useShader = !!canvas && !reduce && !saveData && !coarse;
  var maxDpr = lowPower ? 1.25 : 2;

  function cleanup(){
    if(liquidRenderer){
      try { liquidRenderer.dispose(); } catch(e){}
      liquidRenderer = null;
    }
    if(el && el.parentNode) el.parentNode.removeChild(el);
    root.classList.remove('aura-loading');
  }

  try{
    var t0=performance.now(), done=false;
    // The splash used to gate on `window.load`, which does not fire until every
    // image in the document has finished downloading. On a phone that meant the
    // app sat behind a splash for ~3s while the browser fetched cover art for
    // rails the user had not scrolled to yet — despite the app itself being
    // interactive at ~290ms. Gate on DOM readiness plus fonts instead: that is
    // what "the app can paint correctly" actually requires. Images stream in
    // behind the splash and behind lazy rails, which is fine.
    var loaded=document.readyState!=='loading';
    var fontsOk=!document.fonts;
    var timer: any;

    // Registered before the dynamic import below: the import awaits a network
    // fetch, and a readiness event that fires during that await would otherwise
    // be missed entirely, leaving the splash up until the failsafe cap.
    if(!loaded){
      document.addEventListener('DOMContentLoaded', function(){ loaded=true; check(); }, {once:true});
    }
    el.addEventListener('click', leave);
    if(document.fonts && document.fonts.ready){
      document.fonts.ready.then(function(){ fontsOk=true; check(); }, function(){ fontsOk=true; check(); });
    }

    // The renderer (78 KB of shader source) is loaded on demand rather than
    // imported statically: a static import put it on the critical path ahead of
    // the app itself, so nothing booted until the splash animation's code had
    // parsed. Fetched in parallel now, with the static logo shown until it is
    // ready — #auraLoader:not([data-ready]) already reveals that fallback.
    //
    // Deliberately NOT awaited here: awaiting it would hold the readiness check
    // loop below until the chunk had downloaded and parsed, which is exactly the
    // dependency this change exists to remove. The splash leaves on its own
    // schedule; the animation joins if it arrives in time.
    if(useShader && canvas){
      import('../components/liquid-glass-logo-renderer').then(function(mod){
        if(done) return;
        try {
          var isLight = document.body && document.body.classList.contains('light-theme');
          var tuning = mod.normalizeLiquidGlassLogo({
            ...mod.liquidGlassLogoDefaults,
            logo: '/aura-vinyl-logo.png',
            ending: 'logo',
            depth: 2.4,
            dispersion: 1.45,
            relief: 1.2,
            caustics: 1.35,
            highlights: 1.5,
            bloom: 0.7,
            dropStrength: 2.1,
            decay: 3,
            innerWallFocus: 0.15,
            speed: 1.2,
            loopDelay: 0.6,
            maxDpr: maxDpr,
            background: isLight ? '#e2e2e5' : '#000000',
          });
          liquidRenderer = mod.createLiquidGlassLogoRenderer(canvas, tuning, function(){
            if(el) el.setAttribute('data-ready', '1');
          }) as any;
        } catch(err) {
          if(el) el.setAttribute('data-ready', '1');
        }
      }).catch(function(){
        if(el) el.setAttribute('data-ready', '1');
      });
    }

    function check(){
      if(done) return;
      var spent=performance.now()-t0;
      if(!fontsOk && spent>=FONT_WAIT_MS) fontsOk=true;
      // The blocking main stylesheet bundles UI fonts and icons.
      var appReady=loaded && fontsOk;
      if((spent>=MIN_MS && appReady) || spent>=CAP_MS){
        leave();
      }
    }

    function leave(){
      if(done) return;
      done=true;
      clearInterval(timer);
      // Stop shading immediately: the splash is fading out, and continuing to
      // run a full-screen fragment shader while the app hydrates is exactly the
      // contention that made the hand-off stutter.
      if(liquidRenderer){
        try{ liquidRenderer.pause(); }catch(e){}
      }
      var tx=document.getElementById('auraLoaderText');
      if(tx) tx.classList.add('leaving');
      el.classList.add('leaving');
      el.setAttribute('aria-hidden','true');
      var fadeDur=reduce?200:450;
      setTimeout(cleanup, fadeDur + 50);
    }

    timer=setInterval(check, 80);
    check();
  }catch(err){
    cleanup();
  }
})();
