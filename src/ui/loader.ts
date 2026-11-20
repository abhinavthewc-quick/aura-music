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

/* Full-screen intro loader. This is a fallback, not a gate: index.html only
   reveals #auraLoader when the device looks slow at parse time, or when the app
   has not signalled readiness by its budget (560 ms desktop / 680 ms coarse).
   This module starts the animation on reveal and removes the splash the moment
   the app says its first screen is on screen, so a fast boot never shows it.
   The renderer is imported here rather than at module scope: a fast boot must
   not download a shader chunk it will never display. */
(function(){
  var el=document.getElementById('auraLoader'); if(!el) return;
  var root=document.documentElement;

  var started=false, done=false, timer:any, visibleSince=0;
  var appReady=root.dataset.auraReady==='1';
  document.addEventListener('aura:ready', function(){ appReady=true; if(!started) removeSplash(); });

  var reduce=false;
  try{ reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}

  function removeSplash(){
    root.classList.remove('aura-loading');
    if(el && el.parentNode) el.parentNode.removeChild(el);
  }

  var liquidRenderer: { pause(): void; dispose(): void } | null = null;

  function start(){
    if(started) return;
    /* Readiness can land between the gate's timer and this module evaluating
       (or while the browser was parsing the body). Nothing left to cover. */
    if(appReady){ removeSplash(); return; }
    started=true;
    visibleSince=performance.now();

    var coarse=false;
    try{ coarse=window.matchMedia('(pointer: coarse)').matches; }catch(e){}
    var lowPower = coarse || (navigator.hardwareConcurrency||8) <= 4 ||
      ((navigator as any).deviceMemory||8) <= 4;
    var saveData=false;
    try{ saveData=!!(navigator as any).connection?.saveData; }catch(e){}
    var canvas=document.getElementById('auraLiquidCanvas') as HTMLCanvasElement | null;
    // Phones pay for the splash in GPU time, not bytes: the shader shades a
    // fullscreen quad every frame while the app is still booting, so touch
    // devices (and reduced-motion / data-saver users) get the static mark.
    var useShader=!!canvas && !reduce && !saveData && !coarse;
    /* The splash is a full-screen quad; 1.5 keeps the glass crisp without
       paying for 4× the fragments on a boot that is already slow. */
    var maxDpr=lowPower?1.25:1.5;
    /* Leave as soon as the app is ready, but not before the mark has been on
       screen long enough to register as an intro rather than a flicker. */
    var MIN_VISIBLE_MS=coarse?220:260;
    var CAP_MS=4200;
    var FADE_MS=coarse?200:300;

    function cleanup(){
      if(liquidRenderer){ try{ liquidRenderer.dispose(); }catch(e){} liquidRenderer=null; }
      removeSplash();
    }

    function leave(){
      if(done) return;
      done=true;
      clearInterval(timer);
      if(liquidRenderer){ try{ liquidRenderer.pause(); }catch(e){} }
      var tx=document.getElementById('auraLoaderText');
      if(tx) tx.classList.add('leaving');
      el.classList.add('leaving');
      el.setAttribute('aria-hidden','true');
      setTimeout(cleanup, FADE_MS + 40);
    }

    function check(){
      if(done) return;
      var spent=performance.now()-visibleSince;
      if(appReady){
        if(spent>=MIN_VISIBLE_MS) leave();
        return;
      }
      /* A catalogue that never arrives must not trap the app behind a splash:
         the skeleton rails are already the honest state to show. */
      if(spent>=CAP_MS) leave();
    }

    el.addEventListener('click', leave);
    timer=setInterval(check, 120);
    check();

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
  }

  if(root.dataset.auraSplash==='1') start();
  else if(appReady) removeSplash();
  else document.addEventListener('aura:splash', start, {once:true});
})();
