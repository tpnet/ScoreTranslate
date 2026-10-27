import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as alphaTab from "@coderline/alphatab";
import JSZip from "jszip";
import { PNG } from "pngjs";
import { MAX_SIZE, OUTPUT_EXTS, type OutputExt, type Render } from "../lib/formats";
import { convertScore, listTracks } from "../lib/convert";
import { scoreToMusicXml } from "../lib/gp-to-musicxml";
import { parseOptions } from "../lib/request";
import { render } from "../server/render";

// 真实 HTTP 与 MuseScore 回归，不 mock 转换引擎；随机端口避免影响开发服务。
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
const { server } = await import("../server/index");
const url = `http://127.0.0.1:${server.port}`;
const dir = await mkdtemp(path.join(tmpdir(), "score-verify-"));
const native = process.argv.includes("--native");
const nativeBinary = path.resolve(`src-tauri/target/debug/examples/render${process.platform === "win32" ? ".exe" : ""}`);
let renderSequence = 0;
const nativeRender: Render = async (data, request) => {
  const id = ++renderSequence;
  const input = path.join(dir,`${id}.input`);
  const output = path.join(dir,`${id}.output`);
  await writeFile(input,data);
  const process = Bun.spawn([nativeBinary,input,JSON.stringify(request),output],{stdout:"pipe",stderr:"pipe"});
  const error = await new Response(process.stderr).text();
  assert.equal(await process.exited,0,error);
  return new Uint8Array(await readFile(output));
};
const fixture = new Uint8Array(await readFile(new URL("./fixtures/two-tracks.musicxml", import.meta.url)));
const settings = new alphaTab.Settings();
const load = (data: Uint8Array) => alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
const pitches = (s: alphaTab.model.Score) => s.tracks.map(t =>
  t.staves.flatMap(st => st.bars.flatMap(b =>
    b.voices.flatMap(v => v.beats.flatMap(bt => bt.notes.map(n => n.realValue))))));
const score = load(fixture);
const gp = new alphaTab.exporter.Gp7Exporter().export(score, settings);
let checks = 0;
const passed = (label: string) => { checks++; console.log(`✓ ${label}`); };

async function convert(data: Uint8Array, name: string, target: OutputExt, options: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([data as BlobPart], name));
  form.set("target", target);
  for (const [k,v] of Object.entries(options)) form.set(k,v);
  if (native) {
    const result = await convertScore(data,name.split(".").pop()!,target,name.replace(/\.gp\.json$|\.[^.]+$/i,""),parseOptions(form),nativeRender);
    return {bytes:result.data,filename:result.filename};
  }
  const response = await fetch(`${url}/api/convert`, { method: "POST", body: form });
  if (response.status !== 200) assert.fail(`${response.status}: ${(await response.text()).slice(0,300)}`);
  const filename = decodeURIComponent(response.headers.get("X-Filename")!);
  assert(response.headers.get("Content-Disposition")?.includes("filename*=UTF-8''"));
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0);
  return { bytes, filename };
}

