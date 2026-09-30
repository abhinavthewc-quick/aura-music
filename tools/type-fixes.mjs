import { readFileSync, writeFileSync } from 'node:fs';
let n = 0;
const patch = (file, pairs) => {
  let t = readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!t.includes(a)) { console.error('MISS ' + file + ': ' + a.slice(0, 70)); continue; }
    const cnt = t.split(a).length - 1;
    t = t.split(a).join(b); n += cnt;
  }
  writeFileSync(file, t);
};

patch('src/types/globals.d.ts', [
  ['interface Navigator {', "interface EventTarget {\n  [key: string]: any;\n}\n\ninterface Navigator {\n  mozConnection?: any;"],
]);
patch('src/expose.ts', [
  ["import { toast } from './core/state';", "import { toast } from './core/dom';"],
]);
patch('src/core/state.ts', [
  ['const savedLikeMap =', 'export const savedLikeMap ='],
]);
patch('src/features/settings.ts', [
  ['renderSearchHistory', '(window as any).renderSearchHistory'],
]);
patch('src/app.ts', [
  ['function show(kind,html,ms){', 'function show(kind,html,ms?){'],
]);
patch('src/features/ambience.ts', [
  ['export function lfoOn(param,freq,depth,bucket,type){', 'export function lfoOn(param,freq,depth,bucket,type?){'],
]);
patch('src/features/beeboo.ts', [
  ['export async function sendBeebooMessage(presetText){', 'export async function sendBeebooMessage(presetText?){'],
  ['const pos = await new Promise((resolve, reject) =>', 'const pos = await new Promise<any>((resolve, reject) =>'],
]);
patch('src/features/home.ts', [
  ['export function renderAuraPicks(force){', 'export function renderAuraPicks(force?){'],
]);
patch('src/core/dom.ts', [
  ['export function stateHTML(kind,title,sub,btnLabel,btnJs){', 'export function stateHTML(kind,title,sub?,btnLabel?,btnJs?){'],
]);
patch('src/features/library.ts', [
  ['export function openLocalDB(){\n      return new Promise(', 'export function openLocalDB(){\n      return new Promise<any>('],
  ['export async function saveLocalBlob(id, blob){\n      const db = await openLocalDB();\n      return new Promise(', 'export async function saveLocalBlob(id, blob){\n      const db = await openLocalDB();\n      return new Promise<void>('],
  ['export async function deleteLocalBlob(id){\n      const db = await openLocalDB();\n      return new Promise(', 'export async function deleteLocalBlob(id){\n      const db = await openLocalDB();\n      return new Promise<void>('],
  ['export function readAudioTags(file){\n      return new Promise(resolve => {', 'export function readAudioTags(file){\n      return new Promise<any>(resolve => {'],
  ['Array.from(fileList || [])', 'Array.from<any>(fileList || [])'],
]);
patch('src/features/player.ts', [
  ['auraYTReadyPromise = new Promise((resolve,reject)=>{', 'auraYTReadyPromise = new Promise<void>((resolve,reject)=>{'],
]);
patch('src/features/search.ts', [
  ['export function jsonpRequest(url){\n      return new Promise((resolve,reject)=>{', 'export function jsonpRequest(url){\n      return new Promise<any>((resolve,reject)=>{'],
]);
patch('src/ui/login.ts', [
  ['!panel.contains(e.target)', '!panel.contains(e.target as any)'],
  ['!btn.contains(e.target)', '!btn.contains(e.target as any)'],
]);
patch('src/ui/mini-player.ts', [
  ['const el=$(id);', 'const el=$(id as string);'],
]);
console.log('replacements:', n);
