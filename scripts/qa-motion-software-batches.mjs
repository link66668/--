// Decode only: compare every RGBA picture, preview JPEG and timestamp with the
// previous late-trim filter order. No pose model, GPU or AI provider is used.
import assert from 'node:assert/strict';
import {readFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {startServer} from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/qa-motion-software-batches.mjs VIDEO');
const video = resolve(process.argv[2]);
const decoderFile = resolve(process.env.QA_SOFTWARE_DECODER || join(root, 'public/motion-software-decode.js'));
const decoderSource = await readFile(decoderFile, 'utf8');
if (!decoderSource.includes('trimBeforeScale')) throw new Error('The decoder under test must support both trim orders. Set QA_SOFTWARE_DECODER to an explicit candidate when production is frozen.');
const decoderHash = createHash('sha256').update(decoderSource).digest('hex');
await mkdir(join(root, '.qa'), {recursive: true});
const dataDir = await mkdtemp(join(root, '.qa', 'motion-software-batches-'));
const {chromium} = await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT || join(root, '.qa/browser-tools/node_modules/playwright/index.mjs'))));
const server = await startServer({host: '127.0.0.1', port: 0, dataDir});
const browser = await chromium.launch({headless: true, args: ['--disable-gpu'], executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const workerScript = `self.onmessage = async ({data}) => {
 let source;
 try {
  const {prepareMotionSource, decodePreparedMotion} = await import('/motion-software-decode.js');
  source = await prepareMotionSource(data.file);
  self.postMessage({type:'progress',stage:'prepared',metadata:source.metadata,codec:source.stream.codec_name});
  const frames=[],previews=[];let lastProgress=0;
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  const timing=await decodePreparedMotion(source,async(canvas,target)=>{
   frames.push({time:target.time,width:canvas.width,height:canvas.height,sha256:await hash(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)});
   if(frames.length%30===0)self.postMessage({type:'progress',stage:'frames',completed:frames.length});
  },{asyncInference:true,sampleFps:7.5,trimBeforeScale:data.trimBeforeScale,maxDimension:1280,
    onProgress:progress=>{if(performance.now()-lastProgress>10000){lastProgress=performance.now();self.postMessage({type:'progress',stage:'decode',progress:progress.progress});}},
    onPreview:frame=>previews.push(hash(frame.bytes).then(sha256=>({time:frame.time,width:frame.width,height:frame.height,sha256})))
  });
  self.postMessage({type:'done',metadata:source.metadata,codec:source.stream.codec_name,timing,frames,previews:await Promise.all(previews)});
 }catch(error){self.postMessage({type:'error',message:error.message});}finally{source?.close();self.close();}
};`;
try {
 const page = await browser.newPage();
 await page.route('**/motion-software-decode.js', route => route.fulfill({contentType: 'text/javascript', body: decoderSource}));
 await page.route('**/qa-software-batches-worker.js', route => route.fulfill({contentType: 'text/javascript', body: workerScript}));
 await page.exposeFunction('qaSoftwareProgress', value => console.log(JSON.stringify(value)));
 await page.goto(`http://127.0.0.1:${server.address().port}/vendor/README.md`);
 await page.evaluate(() => {document.body.innerHTML = '<input type="file">';});
 await page.locator('input').setInputFiles(video);
 const results = [];
 for (const trimBeforeScale of [false, true]) {
  const result = await page.evaluate(async trimBeforeScale => {
   const worker = new Worker('/qa-software-batches-worker.js');
   try { return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {worker.terminate();reject(new Error('Software comparison timed out'));}, 15*60*1000);
    worker.onerror = event => {clearTimeout(timer);reject(new Error(event.message));};
    worker.onmessage = ({data}) => {
     if(data.type==='progress'){void window.qaSoftwareProgress({trimBeforeScale,...data});return;}
     clearTimeout(timer);data.type==='error'?reject(new Error(data.message)):resolve(data);
    };
    worker.postMessage({file:document.querySelector('input').files[0],trimBeforeScale});
   }); } finally {worker.terminate();}
  }, trimBeforeScale);
  assert.equal(result.frames.length, Math.ceil(result.metadata.duration * 7.5));
  results.push({trimBeforeScale, ...result});
  await writeFile(join(dataDir, 'results.json'), JSON.stringify({video:basename(video),decoderHash,results}, null, 2));
 }
 assert.deepEqual(results[1].frames, results[0].frames, 'Every source picture and sample time must remain exact');
 assert.deepEqual(results[1].previews, results[0].previews, 'Every preview picture and time must remain exact');
 console.log(JSON.stringify({dataDir, decoderHash, frames:results[0].frames.length, previews:results[0].previews.length, codec:results[0].codec, decodeMs:results.map(result=>result.timing.decodeMs), exactPixelsAndTimes:true}));
} finally {await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
