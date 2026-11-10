/* AURA orb: a spinning sphere of soft dots for small in-app loading states. */
(function(){
  var TAU=Math.PI*2, GA=Math.PI*(3-Math.sqrt(5)), D=3.2, reduce=false;
  try{ reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}

  function create(canvas,o){
    o=o||{};
    var ctx=canvas.getContext('2d'); if(!ctx) return null;
    var n=o.count||520, pts=[], i;
    for(i=0;i<n;i++){
      var y=1-(i+.5)/n*2, r=Math.sqrt(1-y*y), th=GA*i;
      pts.push({x:Math.cos(th)*r,y:y,z:Math.sin(th)*r,s:.5+Math.pow(Math.random(),2.3)*2.3,w:Math.random()*TAU});
    }
    var dpr=Math.min(window.devicePixelRatio||1,2), cw=0, ch=0, rot=Math.random()*TAU;
    var tilt=o.tilt==null?.38:o.tilt, speed=(o.speed||.9)*(reduce?.25:1);
    var col=o.color||[255,255,255];
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
        var cc=col;
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
    for(var i=0;i<list.length;i++){
      list[i].setAttribute('data-orb','1');
      create(list[i],{count:150,radius:.46,dot:2.6,speed:1.4,tilt:.4,stopWhenDetached:true});
    }
  }
  window.AuraOrb={create:create,mountAll:mountAll,reduce:reduce};
})();
