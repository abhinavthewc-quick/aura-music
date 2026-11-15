import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: {
  'browser-url': {type:'string',default:'http://127.0.0.1:9339'},
  port: {type:'string',default:'9338'},
  output: {type:'string',default:path.join(os.homedir(),'.local/share/aura-music/browser-checks')},
  help: {type:'boolean',default:false},
}});
if (values.help) {
  console.log('Usage: node tooling/browser/devtools-bridge.mjs [--browser-url http://127.0.0.1:9339] [--port 9338] [--output /private/path]');
  process.exit(0);
}
const port = Number(values.port);
const browser = new URL(values['browser-url']);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535');
if (!['localhost','127.0.0.1'].includes(browser.hostname) || browser.protocol !== 'http:') throw new Error('CDP must be on localhost');
const output = path.resolve(values.output);
const repo = fileURLToPath(new URL('../../',import.meta.url));
if (output === repo.slice(0,-1) || output.startsWith(repo)) throw new Error('Browser output must stay outside Git');
process.umask(0o077);
await fs.mkdir(output,{recursive:true,mode:0o700});
const mcp = fileURLToPath(new URL('../node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js',import.meta.url));
const transport = new StdioClientTransport({command:process.execPath,args:[mcp,
  `--browser-url=${browser.href}`,'--no-page-id-routing','--no-usage-statistics',
  '--no-performance-crux','--redact-network-headers',`--workspace=${output}`],stderr:'pipe'});
transport.stderr?.on('data',data => fs.appendFile(path.join(output,'mcp-stderr.log'),data).catch(()=>{}));
const client = new Client({name:'aura-browser-checks',version:'1.0.0'});
await client.connect(transport);
const toolList = await client.listTools();
let serial = Promise.resolve();
const server = http.createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Cache-Control','no-store');
  try {
    // Local browser pages must not be able to invoke this privileged bridge.
    if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403); res.end('{"error":"Local CLI clients only"}'); return;
    }
    if (req.method === 'GET' && req.url === '/tools') {res.end(JSON.stringify(toolList));return;}
    if (req.method !== 'POST' || req.url !== '/call') {res.writeHead(404);res.end('{}');return;}
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1024*1024) throw new Error('Request too large');
    }
    const args = JSON.parse(raw);
    const pending = serial.then(() => client.callTool(args,undefined,{timeout:120000}));
    serial = pending.catch(()=>{});
    res.end(JSON.stringify(await pending));
  } catch (error) {res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Chrome DevTools MCP bridge: http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=>{server.close();await client.close();process.exit(0);});