try {
  if (native) {
    const build = Bun.spawn(["cargo","build","--locked","--manifest-path","src-tauri/Cargo.toml","--example","render"],{stdout:"inherit",stderr:"inherit"});
    assert.equal(await build.exited,0);
    const nativeStatus = Bun.spawn([nativeBinary,"status"],{stdout:"pipe",stderr:"inherit"});
    assert.equal(JSON.parse(await new Response(nativeStatus.stdout).text()).major,4);
    assert.equal(await nativeStatus.exited,0);
    await assert.rejects(nativeRender(gp,{inputExt:"../gp",target:"pdf"}),/不支持的输入格式/);
    await assert.rejects(nativeRender(gp,{inputExt:"gp",target:"png",dpi:1201}),/参数超出范围/);
    await assert.rejects(nativeRender(new Uint8Array(MAX_SIZE+1),{inputExt:"gp",target:"pdf"}),/50MB/);
    const oversized = PNG.sync.write(new PNG({width:1,height:1}));
    oversized.writeUInt32BE(10001,16); oversized.writeUInt32BE(10000,20);
    oversized.writeUInt32BE(Bun.hash.crc32(oversized.subarray(12,29)),29);
    const largePath = path.join(dir,"oversized.png");
    await writeFile(largePath,oversized);
    const guard = Bun.spawn([nativeBinary,"stitch",largePath,path.join(dir,"too-large.png")],{stdout:"ignore",stderr:"pipe"});
    assert.match(await new Response(guard.stderr).text(),/长图尺寸过大/);
    assert.notEqual(await guard.exited,0);
    passed("原生格式白名单、导出范围、50MB 与 1 亿像素保护");
  }
  assert((await fetch(url)).ok);
  assert((await (await fetch(url)).text()).includes('id="root"'));
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.major, 4, `需要安装 MuseScore 4：${JSON.stringify(status)}`);
  assert.equal((await fetch(`${url}/api/convert`)).status, 405);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  assert.equal((await fetch(`${url}/api/convert`, {method:"POST",body:new FormData()})).status,400);
  assert.equal((await fetch(`${url}/api/convert`, {method:"POST",body:"invalid"})).status,400);
  passed("Web 静态页面、版本检测、方法与上传校验");

  const form = new FormData(); form.set("file",new File([gp as BlobPart],"测试.gp"));
  const tracks = await (await fetch(`${url}/api/tracks`, {method:"POST",body:form})).json();
  assert.deepEqual(tracks.tracks,["Guitar","Bass"]);
  passed("音轨列表与下标");

  const noMuseScore: Render = async () => { throw new Error("直连路径不应调用 MuseScore"); };
  const tab = await convertScore(fixture,"musicxml","musicxml","tab",{staffMode:"tab",mergeLyrics:true},noMuseScore);
  const custom = load(tab.data);
  for (const track of custom.tracks) for (const staff of track.staves) {
    staff.capo = 2;
    staff.tuning[staff.tuning.length - 1] -= 2;
    if (staff.tuning.length === 6) {
      staff.tuning.push(35);
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) note.string++;
    }
    const low = staff.bars[3].voices[0].beats[0].notes[0];
    low.string = 1; low.fret = 0;
  }
  const customTab = new TextEncoder().encode(scoreToMusicXml(custom,"tab"));
  assert.deepEqual(pitches(load(customTab)),pitches(custom));
  for (const input of [tab.data,customTab]) for (const target of ["musicxml","xml","mxl"] as const) {
    const expected = pitches(load(input));
    const standard = await convertScore(input,"musicxml",target,"standard",{staffMode:"standard"},noMuseScore);
    assert.deepEqual(pitches(load(standard.data)),expected,`TAB → ${target} 五线谱回读音高`);
    const xml = target === "mxl" ? await (await JSZip.loadAsync(standard.data)).file("score.xml")!.async("string") : new TextDecoder().decode(standard.data);
    assert(!xml.includes("<sign>TAB</sign>"));
    assert(!/<(?:string|fret|staff-tuning|capo)(?:\s|>)/.test(xml));
    const again = await convertScore(standard.data,target,"musicxml","again",{staffMode:"tab"},noMuseScore);
    assert.deepEqual(pitches(load(again.data)),expected,`TAB → 五线谱 → TAB (${target})`);
    if (target === "musicxml") {
      const mscore = await (native ? nativeRender : render)(standard.data,{inputExt:"musicxml",target:"musicxml"});
      assert.deepEqual(pitches(load(mscore)),expected,"MuseScore 五线谱音高回读");
    }
    passed(`${input === customTab ? "变调夹与特殊调弦" : "标准调弦"} TAB → ${target} 五线谱回读、转回 TAB`);
  }
  for (const track of custom.tracks) for (const staff of track.staves) staff.showStandardNotation = true;
  const both = load(new TextEncoder().encode(scoreToMusicXml(custom,"original")));
  assert.deepEqual(pitches(both),pitches(custom).map(p=>[...p,...p]));
  for (const [i,track] of both.tracks.entries()) assert.deepEqual(track.staves[1].tuning,custom.tracks[i].staves[0].tuning);
  passed("双谱表的五线谱音高正确，TAB 谱表保留四弦/七弦调弦");
  const archive = new JSZip();
  archive.file("META-INF/container.xml",`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><!-- <rootfile full-path="wrong.xml"/> --><rootfile full-path='scores/谱 &amp; &quot;.musicxml' media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`);
  archive.file('scores/谱 & ".musicxml',fixture);
  const compressed = await archive.generateAsync({type:"uint8array",compression:"DEFLATE"});
  for (const ext of ["musicxml","xml","mxl"]) {
    const input = ext === "mxl" ? compressed : fixture;
    assert.deepEqual(await listTracks(input,ext,noMuseScore),["Guitar","Bass"]);
    const trackForm = new FormData(); trackForm.set("file",new File([input as BlobPart],`score.${ext}`));
    assert.deepEqual((await (await fetch(`${url}/api/tracks`,{method:"POST",body:trackForm})).json()).tracks,["Guitar","Bass"]);
    assert.deepEqual((await convert(input,`score.${ext}`,"xml")).bytes,fixture);
    for (const target of ["musicxml","xml","mxl","gp","gp5","json","atex"] as const) {
      const result = await convertScore(input,ext,target,"score",{},noMuseScore);
      assert.equal(result.filename,`score.${target}`);
      if (["musicxml","xml","mxl"].includes(target)) {
        if (target === "mxl" && ext === "mxl") assert.deepEqual(result.data,input);
        const xml = target === "mxl" ? (await convertScore(result.data,"mxl","musicxml","readback",{},noMuseScore)).data : result.data;
        assert.deepEqual(xml,fixture);
      } else {
        const readback = target === "json" || target === "atex" ? await convertScore(result.data,target,"musicxml","readback",{},noMuseScore) : result;
        assert.deepEqual(pitches(load(readback.data)),pitches(score),`${ext} → ${target}`);
      }
      const selected = await convertScore(input,ext,target,"selected",{tracks:[1],staffMode:"tab",mergeLyrics:true},noMuseScore);
      const readback = target === "json" || target === "atex" ? await convertScore(selected.data,target,"musicxml","readback",{},noMuseScore) : selected;
      const parsed = load(readback.data);
      assert.deepEqual(parsed.tracks.map(t=>t.name),["Bass"]);
      assert.deepEqual(pitches(parsed),[pitches(score)[1]],`${ext} → ${target} 选轨`);
      assert.equal(parsed.masterBars.length,4);
      assert.equal(parsed.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics?.[0],"la");
    }
    passed(`${ext} 无 MuseScore 读轨、XML 原文互转、GP 系导出及选轨合并歌词`);
  }
  await assert.rejects(convertScore(new TextEncoder().encode("bad"),"musicxml","mxl","bad",{},noMuseScore),/无法解析该 MusicXML/);
  await assert.rejects(convertScore(gp,"musicxml","xml","bad",{},noMuseScore),/无法解析该 MusicXML/);
  const broken = new JSZip(); broken.file("META-INF/container.xml",'<container><rootfiles><rootfile full-path="missing.xml"/></rootfiles></container>');
  await assert.rejects(convertScore(await broken.generateAsync({type:"uint8array"}),"mxl","xml","bad",{},noMuseScore),/无法解析该 MusicXML/);
  passed("MusicXML / MXL 损坏输入校验");

  const outputs = new Map<OutputExt,Uint8Array>();
  for (const target of OUTPUT_EXTS) {
    const {bytes,filename} = await convert(gp,"测试.gp",target,{dpi:"50",trim:"0",paper:"a4",scale:"100",unrollRepeats:"1"});
    outputs.set(target,bytes);
    assert(filename.startsWith("测试."));
    if (["musicxml","xml","mxl","gp","gp5"].includes(target)) assert.equal(load(bytes).tracks.length,2);
    else if (target === "json") assert(JSON.parse(new TextDecoder().decode(bytes)));
    else if (target === "atex") assert(new TextDecoder().decode(bytes).includes("\\track"));
    else if (target === "pdf") assert.equal(new TextDecoder().decode(bytes.slice(0,4)),"%PDF");
    else if (target === "mid") assert.equal(new TextDecoder().decode(bytes.slice(0,4)),"MThd");
    else if (target === "mscz") assert((await JSZip.loadAsync(bytes)).file(/\.mscx$/).length > 0);
    else if (target === "png-long") assert(PNG.sync.read(Buffer.from(bytes)).width > 0);
    else if (target === "png") assert(bytes[0] === 137 || bytes[0] === 80);
    passed(`GP → ${target}`);
  }

  for (const target of OUTPUT_EXTS) {
    const {bytes} = await convert(gp,"selected.gp",target,{tracks:"1",staffMode:"tab",dpi:"50",mergeLyrics:"1"});
    if (["musicxml","xml","mxl","gp","gp5"].includes(target)) assert.equal(load(bytes).tracks.length,1);
    if (target === "atex") {
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.initFromString(new TextDecoder().decode(bytes),settings);
      const selected = importer.readScore();
      assert.equal(selected.tracks.length,1); assert.equal(selected.masterBars.length,4);
    }
    passed(`选第二轨、TAB、歌词 → ${target}`);
  }

  for (const input of ["json","atex"] as const) {
    const {bytes} = await convert(outputs.get(input)!,`score.${input}`,"gp5");
    assert.equal(load(bytes).tracks.length,2);
    passed(`${input} 输入回转 GP5`);
    for (const target of ["musicxml","xml","mxl"] as const) {
      const all = load((await convert(outputs.get(input)!,`score.${input}`,target)).bytes);
      assert.deepEqual(all.tracks.map(t=>t.name),["Guitar","Bass"]);
      assert.deepEqual(pitches(all),pitches(load(outputs.get("musicxml")!)));
      for (const staffMode of ["tab","standard"]) {
        const selected = await convert(outputs.get(input)!,`score.${input}`,target,{tracks:"1",staffMode,mergeLyrics:"1"});
        const parsed = load(selected.bytes);
        assert.deepEqual(parsed.tracks.map(t=>t.name),["Bass"]);
        assert.equal(parsed.masterBars.length,4);
        assert.deepEqual(pitches(parsed),[pitches(all)[1]]);
        const xml = target === "mxl" ? await (await JSZip.loadAsync(selected.bytes)).file("score.xml")!.async("string") : new TextDecoder().decode(selected.bytes);
        assert(xml.includes("<text>la</text>"));
        assert.equal(xml.includes("<sign>TAB</sign>"),staffMode === "tab");
      }
      passed(`${input} → ${target} 全轨音高、选轨、谱表类型与合并歌词`);
    }
  }
  const timelinePath = path.resolve("scripts/fixtures/song-timeline.gp.json");
  for (const source of ["song-timeline.gp.json", "lyrics-song.json"]) {
    const input = new Uint8Array(await readFile(new URL(`./fixtures/${source}`, import.meta.url)));
    const songForm = new FormData(); songForm.set("file",new File([input as BlobPart],source));
    const names = await (await fetch(`${url}/api/tracks`,{method:"POST",body:songForm})).json();
    assert.equal(names.tracks.length,2);
    const options: Record<string,string> = source.endsWith(".gp.json") ? {jsonTempo:"89"} : {};
    const song = await convert(input,source,"gp",options);
    assert.equal(song.filename,`${source.replace(/\.gp\.json$|\.[^.]+$/i,"")}.gp`);
    const parsed = load(song.bytes);
    assert.equal(parsed.tempo,89); assert.equal(parsed.masterBars.length,2);
    assert.equal(parsed.masterBars[0].section?.marker, source.endsWith(".gp.json") ? "Verse" : "Section 1");
    if (source === "lyrics-song.json") {
      assert.equal(parsed.title.replaceAll("\u00a0"," "),"歌曲 <&>");
      assert.equal(parsed.artist,"作者");
    } else {
      assert.equal(load((await convert(input,source,"gp")).bytes).tempo,120);
    }
    for (const target of ["gp","musicxml","xml","mxl"] as const) {
      const bytes = target === "gp" ? song.bytes : (await convert(input,source,target,options)).bytes;
      assert.equal(load(bytes).tempo,89);
      const output = path.join(dir,`${source}.${target}`);
      await writeFile(output,bytes);
      const check = Bun.spawn(["bun","scripts/verify-song-gp.ts",timelinePath,output],{stdout:"pipe",stderr:"pipe"});
      const [out,error] = await Promise.all([new Response(check.stdout).text(),new Response(check.stderr).text()]);
      assert.equal(await check.exited,0,`${source} → ${target}: ${out}\n${error}`);
    }
    for (const target of ["gp5","musicxml","pdf"] as const) {
      const selected = await convert(input,source,target,{...options,tracks:"1"});
      if (target !== "pdf") assert.equal(load(selected.bytes).tracks.length,1);
      else assert.equal(new TextDecoder().decode(selected.bytes.slice(0,4)),"%PDF");
    }
    const overridden = load((await convert(input,source,"gp",{jsonTempo:"103",jsonMiddleC:"72"})).bytes);
    assert.equal(overridden.tempo,103);
    const firstPitch = (s: alphaTab.model.Score) => s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue;
    assert.equal(firstPitch(overridden),source.endsWith(".gp.json") ? firstPitch(parsed) : firstPitch(parsed)+12);
    if (source === "lyrics-song.json") {
      await assert.rejects(convert(input,source,"gp",{jsonMiddleC:"61"}),/八度基准/);
    } else {
      const crowded = JSON.parse(new TextDecoder().decode(input));
      crowded[0][0].chord.tracks[0].midi_notes = Array.from({length:9},(_,i)=>({note:60+i,start_tick:0,end_tick:480}));
      await assert.rejects(convert(new TextEncoder().encode(JSON.stringify(crowded)),source,"gp"),/无法无损导出 GP/);
    }
    passed(`${source} 音轨、BPM/八度、段落、歌词和弦、跨小节/重叠音符回读及选轨导出`);
  }
  for (const target of ["gp","gp5","json","atex","musicxml","pdf"] as const) {
    const {bytes} = await convert(fixture,"bridge.musicxml",target,{tracks:"1",staffMode:"tab"});
    if (["gp","gp5","musicxml"].includes(target)) assert.equal(load(bytes).tracks.length,1);
    passed(`MusicXML 直接解析、选轨 → ${target}`);
  }
  for (const target of ["pdf","mid","mscz"] as const) {
    const calls: string[] = [];
    const result = await convertScore(compressed,"mxl",target,"selected",{tracks:[1],staffMode:"tab",mergeLyrics:true},async (data,request) => {
      calls.push(request.target);
      return (native ? nativeRender : render)(data,request);
    });
    assert.deepEqual(calls,[target]);
    if (target === "pdf") assert.equal(new TextDecoder().decode(result.data.slice(0,4)),"%PDF");
    else if (target === "mid") assert.equal(new TextDecoder().decode(result.data.slice(0,4)),"MThd");
    else assert((await JSZip.loadAsync(result.data)).file(/\.mscx$/).length > 0);
    passed(`MXL 选轨 → ${target} 仅调用一次 MuseScore`);
  }
  const midiXml = await convert(outputs.get("mid")!,"score.mid","musicxml",{tracks:"1",staffMode:"tab"});
  assert.equal(load(midiXml.bytes).tracks.length,1);
  passed("MIDI 桥接与选轨");

  const pages = await convert(fixture,"多页.musicxml","png",{dpi:"50"});
  assert.equal(pages.filename,"多页.zip");
  const zip = await JSZip.loadAsync(pages.bytes);
  const entries = zip.file(/\.png$/);
  assert(entries.length >= 2);
  assert(entries.every(p => p.name.startsWith("多页-")));
  const decoded = await Promise.all(entries.map(async p => PNG.sync.read(await p.async("nodebuffer"))));
  const long = await convert(fixture,"多页.musicxml","png-long",{dpi:"50"});
  const image = PNG.sync.read(Buffer.from(long.bytes));
  assert.equal(image.height,decoded.reduce((n,p)=>n+p.height,0));
  assert.equal(image.width,Math.max(...decoded.map(p=>p.width)));
  assert(image.data.every((v,i)=>i%4!==3 || v===255));
  passed("PNG 多页 ZIP、中文文件名、长图尺寸与不透明白底");

  // GP5 双解析器：alphaTab 回读音高，再由 MuseScore 导回 MusicXML 比对。
  const gp5 = outputs.get("gp5")!;
  const readback = load(gp5);
  assert.deepEqual(pitches(readback),pitches(load(gp)));
  const xml = await (native ? nativeRender : render)(gp5,{inputExt:"gp5",target:"musicxml"});
  assert.deepEqual(pitches(load(xml)),pitches(readback));
  const directGp5 = await convertScore(fixture,"musicxml","gp5","direct",{},noMuseScore);
  assert.deepEqual(pitches(load(directGp5.data)),pitches(score));
  const directXml = await (native ? nativeRender : render)(directGp5.data,{inputExt:"gp5",target:"musicxml"});
  assert.deepEqual(pitches(load(directXml)),pitches(score));
  await writeFile(path.join(dir,"readback.gp5"),gp5);
  passed("GP / MusicXML → GP5 alphaTab + MuseScore 双解析器音高回读");

  const bad = new FormData();bad.set("file",new File(["bad"],"bad.gp"));bad.set("target","gp5");
  assert.equal((await fetch(`${url}/api/convert`,{method:"POST",body:bad})).status,500);
  bad.set("target","gpx");
  assert.equal((await fetch(`${url}/api/convert`,{method:"POST",body:bad})).status,400);
  passed("损坏输入与禁止旧格式输出");
  console.log(`完成 ${checks} 组真实转换校验。`);
} finally {
  server.stop(true);
  await rm(dir,{recursive:true,force:true});
}
