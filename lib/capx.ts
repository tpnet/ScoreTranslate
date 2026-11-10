import JSZip from "jszip";
import type { model } from "@coderline/alphatab";
import { SaxesParser } from "saxes";

// 128 分音符的三附点和常见连音（2–10、12、14、15）都能用整数表示。
const DIVISIONS = 26880;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_BARS = 5000;
const TYPES = ["breve", "whole", "half", "quarter", "eighth", "16th", "32nd", "64th", "128th"];
const PITCHES = "C.D.EF.G.A.B";

type Element = { name: string; attrs: Record<string, string>; children: Element[]; text: string };
type Meter = { beats: number; beatType: number; length: number };
type Drums = { id: string; keys: Set<number> };
type Bar = {
  meter: Meter;
  elapsed: number;
  notes: string[];
  key?: number;
  clef?: string;
  left?: string;
  right?: string;
  explicit?: boolean;
};

function fail(reason: string): never {
  throw new Error(`转换失败：Capella CAPX ${reason}`);
}

const child = (node: Element | undefined, name: string) => node?.children.find(e => e.name === name);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const enabled = (value?: string) => value === "true" || value === "1";

async function readScore(input: Uint8Array): Promise<Element> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(input); }
  catch { fail("不是有效的 ZIP 文件"); }
  const file = zip.file("score.xml");
  if (!file || (file.unsafeOriginalName && file.unsafeOriginalName !== "score.xml")) fail("缺少 score.xml");

  // JSZip 在浏览器中提供 internalStream，但其文件对象类型声明遗漏了该方法。
  const entry = file as typeof file & { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> };
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const stream = entry.internalStream("uint8array");
    stream.on("data", chunk => {
      length += chunk.length;
      if (length > MAX_XML_BYTES) {
        stream.pause();
        reject(new Error("转换失败：Capella CAPX 的 score.xml 解压后超过 16 MB"));
      } else {
        chunks.push(chunk);
      }
    }).on("error", () => reject(new Error("转换失败：无法解压 Capella CAPX 的 score.xml"))).on("end", () => {
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(data);
    }).resume();
  });
  const declaration = new TextDecoder().decode(bytes.subarray(0, 256));
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
    : declaration.match(/^<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? "utf-8";
  let root: Element | undefined;
  const stack: Element[] = [];
  let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => fail("的 score.xml 格式有误"));
  parser.on("doctype", () => fail("的 score.xml 含有不支持的 DOCTYPE"));
  parser.on("opentag", tag => {
    if (++count > 200_000 || stack.length >= 64) fail("的 score.xml 结构过大");
    if (!root && (tag.local !== "score" || !/^https?:\/\/(?:www\.)?capella\.de\/CapXML\/\d+(?:\.\d+)*$/.test(tag.uri)))
      fail("的 score.xml 不是 CapXML 乐谱");
    if (tag.local === "volta") fail("含有暂不支持的反复跳房子记号");
    const element: Element = {
      name: tag.local,
      attrs: Object.fromEntries(Object.values(tag.attributes).map(a => [a.name, a.value])),
      children: [],
      text: "",
    };
    stack.at(-1)?.children.push(element);
    stack.push(element);
    root ??= element;
  });
  parser.on("closetag", () => { stack.pop(); });
  const appendText = (text: string) => {
    const current = stack.at(-1);
    if (current) current.text += text;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  let xml: string;
  try { xml = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { fail("的 score.xml 编码有误"); }
  parser.write(xml).close();
  if (!root) fail("的 score.xml 为空");
  return root;
}

function meter(value: string | undefined): Meter {
  const time = value === "C" ? "4/4" : value === "allaBreve" ? "2/2" : value === "longAllaBreve" ? "4/2" : value;
  const match = /^(\d{1,3})\/(1|2|4|8|16|32|64|128)$/.exec(time ?? "");
  if (!match || +match[1] < 1 || +match[1] > 128) fail(`含有不支持的拍号 ${value ?? ""}`);
  const [, beats, beatType] = match.map(Number);
  return { beats, beatType, length: beats * 4 * DIVISIONS / beatType };
}

function clef(value: string | undefined): string {
  const conventional: Record<string, string> = { treble: "G2", bass: "F4", alto: "C3", tenor: "C4" };
  const match = /^([GCFPNU])([1-5])([-0+]?)$/.exec(conventional[value ?? ""] ?? value ?? "");
  if (!match) fail("含有不支持的谱号");
  const [, sign, line, octave] = match;
  const name = sign === "P" ? "percussion" : /[NU]/.test(sign) ? "none" : sign;
  return `<clef><sign>${name}</sign><line>${line}</line>${octave === "+" || octave === "-" ? `<clef-octave-change>${octave === "+" ? 1 : -1}</clef-octave-change>` : ""}</clef>`;
}

function tempo(value: string | undefined): string {
  const first = Number(value?.trim().split(/\s+/)[0] ?? 0);
  if (!Number.isFinite(first) || first < 0 || first > 720) fail("含有无效的速度");
  return first ? `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${first}</per-minute></metronome></direction-type><sound tempo="${first}"/></direction>` : "";
}

function noteXml(item: Element, voice: number, duration: number, rhythm: string, grace: boolean, drums?: Drums): string {
  const length = grace ? "" : `<duration>${duration}</duration>`;
  const timing = `<voice>${voice}</voice>${rhythm}`;
  if (item.name === "rest") return `<note><rest/>${length}${timing}</note>`;
  const heads = child(item, "heads")?.children.filter(e => e.name === "head");
  if (!heads?.length) fail("有和弦缺少音符");
  const lyrics = child(item, "lyric")?.children.filter(e => e.name === "verse" && e.text.trim()).map(e => {
    const number = Number(e.attrs.i ?? 0) + 1;
    if (!Number.isSafeInteger(number) || number < 1) fail("含有无效的歌词行号");
    const syllabic = enabled(e.attrs.hyphen) ? "<syllabic>begin</syllabic>" : "";
    const extend = enabled(e.attrs.extender) ? "<extend/>" : "";
    return `<lyric number="${number}">${syllabic}<text>${esc(e.text)}</text>${extend}</lyric>`;
  }).join("") ?? "";
  return heads.map((head, i) => {
    const pitch = /^([A-G])(\d)$/.exec(head.attrs.pitch);
    const alter = Number(child(head, "alter")?.attrs.step ?? 0);
    if (!pitch || !Number.isInteger(alter) || Math.abs(alter) > 2 || enabled(head.attrs.silent))
      fail("含有不支持的音高或静音音符");
    const [, step, capOctave] = pitch;
    const midi = +capOctave * 12 + PITCHES.indexOf(step) + alter;
    if (midi < 12 || midi > 127) fail("音高超出可转换范围");
    const octave = +capOctave - 1;
    const written = drums
      ? `<unpitched><display-step>${step}</display-step><display-octave>${octave}</display-octave></unpitched>`
      : `<pitch><step>${step}</step><alter>${alter}</alter><octave>${octave}</octave></pitch>`;
    if (drums) drums.keys.add(midi);
    const instrument = drums ? `<instrument id="${drums.id}-D${midi}"/>` : "";
    const tie = child(head, "tie")?.attrs;
    const ties = [enabled(tie?.end) ? "stop" : "", enabled(tie?.begin) ? "start" : ""].filter(Boolean);
    const soundTies = ties.map(type => `<tie type="${type}"/>`).join("");
    const notation = ties.length ? `<notations>${ties.map(type => `<tied type="${type}"/>`).join("")}</notations>` : "";
    return `<note>${grace ? "<grace/>" : ""}${i ? "<chord/>" : ""}${written}${length}${soundTies}${instrument}${timing}${notation}${i ? "" : lyrics}</note>`;
  }).join("");
}

function tupletNormal(actual: number, tripartite: boolean, prolong: boolean): number {
  const group = tripartite ? 3 : 1;
  const power = Math.log2(actual / group);
  return group * 2 ** (prolong ? Math.floor(power) + 1 : Math.ceil(power) - 1);
}

function readVoice(objects: Element[], voice: number, initial: Meter, reference: Bar[], drums?: Drums): Bar[] {
  const bars: Bar[] = [];
  let bar: Bar = { meter: initial, elapsed: 0, notes: [] };
  const next = (time = bar.meter) => {
    if (bars.length >= MAX_BARS) fail("超过 5000 小节限制");
    bars.push(bar);
    bar = { meter: reference[bars.length]?.meter ?? time, elapsed: 0, notes: [] };
  };
  const limit = () => reference[bars.length]?.elapsed || bar.meter.length;
  for (const item of objects) {
    if (item.name === "barline") {
      const type = item.attrs.type ?? "single";
      if (type === "repBegin" || type === "repEndBegin") {
        if (bar.elapsed && type === "repBegin") next();
        if (type === "repBegin") { bar.left = '<barline location="left"><repeat direction="forward"/></barline>'; continue; }
      }
      if (type === "repEnd" || type === "repEndBegin") bar.right = '<barline location="right"><repeat direction="backward"/></barline>';
      else {
        const style = ({ single: "regular", double: "light-light", end: "light-heavy", dashed: "dashed" } as Record<string, string>)[type];
        if (!style) fail("含有不支持的小节线");
        bar.right = `<barline location="right"><bar-style>${style}</bar-style></barline>`;
      }
      bar.explicit = true;
      if (bar.elapsed) next();
      if (type === "repEndBegin") bar.left = '<barline location="left"><repeat direction="forward"/></barline>';
      continue;
    }
    if (bar.elapsed === limit()) next();
    if (item.name === "timeSign") {
      if (bar.elapsed) next();
      bar.meter = meter(item.attrs.time);
      continue;
    }
    if (item.name === "keySign" || item.name === "clefSign") {
      const key = Number(item.attrs.fifths);
      if (item.name === "keySign" && (!Number.isInteger(key) || Math.abs(key) > 7)) fail("含有无效的调号");
      const value = item.name === "keySign" ? `<key><fifths>${key}</fifths></key>` : clef(item.attrs.clef);
      if (bar.elapsed || bar.notes.length) bar.notes.push(`<attributes>${value}</attributes>`);
      else if (item.name === "keySign") bar.key = key;
      else bar.clef = value;
      continue;
    }
    if (item.name !== "chord" && item.name !== "rest") fail(`含有不支持的记谱对象 ${item.name}`);
    const spec = child(item, "duration");
    const base = spec?.attrs.base ?? "";
    const dots = Number(spec?.attrs.dots ?? 0);
    if (!Number.isInteger(dots) || dots < 0 || dots > 3) fail("含有无效的附点时值");
    const full = /^\d+$/.test(base) && item.name === "rest" ? +base : 0;
    if (full) {
      if (full > MAX_BARS || bar.elapsed || dots || child(spec, "tuplet") || enabled(spec?.attrs.noDuration))
        fail("含有无效的整小节休止符");
      for (let i = 0; i < full; i++) {
        if (i) next();
        bar.elapsed = limit();
        if (i === 0 && voice === 1) bar.notes.push(tempo(item.attrs.tempo));
        bar.notes.push(`<note><rest measure="yes"/><duration>${bar.elapsed}</duration><voice>${voice}</voice></note>`);
      }
      continue;
    }
    const type = base === "2/1" ? 0 : TYPES.findIndex((_, i) => base === `1/${2 ** (i - 1)}`);
    if (type < 0) fail("含有无效的音符时值");
    const tuplet = child(spec, "tuplet");
    const actual = Number(tuplet?.attrs.count ?? 1);
    if (tuplet && (!Number.isInteger(actual) || actual < 2 || actual > 15)) fail("含有无效的连音");
    const normal = tuplet ? tupletNormal(actual, enabled(tuplet.attrs.tripartite), enabled(tuplet.attrs.prolong)) : 1;
    const duration = (8 * DIVISIONS / 2 ** type) * (2 - 2 ** -dots) * normal / actual;
    const grace = enabled(spec?.attrs.noDuration);
    if (!Number.isInteger(duration) || !Number.isInteger(normal) || normal < 1 ||
      (grace && (item.name !== "chord" || enabled(child(item, "display")?.attrs.postGrace))) ||
      (!grace && bar.elapsed + duration > limit()))
      fail("含有不支持的连音、跨小节时值或声部对齐");
    const rhythm = `<type>${TYPES[type]}</type>${"<dot/>".repeat(dots)}${tuplet ? `<time-modification><actual-notes>${actual}</actual-notes><normal-notes>${normal}</normal-notes></time-modification>` : ""}`;
    if (voice === 1) bar.notes.push(tempo(item.attrs.tempo));
    bar.notes.push(noteXml(item, voice, duration, rhythm, grace, drums));
    if (!grace) bar.elapsed += duration;
  }
  if (bar.elapsed || bar.notes.some(Boolean)) next();
  return bars;
}

export async function capxToMusicXml(input: Uint8Array, title: string): Promise<Uint8Array> {
  const score = await readScore(input);
  const layouts = child(child(score, "layout"), "staves")?.children.filter(e => e.name === "staffLayout") ?? [];
  const systems = child(score, "systems")?.children.filter(e => e.name === "system") ?? [];
  if (!layouts.length || !systems.length || layouts.length > 64) fail("缺少有效的谱表或谱行");
  const tracks = new Map(layouts.map((layout, index) => {
    const description = layout.attrs.description;
    const id = `P${index + 1}`;
    const instrument = child(layout, "instrument");
    const sound = child(layout, "sound");
    const program = Number(sound?.attrs.instr ?? 0);
    if (description === undefined || !Number.isInteger(program) || program < 0 || program > 127) fail("含有无效的谱表设置");
    if (Number(sound?.attrs.transpose ?? 0) !== 0 || child(sound, "outputAssignment"))
      fail("含有不支持的移调或自定义音高映射");
    const drums = enabled(sound?.attrs.percussion) ? { id, keys: new Set<number>() } : undefined;
    return [description, { id, name: child(instrument, "name")?.text.trim() || instrument?.attrs.name || description || `音轨 ${index + 1}`, program, layout, drums, bars: [] as string[] }];
  }));
  if (tracks.size !== layouts.length) fail("有重复的谱表定义");
  let measureNo = 0;
  for (const system of systems) {
    const staves = child(system, "staves")?.children.filter(e => e.name === "staff") ?? [];
    const voices = new Map<string, Bar[][]>();
    let reference: Bar[] = [];
    for (const staff of staves) {
      const id = staff.attrs.layout;
      const track = tracks.get(id);
      if (!track || voices.has(id)) fail("有未知或重复的谱表引用");
      const initial = meter(staff.attrs.defaultTime);
      const staffVoices = child(staff, "voices")?.children.filter(e => e.name === "voice") ?? [];
      if (staffVoices.length > 6) fail("单谱表声部数超过 6");
      const parsed = staffVoices.map((v, i) => {
        const bars = readVoice(child(v, "noteObjects")?.children ?? [], i + 1, initial, reference, track.drums);
        if (!reference.length && bars.length) reference = bars;
        return bars;
      });
      voices.set(id, parsed);
    }
    if (measureNo + reference.length > MAX_BARS || (measureNo + reference.length) * tracks.size > 30_000)
      fail("乐谱小节数超过限制");
    for (const [id, track] of tracks) {
      const staffVoices = voices.get(id) ?? [];
      if (staffVoices.some(v => v.length > reference.length)) fail("声部的小节数无法对齐");
      for (const [i, master] of reference.entries()) {
        const bars = staffVoices.map(v => v[i]).filter((bar): bar is Bar => !!bar);
        const length = master.elapsed || master.meter.length;
        if (bars.some(b => b.elapsed > length || (b.explicit && b.elapsed !== length) ||
          b.meter.beats !== master.meter.beats || b.meter.beatType !== master.meter.beatType))
          fail("含有无法对齐的声部或混合拍号");
        if (i < reference.length - 1 && length !== master.meter.length && !master.explicit)
          fail("含有未标记的不完整小节");
        const key = bars.find(b => b.key !== undefined)?.key;
        const startClef = track.drums && measureNo + i === 0 ? clef("P3") : bars.find(b => b.clef)?.clef
          ?? (measureNo + i === 0 ? clef(child(track.layout, "notation")?.attrs.defaultClef ?? "treble") : "");
        const signature = `<time><beats>${master.meter.beats}</beats><beat-type>${master.meter.beatType}</beat-type></time>`;
        const attrs = `<attributes><divisions>${DIVISIONS}</divisions>${key === undefined ? "" : `<key><fifths>${key}</fifths></key>`}${signature}${startClef}</attributes>`;
        const body = bars.length ? bars.map((b, j) =>
          `${j && bars[j - 1].elapsed ? `<backup><duration>${bars[j - 1].elapsed}</duration></backup>` : ""}${b.notes.join("")}`).join("")
          : `<note><rest measure="yes"/><duration>${length}</duration><voice>1</voice></note>`;
        track.bars.push(`<measure number="${measureNo + i + 1}"${length !== master.meter.length ? ' implicit="yes"' : ""}>${attrs}${master.left ?? ""}${i === 0 ? tempo(system.attrs.tempo ?? (measureNo === 0 ? "120" : undefined)) : ""}${body}${master.right ?? ""}</measure>`);
      }
    }
    measureNo += reference.length;
  }
  if (!measureNo) fail("没有可导出的音符或休止符");
  const parts = [...tracks.values()];
  const author = child(child(score, "info"), "author")?.text.trim();
  const partList = parts.map(({ id, name, program, drums }, i) => {
    const instruments = drums?.keys.size ? [...drums.keys].map(key => ({ id: `${id}-D${key}`, key })) : [{ id: `${id}-I`, key: undefined }];
    const names = instruments.map(inst => `<score-instrument id="${inst.id}"><instrument-name>${esc(name)}</instrument-name></score-instrument>`).join("");
    const channel = drums ? 10 : (i % 15 < 9 ? i % 15 + 1 : i % 15 + 2);
    const midi = instruments.map(inst => `<midi-instrument id="${inst.id}"><midi-channel>${channel}</midi-channel><midi-program>${program + 1}</midi-program>${inst.key === undefined ? "" : `<midi-unpitched>${inst.key + 1}</midi-unpitched>`}</midi-instrument>`).join("");
    return `<score-part id="${id}"><part-name>${esc(name)}</part-name>${names}${midi}</score-part>`;
  }).join("");
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work>${author ? `<identification><creator type="composer">${esc(author)}</creator></identification>` : ""}<part-list>${partList}</part-list>${parts.map(p => `<part id="${p.id}">${p.bars.join("")}</part>`).join("")}</score-partwise>`);
}

const CAPX_CLEFS = ["N3", "alto", "tenor", "bass", "treble"];
const CAPX_STEPS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const CAPX_FLAT_STEPS = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
const SCORE_LAYOUT = '<pages left="15" top="15" right="15" bottom="15"/><distances><staffLines small="1.4" normal="1.8"/><systems top="8" between="8"/></distances>';

// 旧 GP 的默认打击乐技法编号不一定等于播放用 MIDI 键，取 alphaTab PercussionMapper 中有差异的条目。
const DEFAULT_DRUM_KEYS: Record<number, number> = {
  29: 59, 30: 49, 31: 40, 33: 37, 34: 38, 83: 53, 84: 53, 91: 38, 92: 46, 93: 51, 94: 51, 95: 55,
  96: 52, 97: 49, 98: 57, 99: 56, 100: 56, 101: 56, 102: 56, 103: 56, 104: 60, 105: 60, 106: 61,
  107: 61, 108: 64, 109: 64, 110: 63, 111: 54, 112: 54, 113: 54, 114: 43, 115: 49, 116: 49, 117: 69,
  118: 70, 119: 70, 120: 70, 122: 82, 123: 53, 124: 62, 125: 62, 126: 59, 127: 59,
};

function capxHead(note: model.Note, useFlats: boolean, percussion: boolean): string {
  const staff = note.beat.voice.bar.staff;
  if (note.isPercussion !== percussion) fail("导出遇到混用有音高音符和鼓件的谱表");
  const articulation = note.percussionArticulation;
  const midi = percussion
    ? staff.track.percussionArticulations[articulation]?.outputMidiNumber ?? DEFAULT_DRUM_KEYS[articulation] ?? articulation
    : note.realValue;
  if (!Number.isInteger(midi) || midi < 12 || midi >= 120) fail("导出遇到超出可表示范围的音高");
  const pc = midi % 12;
  const step = (useFlats ? CAPX_FLAT_STEPS : CAPX_STEPS)[pc];
  const alter = pc - PITCHES.indexOf(step);
  const tie = note.isTieOrigin || note.isTieDestination
    ? `<tie begin="${note.isTieOrigin}" end="${note.isTieDestination}"/>` : "";
  return `<head pitch="${step}${Math.floor(midi / 12)}">${alter ? `<alter step="${alter}"/>` : ""}${tie}</head>`;
}

function capxBeat(beat: model.Beat, barLength: number, useFlats: boolean, percussion: boolean, bpm?: number) {
  const tempo = bpm === undefined ? "" : ` tempo="${bpm}"`;
  if (beat.isFullBarRest) return { ticks: barLength, xml: `<rest${tempo}><duration base="1"/></rest>` };
  const duration = beat.duration;
  if (duration !== -2 && ![1, 2, 4, 8, 16, 32, 64, 128].includes(duration)) fail("导出遇到无法表示的音符时值");
  const dots = beat.dots;
  if (!Number.isInteger(dots) || dots < 0 || dots > 3) fail("导出遇到无法表示的附点");
  let tuplet = "";
  let actual = 1;
  let normal = 1;
  if (beat.hasTuplet) {
    actual = beat.tupletNumerator;
    normal = beat.tupletDenominator;
    if (!Number.isInteger(actual) || actual < 2 || actual > 15) fail("导出遇到无法表示的连音");
    const flags = [[false, false], [true, false], [false, true], [true, true]]
      .find(([tripartite, prolong]) => tupletNormal(actual, tripartite, prolong) === normal);
    if (!flags || !Number.isInteger(normal)) fail("导出遇到无法表示的连音比例");
    tuplet = `<tuplet count="${actual}" tripartite="${flags[0]}" prolong="${flags[1]}"/>`;
  }
  const ticks = (duration === -2 ? 8 * DIVISIONS : 4 * DIVISIONS / duration) * (2 - 2 ** -dots) * normal / actual;
  const grace = beat.graceType !== 0;
  if (!Number.isInteger(ticks) || (grace && beat.isRest)) fail("导出遇到无法表示的连音或装饰音");
  const length = `<duration base="${duration === -2 ? "2/1" : `1/${duration}`}" dots="${dots}"${grace ? ' noDuration="true"' : ""}>${tuplet}</duration>`;
  if (beat.isRest) return { ticks, xml: `<rest${tempo}>${length}</rest>` };
  if (!beat.notes.length || beat.notes.length > 15) fail("导出遇到没有音符或超过 15 个音的和弦");
  const verses = beat.lyrics?.map((text, i) => text ? `<verse i="${i}">${esc(text)}</verse>` : "").join("") ?? "";
  const heads = beat.notes.map(n => capxHead(n, useFlats, percussion)).join("");
  return { ticks: grace ? 0 : ticks, xml: `<chord${tempo}>${length}${verses ? `<lyric>${verses}</lyric>` : ""}<heads>${heads}</heads></chord>` };
}

function capxPadding(ticks: number): string {
  let xml = "";
  for (let divisor = 1; divisor <= 128; divisor *= 2) {
    const length = 4 * DIVISIONS / divisor;
    const count = Math.floor(ticks / length);
    xml += `<rest><duration base="1/${divisor}"/><display invisible="true" filler="true"/></rest>`.repeat(count);
    ticks -= count * length;
  }
  if (ticks) fail("导出遇到无法对齐的小节或声部");
  return xml;
}

export async function exportCapx(score: model.Score, barLengths: readonly number[]): Promise<Uint8Array> {
  const parts = score.tracks.flatMap(track => track.staves.filter(staff => staff.bars.length).map((staff, i) => ({
    staff,
    name: track.staves.length > 1 ? `${track.name} (${i + 1})` : track.name,
    program: track.playbackInfo.program,
  }))).map((part, i) => {
    const indexes = new Set<number>();
    let percussion = part.staff.isPercussion;
    for (const bar of part.staff.bars) for (const [index, voice] of bar.voices.entries()) {
      if (!voice.isEmpty) indexes.add(index);
      percussion ||= voice.beats.some(beat => beat.notes.some(note => note.isPercussion));
    }
    if (indexes.size > 6) fail("导出单谱表最多支持 6 个声部");
    return { ...part, id: `P${i + 1}`, percussion, voices: indexes.size ? [...indexes].sort((a, b) => a - b) : [0] };
  });
  if (!parts.length || !score.masterBars.length || parts.length > 64 || score.masterBars.length > MAX_BARS ||
      parts.length * score.masterBars.length > 30_000) fail("导出的乐谱没有有效谱表或小节数超过限制");
  if (score.masterBars.some(b => b.alternateEndings || b.isFreeTime || b.repeatCount > 2))
    fail("导出暂不支持反复跳房子、自由拍或多于两遍的反复");

  const layouts = parts.map(({ staff, program, id, name, percussion }) => {
    if (!Number.isInteger(program) || program < 0 || program > 127) fail("导出遇到无效的音色编号");
    const clef = percussion ? "P3" : CAPX_CLEFS[staff.bars[0].clef] ?? "treble";
    const label = esc(name || id).replace(/"/g, "&quot;");
    return `<staffLayout description="${id}"><notation defaultClef="${clef}"><barlines mode="internal" from="0" to="4"/></notation><distances top="0" bottom="0"/><instrument name="${label}" abbrev=""><name>${label}</name><abbrev/></instrument><sound instr="${program}" volume="100"${percussion ? ' percussion="true" preferredChannel="10"' : ""}/></staffLayout>`;
  }).join("");

  // Capella 按 system 换行。每行最多四小节，防止整份谱挤在一行。
  const systems: string[] = [];
  for (let start = 0; start < score.masterBars.length; start += 4) {
    const masterBars = score.masterBars.slice(start, start + 4);
    const first = masterBars[0];
    const firstTempo = first.tempoAutomations.findLast(a => a.ratioPosition === 0)?.value ?? (start === 0 ? score.tempo : undefined);
    const systemTempo = firstTempo && firstTempo >= 10 && firstTempo <= 720 ? ` tempo="${firstTempo}"` : "";
    const defaultTime = `${first.timeSignatureNumerator}/${first.timeSignatureDenominator}`;
    const staves = parts.map(({ staff, id, voices, percussion }) => {
      const voiceXml = voices.map(voice => {
        const measures = masterBars.map((mb, offset) => {
          const bar = staff.bars[mb.index];
          const time = `${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`;
          const nominal = meter(time).length;
          const length = barLengths[mb.index] * (DIVISIONS / 960);
          if (!Number.isInteger(length) || length <= 0 || length > nominal) fail("导出遇到无法对齐的小节");
          const clef = percussion ? "P3" : CAPX_CLEFS[bar?.clef ?? 4] ?? "treble";
          const key = bar?.keySignature ?? 0;
          if (!Number.isInteger(key) || Math.abs(key) > 7) fail("导出遇到无效的调号");
          const beats = bar?.voices[voice]?.beats.filter(b => !b.isEmpty) ?? [];
          const tempoChanges = new Map(mb.tempoAutomations.map(a => [Math.round(a.ratioPosition * length), a.value]));
          if (offset === 0 && systemTempo) tempoChanges.delete(0);
          let xml = `<clefSign clef="${clef}"/><keySign fifths="${key}"/>${offset === 0 || time !== `${masterBars[offset - 1].timeSignatureNumerator}/${masterBars[offset - 1].timeSignatureDenominator}` ? `<timeSign time="${time}"/>` : ""}`;
          if (mb.isRepeatStart) xml += '<barline type="repBegin"/>';
          let elapsed = 0;
          if (!beats.length && length === nominal) {
            const bpm = tempoChanges.get(0);
            xml += `<rest${bpm && bpm >= 10 && bpm <= 720 ? ` tempo="${bpm}"` : ""}><duration base="1"/></rest>`;
          }
          else {
            for (const beat of beats) {
              const bpm = tempoChanges.get(elapsed);
              const event = capxBeat(beat, nominal, key < 0, percussion, bpm && bpm >= 10 && bpm <= 720 ? bpm : undefined);
              xml += event.xml;
              elapsed += event.ticks;
            }
            if (elapsed > length) fail("导出遇到跨小节音符或声部超出小节");
            xml += capxPadding(length - elapsed);
          }
          const barline = mb.isRepeatEnd ? "repEnd" : mb.index === score.masterBars.length - 1 ? "end" : mb.isDoubleBar ? "double" : "single";
          return xml + `<barline type="${barline}"/>`;
        }).join("");
        return `<voice><lyricsSettings firstLine="6" lineDist="2"><font face="Arial" height="10"/></lyricsSettings><noteObjects>${measures}</noteObjects></voice>`;
      }).join("");
      return `<staff layout="${id}" defaultTime="${defaultTime}"><voices>${voiceXml}</voices></staff>`;
    }).join("");
    systems.push(`<system instrNotation="long"${systemTempo}><staves>${staves}</staves></system>`);
  }
  const author = esc(score.artist || score.music || "");
  const zip = new JSZip();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score xmlns="http://www.capella.de/CapXML/5.3"><info><encodingSoftware>ScoreTranslate</encodingSoftware><author>${author}</author></info><layout>${SCORE_LAYOUT}<staves>${layouts}</staves></layout><systems>${systems.join("")}</systems></score>`;
  if (new TextEncoder().encode(xml).length > MAX_XML_BYTES) fail("导出的 score.xml 超过 16 MB");
  zip.file("score.xml", xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
