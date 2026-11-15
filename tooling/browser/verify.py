#!/usr/bin/env python3
"""Read-only live catalogue/Admin checks through Chrome DevTools MCP."""
import argparse
import json
import os
from pathlib import Path
from mcp_client import DevTools


def check(name, passed, detail=None):
    print(json.dumps({'check':name,'passed':bool(passed),'detail':detail}),flush=True)
    if not passed:
        raise AssertionError(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site',default='https://aura-music-01g.pages.dev')
    parser.add_argument('--bridge',default='http://127.0.0.1:9338')
    parser.add_argument('--email',help='Admin email; requires --password-file')
    parser.add_argument('--password-file',type=Path)
    parser.add_argument('--output',type=Path,default=Path.home()/'.local/share/aura-music/browser-checks')
    args = parser.parse_args()
    if bool(args.email) != bool(args.password_file):
        parser.error('Supply both --email and --password-file for Admin checks')
    os.umask(0o077)
    output = args.output.expanduser().resolve()
    repo = Path(__file__).resolve().parents[2]
    if output == repo or repo in output.parents:
        parser.error('Browser output must stay outside the repository')
    output.mkdir(parents=True,exist_ok=True,mode=0o700)
    dev = DevTools(args.bridge)
    dev.call('emulate',{'viewport':'1440x1000x1'})
    dev.call('navigate_page',{'type':'url','url':args.site.rstrip('/')+'/'})
    result = dev.evaluate('''async()=>{
      const response=await fetch('/api/versions'); const registry=await response.json();
      const deadline=Date.now()+25000;
      while(document.getElementById('auraLoader')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
      const images=[...document.querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect();return e.getAttribute('src')&&getComputedStyle(e).visibility!=='hidden'&&r.width>0&&r.top<innerHeight&&r.bottom>0&&r.left<innerWidth&&r.right>0;});
      return {database:response.ok&&registry.source==='database',tracks:Object.keys(registry.tracks||{}).length,
        ready:Object.values(registry.tracks||{}).reduce((n,v)=>n+Object.keys(v).length,0),
        background:getComputedStyle(document.body).backgroundColor,images:images.length,loaded:images.filter(e=>e.complete&&e.naturalWidth>0).length,
        legacy:performance.getEntriesByType('resource').some(e=>e.name.endsWith('/versions.json'))};}''')
    check('Versions come from D1',result['database'],{'tracks':result['tracks'],'ready':result['ready']})
    check('No legacy JSON request',not result['legacy'])
    check('Black design retained',result['background']=='rgb(0, 0, 0)')
    dev.call('take_screenshot',{'filePath':str(output/'catalogue-desktop.png')})
    if args.email:
        password = args.password_file.expanduser()
        if password.stat().st_mode & 0o077:
            raise ValueError('Password file must have permissions 0600')
        dev.call('navigate_page',{'type':'url','url':args.site.rstrip('/')+'/admin'})
        if dev.evaluate('()=>!document.getElementById("gateCard").hidden'):
            dev.call('fill',{'uid':dev.uid('textbox "Email address"'),'value':args.email})
            dev.call('fill',{'uid':dev.uid('textbox "Password"'),'value':password.read_text().strip()})
            dev.evaluate('()=>{document.getElementById("admPasswordBtn").click();return true;}')
        for width in (1440,390):
            dev.call('emulate',{'viewport':f'{width}x950x1'+(',mobile,touch' if width==390 else '')})
            data = dev.evaluate('''async()=>{
              const deadline=Date.now()+25000;
              while((!document.querySelector('[data-panel="panelProcessing"]')||!document.getElementById('gateCard').hidden)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
              document.querySelector('[data-panel="panelProcessing"]').click();
              while(document.getElementById('audioJobs').getAttribute('aria-busy')==='true'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
              return {counts:[...document.querySelectorAll('#audioSummary strong')].map(e=>Number(e.textContent)),
                rows:document.querySelectorAll('#audioJobs tbody tr').length,coverage:document.getElementById('audioCoverageText').textContent,
                overflow:document.documentElement.scrollWidth>innerWidth+1,background:getComputedStyle(document.body).backgroundColor};}''')
            check(f'Admin processing records at {width}px',data['rows']>0,data)
            check(f'Admin fits black design at {width}px',not data['overflow'] and data['background']=='rgb(0, 0, 0)')
            dev.call('take_screenshot',{'filePath':str(output/f'admin-{width}.png')})
        dev.call('emulate',{'viewport':'1440x1000x1'})
        dev.call('navigate_page',{'type':'url','url':args.site.rstrip('/')+'/'})
        data = dev.evaluate('''async()=>{
          const deadline=Date.now()+25000;
          while((!window.state?.songs?.length||document.getElementById('auraLoader'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
          const images=()=>[...document.querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect();return e.getAttribute('src')&&getComputedStyle(e).visibility!=='hidden'&&r.width>0&&r.top<innerHeight&&r.bottom>0&&r.left<innerWidth&&r.right>0;});
          while(images().some(e=>!e.complete)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
          return {songs:window.state?.songs?.length||0,variants:window.state?.songs?.filter(s=>Object.keys(s.audioVersions||{}).length).length||0,
            images:images().length,loaded:images().filter(e=>e.naturalWidth>0).length,
            legacy:performance.getEntriesByType('resource').some(e=>e.name.endsWith('/versions.json'))};}''')
        check('Signed-in catalogue includes database versions',data['songs']>0 and data['variants']>0,data)
        check('Visible artwork loads',data['images']>0 and data['images']==data['loaded'])
        check('Signed-in catalogue makes no legacy JSON request',not data['legacy'])
        dev.call('take_screenshot',{'filePath':str(output/'catalogue-signed-in.png')})
    (output/'console.txt').write_text(dev.call('list_console_messages',{'types':['error'],'includePreservedMessages':False}))
    (output/'network.txt').write_text(dev.call('list_network_requests',{'resourceTypes':['fetch','xhr']}))


if __name__ == '__main__':
    main()
