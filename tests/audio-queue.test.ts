import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaults } from "../server/config.js";
import { encodeArgs } from "../server/encoder.js";
import { RtmpOutput } from "../server/providers.js";
import { runCapture } from "../server/process.js";
import {
  prepareQueue,
  isLongVideo,
  canStartShuffledQueue,
  shuffleOrderError,
  needsLongDownloadLead,
  canLeadLongDownload,
  canFollowInShuffledQueue,
} from "../server/queue.js";
import { overlayLayout, formatUploadDate } from "../server/overlay.js";

test("44.1 and 48 kHz audio retain tone pitch and duration after encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-audio-"));
  const signal = new AbortController().signal;
  try {
    for (const rate of [44100,48000]) {
      const duration = 180;
      const file = path.join(root, `${rate}.m4a`), pcm = path.join(root, `${rate}.pcm`);
      const settings = {...defaults,youtube:{...defaults.youtube,enabled:true}};
      const args = encodeArgs(settings,19000,0);
      await runCapture("ffmpeg", ["-y","-f","lavfi","-i",`sine=frequency=1000:sample_rate=${rate}:duration=${duration}`,"-vn",...args.slice(args.indexOf("-c:a"), -3),file],signal);
      const probe = JSON.parse(await runCapture("ffprobe", ["-v","error","-select_streams","a:0","-show_entries","stream=sample_rate,channels:format=duration","-of","json",file],signal));
      assert.equal(probe.streams[0].sample_rate,"44100");
      assert.equal(probe.streams[0].channels,2);
      assert.ok(Math.abs(Number(probe.format.duration)-duration)<.1);
      await runCapture("ffmpeg",["-y","-ss",String(duration-3),"-i",file,"-ac","1","-ar","48000","-t","3","-f","f32le",pcm],signal);
      const data = await readFile(pcm);
      let crossings = 0, peakStep = 0;
      for(let n=4801;n<124800;n++) {
        const a=data.readFloatLE((n-1)*4), b=data.readFloatLE(n*4);
        if(a<=0 && b>0)crossings++;
        peakStep=Math.max(peakStep,Math.abs(b-a));
      }
      assert.ok(Math.abs(crossings/2.5-1000)<2, `pitch changed near 3 minutes at ${rate}`);
      assert.ok(peakStep<.04, `unexpected impulse near 3 minutes at ${rate}`);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test("audio preserves source timestamps and UDP handoff absorbs upload stalls", () => {
  const settings = {
    ...defaults,
    youtube: { ...defaults.youtube, enabled: true },
  };
  const args = encodeArgs(settings, 19000, 0);
  assert.equal(args.includes("-af"), false);
  assert.equal(args[args.indexOf("-ar") + 1], "44100");
  assert.equal(args[args.indexOf("-ac") + 1], "2");
  assert.match(args.at(-1)!, /buffer_size=4194304/);
  const output = new RtmpOutput("youtube", "test-key").args(settings, 19000);
  assert.equal(output[output.indexOf("-loglevel") + 1], "warning");
  assert.equal(output[output.indexOf("-thread_queue_size") + 1], "8192");
  const input = output[output.indexOf("-i") + 1];
  assert.match(input, /buffer_size=4194304/);
  assert.match(input, /fifo_size=262144/);
});

test("shared YouTube and Twitch encoding retains 48 kHz audio", () => {
  const settings = {
    ...defaults,
    youtube: { ...defaults.youtube, enabled: true },
    twitch: { ...defaults.twitch, enabled: true },
  };
  const args = encodeArgs(settings, 19000, 0);
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
});

test("shuffle starts with two short videos and gives 3-hour videos download lead time", () => {
  const items = [4201, 30, 12000, 4200, 8000, 20, 14400, 1000].map(
    (duration, index) => ({
      id: String(index),
      videoId: String(index),
      position: index,
      title: "Video",
      channel: "",
      thumbnail: "",
      available: true,
      duration,
    }),
  );
  const queue = prepareQueue(
    items,
    { ...defaults, shuffle: true },
    () => 0,
  ).items;
  assert.ok(canStartShuffledQueue(queue[0]));
  assert.ok(canStartShuffledQueue(queue[1]));
  for (let index = 1; index < queue.length; index++) {
    if (needsLongDownloadLead(queue[index]))
      assert.ok(
        canLeadLongDownload(queue[index - 1]),
        "a video over 3 hours needs a 2-hour predecessor",
      );
    assert.ok(
      canFollowInShuffledQueue(queue[index - 1], queue[index]),
      "shuffle emitted a forbidden long-video pair",
    );
  }
  assert.equal(isLongVideo(items[3]), false);
  assert.equal(shuffleOrderError(queue), null);

  const badOpening = [...queue];
  const ordinaryLong = badOpening.findIndex(
    (item) => isLongVideo(item) && !needsLongDownloadLead(item),
  );
  badOpening.splice(0, 0, badOpening.splice(ordinaryLong, 1)[0]);
  assert.match(shuffleOrderError(badOpening)!, /first two playable/);

  const badLead = [...queue];
  const veryLong = badLead.findIndex(needsLongDownloadLead);
  badLead.splice(2, 0, badLead.splice(veryLong, 1)[0]);
  assert.match(shuffleOrderError(badLead)!, /over 3 hours/);
});
test("full title and upload date fit beside avatar without truncation",()=>{
  const title="This is a very long video title with more words than the previous single line could display ".repeat(4);
  const layout=overlayLayout({...defaults,overlay:{...defaults.overlay,avatar:"avatar.png",title}},"2026-09-13T12:00:00Z");
  assert.equal(layout.title.replace(/\s/g,""),title.replace(/\s/g,""));
  assert.equal(layout.date,"Sep.13.26");
  const blockHeight=layout.dateOffset+layout.dateSize*1.5;
  assert.ok(layout.textY>=layout.avatarY);
  assert.ok(layout.textY+blockHeight<=layout.avatarY+defaults.overlay.avatarSize);
  assert.ok(Math.abs((layout.textY+blockHeight/2)-(layout.avatarY+defaults.overlay.avatarSize/2))<1);
  assert.equal(formatUploadDate(""),"");
});
