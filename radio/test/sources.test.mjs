import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { openPublic, publicURL, isPublicAddress, resolvePublic, readLimited } from '../src/sources/network.mjs';
import { parseDriveFolder, listDriveFiles } from '../src/sources/drive.mjs';
import { SourceImporter, normalizeSources, readCachedFiles, validateAudio } from '../src/sources/importer.mjs';
const fixture = entries => `window['_DRIVE_ivd'] = '${JSON.stringify([entries,null]).replace(/[\[\]"]/g, c => '\\x'+c.charCodeAt(0).toString(16))}';`;
const entry = (id='abcdefghijk123',mime='audio/mpeg') => [id,[], 'Example.mp3',mime,0,null,0,0,0,0,0,null,null,4];
const response = (content,headers={}) => ({headers,body:Readable.from([Buffer.from(content)])});
test('reject private IP literals, credential URLs and nonstandard ports', () => {
  for (const url of ['http://127.0.0.1/a','http://2130706433/a','http://[::1]/','http://[::ffff:127.0.0.1]/','http://169.254.169.254/','http://10.0.0.1/','ftp://example.com/','https://a:b@example.com/','http://example.com:8080/']) assert.throws(() => publicURL(url));
  assert.equal(isPublicAddress('8.8.8.8'),true); assert.equal(isPublicAddress('2606:4700::1111'),true);
});
test('reject mixed public/private DNS results', async () => {
  await assert.rejects(resolvePublic(new URL('https://example.com/'),async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
});
test('parse public Drive metadata without evaluating scripts; fail closed', () => {
  assert.deepEqual(parseDriveFolder(fixture([entry()]))[0], {id:'abcdefghijk123',name:'Example.mp3',mime:'audio/mpeg',size:4,modifiedAt:0});
  assert.throws(() => parseDriveFolder('<html>login</html>'));
  assert.throws(() => parseDriveFolder(fixture(Array(50).fill(entry()))),/paginated/);
});
test('bounded recursive public folder listing', async () => {
  const files = await listDriveFiles('https://drive.google.com/drive/folders/folderabcdefgh', {open:async () => response(fixture([entry()]))});
  assert.equal(files.length,1); assert.match(files[0].url,/export=download/);
  await assert.rejects(listDriveFiles('https://drive.google.com/drive/folders/folderabcdefgh',{maxDepth:0,open:async () => response(fixture([entry('childabcdefgh','application/vnd.google-apps.folder')]))}),/depth/);
});
test('response body byte bound', async () => { await assert.rejects(readLimited(response('12345'),4),/byte limit/); });
test('multiple sources: atomic cache, reuse, partial failures preserve tracks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'sources-'));
  try {
    let calls=0;
    const importer = new SourceImporter({cacheDir:dir,open:async url => { calls++; if(url.includes('bad')) throw new Error('Source returned HTTP 403');return response('test'); },probe:async () => ({duration:1})});
    let result=await importer.sync(['https://example.com/one','https://example.com/two','https://example.com/bad']);
    assert.equal(result.imported,2);assert.equal(result.tracks.length,2);assert.equal(result.errors.length,1);
    result=await importer.sync(['https://example.com/one','https://example.com/two'],{refreshDirect:false});
    assert.equal(result.cached,2);assert.equal(calls,3);
    assert.equal((await readFile(result.tracks[0])).toString(),'test');
    assert.equal((await readdir(dir)).length,3);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('invalid media, HTML and byte overflows never enter cache', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'sources-'));
  try {
    for (const options of [{open:async()=>response('12345'),limits:{maxFileBytes:4}}, {open:async()=>response('test'),probe:async()=>{throw new Error('invalid audio');}}, {open:async()=>response('login',{'content-type':'text/html'})}]) {
      const importer = new SourceImporter({cacheDir:dir,probe:async()=>{},...options});
      const result=await importer.sync(['https://example.com/audio']);assert.equal(result.errors.length,1);assert.deepEqual(await readdir(dir),[]);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('source normalization deduplicates and bounds input',()=>{assert.equal(normalizeSources(['https://example.com/a','https://example.com/a']).length,1);assert.throws(()=>normalizeSources(Array(21).fill('https://example.com/a')));});

test('redirect DNS is revalidated before connecting and credentials never forwarded', async () => {
  const requests=[];
  const request=(url,options,callback)=> {
    requests.push({url:url.href,options});
    const emitter=new EventEmitter();
    queueMicrotask(()=>callback({statusCode:302,headers:{location:'https://private.example/path'},destroy(){}}));
    return emitter;
  };
  await assert.rejects(openPublic('https://public.example/file',{request,lookup:async host=>[{address:host==='public.example'?'8.8.8.8':'127.0.0.1',family:4}]}),/private/);
  assert.equal(requests.length,1);
  assert.equal(requests[0].options.headers.authorization,undefined);
  assert.equal(requests[0].options.headers.cookie,undefined);
  await new Promise(resolve=>requests[0].options.lookup('public.example',{},(_e,address)=>{assert.equal(address,'8.8.8.8');resolve();}));
});
test('DNS lookup observes total timeout',async()=>{
  await assert.rejects(openPublic('https://example.com/',{timeoutMs:5,lookup:()=>new Promise(resolve=>setTimeout(()=>resolve([{address:'8.8.8.8',family:4}]),30))}),/timeout/i);
});
test('cache root serializes instances and bounds aggregate bytes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sources-root-'));
  try {
    const options={cacheRoot:dir,limits:{maxCacheBytes:12000},open:async()=>response('a'.repeat(5000)),probe:async()=>({duration:1})};
    const a=new SourceImporter({...options,cacheDir:path.join(dir,'a')});
    const b=new SourceImporter({...options,cacheDir:path.join(dir,'b')});
    const results=await Promise.all([a.sync(['https://example.com/one']),b.sync(['https://example.com/two'])]);
    assert.equal(results.reduce((n,r)=>n+r.imported,0),1);
    assert.equal(results.reduce((n,r)=>n+r.errors.length,0),1);
    assert.equal((await readCachedFiles(path.join(dir,'a')))[0].duration,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('Drive changes replace validated bytes atomically and failed updates keep prior track',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sources-refresh-'));
  try {
    let content='test';
    const importer=new SourceImporter({cacheDir:dir,open:async url=>url.includes('/folders/')?response(fixture([[...entry().slice(0,13),content.length]])):response(content),probe:async()=>({duration:2})});
    const url='https://drive.google.com/drive/folders/folderabcdefgh';
    const first=await importer.sync([url]);assert.equal(first.imported,1);
    content='changed';const second=await importer.sync([url]);assert.equal(second.imported,1);assert.equal(second.tracks.length,1);assert.equal(await readFile(second.tracks[0],'utf8'),'changed');
    content='failing update';importer.probe=async()=>{throw Error('remote https://example.com?secret=private');};
    const third=await importer.sync([url]);assert.equal(third.errors.length,1);assert.equal(await readFile(third.tracks[0],'utf8'),'changed');assert.equal(JSON.stringify(third.errors).includes('private'),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('real ffprobe validates generated PCM WAV and rejects HTML disguised as audio',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sources-probe-'));
  try {
    const wav=Buffer.alloc(44+16000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
    const file=path.join(dir,'probe.mp3');await writeFile(file,wav);
    assert.equal((await validateAudio(file)).duration,1);
    await writeFile(file,'<html>Please sign in</html>');await assert.rejects(validateAudio(file),/not a supported audio/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('explicit direct URL refresh replaces audio but failure preserves cached audio',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sources-direct-refresh-'));
  try {
    let content='first';const importer=new SourceImporter({cacheDir:dir,open:async()=>response(content),probe:async()=>({duration:1})});
    const urls=['https://example.com/music.mp3'];await importer.sync(urls);
    content='second';const result=await importer.sync(urls,{refreshDirect:true});assert.equal(result.imported,1);assert.equal(await readFile(result.tracks[0],'utf8'),'second');
    importer.open=async()=>{throw Error('offline');};const failed=await importer.sync(urls,{refreshDirect:true});assert.equal(failed.errors.length,1);assert.equal(await readFile(failed.tracks[0],'utf8'),'second');
  } finally {await rm(dir,{recursive:true,force:true});}
});
