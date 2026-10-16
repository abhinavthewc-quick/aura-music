/* AURA orb: a spinning sphere of soft dots. Used for the full-screen intro loader and the small in-app loading states. */
(function(){
  var TAU=Math.PI*2, GA=Math.PI*(3-Math.sqrt(5)), D=3.2, reduce=false;
  try{ reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}

  function create(canvas,o){
    o=o||{};
    var ctx=canvas.getContext('2d'); if(!ctx) return null;
    var n=o.count||520, pts=[], i;
    for(i=0;i<n;i++){
      var y=1-(i+.5)/n*2, r=Math.sqrt(1-y*y), th=GA*i;
      pts.push({x:Math.cos(th)*r,y:y,z:Math.sin(th)*r,s:.5+Math.pow(Math.random(),2.3)*2.3,w:Math.random()*TAU,warm:Math.random()<.14});
    }
    var dpr=Math.min(window.devicePixelRatio||1,2), cw=0, ch=0, rot=Math.random()*TAU;
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

/* Full-screen intro loader: shows on every visit (new or returning), then the orb rushes toward the viewer and fills the screen as the app appears. */
(function(){
  var el=document.getElementById('auraLoader'); if(!el) return;
  var root=document.documentElement;
  var MIN_MS=600, CAP_MS=6000;                 /* shortest time the orb is shown / longest we ever wait */
  function cleanup(){ if(el.parentNode) el.parentNode.removeChild(el); root.classList.remove('aura-loading'); }
  try{
    var small=Math.min(window.screen.width||1000,window.screen.height||1000)<700;
    var orb=window.AuraOrb.create(el.querySelector('canvas'),{count:small?420:720,radius:.36,cy:.46,dot:1,speed:.9});
    if(!orb){ cleanup(); return; }
    var t0=performance.now(), done=false, loaded=document.readyState==='complete', fontsOk=!document.fonts, timer;
    window.addEventListener('load',function(){ loaded=true; check(); });
    if(document.fonts && document.fonts.ready){ document.fonts.ready.then(function(){ fontsOk=true; },function(){ fontsOk=true; }); }
    function check(){
      if(done) return;
      var spent=performance.now()-t0;
      var sheets=window.__aura && window.__aura.sheets>=2;
      if((spent>=MIN_MS && loaded && fontsOk && sheets) || spent>=CAP_MS) leave();
    }
    function leave(){
      done=true; clearInterval(timer);
      var tx=document.getElementById('auraLoaderText'); if(tx) tx.classList.add('leaving');
      el.style.pointerEvents='none';
      el.setAttribute('aria-hidden','true');
      var dur=window.AuraOrb.reduce?350:550, s=performance.now();
      setTimeout(function(){ el.style.transition='opacity .35s ease'; el.style.opacity='0'; }, window.AuraOrb.reduce?0:150);
      (function tick(now){
        var p=Math.min(1,(now-s)/dur);
        orb.setZoom(window.AuraOrb.reduce?0:p);
        if(p<1) requestAnimationFrame(tick);
        else { orb.stop(); cleanup(); }
      })(s);
    }
    timer=setInterval(check,100);
  }catch(err){ cleanup(); }
})();
