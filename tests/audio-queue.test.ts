import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaults } from "../server/config.js";
import { encodeArgs } from "../server/encoder.js";
import { RtmpOutput } from "../server/providers.js";
import { runCapture } from "../server/process.js";
import { prepareQueue, isLongVideo } from "../server/queue.js";
import { overlayLayout, formatUploadDate } from "../server/overlay.js";

test("44.1 and 48 kHz audio retain tone pitch and duration after encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-audio-"));
  const signal = new AbortController().signal;
  try {
    for (const rate of [44100,48000]) {
      const file = path.join(root, `${rate}.m4a`), pcm = path.join(root, `${rate}.pcm`);
      const args = encodeArgs(defaults,19000,0);
      await runCapture("ffmpeg", ["-y","-f","lavfi","-i",`sine=frequency=1000:sample_rate=${rate}:duration=3,asetpts=PTS*1.02`,"-vn",...args.slice(args.indexOf("-c:a"), -3),file],signal);
      const stream = JSON.parse(await runCapture("ffprobe", ["-v","error","-select_streams","a:0","-show_entries","stream=sample_rate,channels","-of","json",file],signal)).streams[0];
      assert.equal(stream.sample_rate,"48000");
      assert.equal(stream.channels,2);
      await runCapture("ffmpeg",["-y","-i",file,"-ac","1","-ar","48000","-f","f32le",pcm],signal);
      const data = await readFile(pcm);
      let crossings = 0, peakStep = 0;
      for(let n=4801;n<124800;n++) {
        const a=data.readFloatLE((n-1)*4), b=data.readFloatLE(n*4);
        if(a<=0 && b>0)crossings++;
        peakStep=Math.max(peakStep,Math.abs(b-a));
      }
      assert.ok(Math.abs(crossings/2.5-1000)<2, `pitch changed at ${rate}`);
      assert.ok(peakStep<.04, `unexpected impulse at ${rate}`);
      assert.ok(Math.abs(data.length/4/48000-3)<.06);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test("audio clock does not stretch to timestamps and UDP handoff has a bounded receive buffer", () => {
  const args = encodeArgs(defaults, 19000, 0);
  const filter = args[args.indexOf("-af") + 1];
  assert.match(filter, /aresample=48000:async=0/);
  assert.match(filter, /out_chlayout=stereo/);
  assert.match(filter, /asetpts=N\/SR\/TB/);
  const output = new RtmpOutput("youtube", "test-key").args(defaults, 19000);
  const input = output[output.indexOf("-i") + 1];
  assert.match(input, /buffer_size=4194304/);
  assert.match(input, /fifo_size=65536/);
});

test("shuffle separates long videos when possible and 70 minutes is short", () => {
  const items=[4201,100,28800,4200,8000,20].map((duration,n)=>({id:String(n),videoId:String(n),position:n,title:"Video",channel:"",thumbnail:"",available:true,duration}));
  const queue=prepareQueue(items,{...defaults,shuffle:true},()=>0).items;
  for(let n=0;n<queue.length;n++) assert.ok(!(isLongVideo(queue[n])&&isLongVideo(queue[(n+1)%queue.length])));
  assert.equal(isLongVideo(items[3]),false);
});

test("full title and upload date fit beside avatar without truncation",()=>{
  const title="This is a very long video title with more words than the previous single line could display ".repeat(4);
  const layout=overlayLayout({...defaults,overlay:{...defaults.overlay,avatar:"avatar.png",title}},"2026-09-13T12:00:00Z");
  assert.equal(layout.title.replace(/\s/g,""),title.replace(/\s/g,""));
  assert.equal(layout.date,"Sep.13.26");
  assert.equal(layout.textY,layout.avatarY);
  assert.ok(layout.dateOffset+layout.dateSize*1.5<=defaults.overlay.avatarSize);
  assert.equal(formatUploadDate(""),"");
});
