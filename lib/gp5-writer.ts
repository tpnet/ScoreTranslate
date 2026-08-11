/**
 * GP5 (Guitar Pro 5, "FICHIER GUITAR PRO v5.00") 二进制写出器。
 *
 * 字节布局逐字段镜像 alphaTab 的 Gp3To5Importer（node_modules/@coderline/alphatab
 * dist 源码中 readScore 的 v5.00 分支）——写出顺序必须与其读取顺序严格一致，
 * 任何一个字节的偏差都会让整个文件后续错位。修改前先对照该解析器。
 *
 * 支持：多轨、音符/休止符、时值/附点/连音、延音线、力度、拍号/调号、
 * 反复记号、小节标记、调弦/变调夹，以及 GP5 能表达的全部演奏效果
 * （见 beatEffectFlags / noteEffectFlags 附近的注释）。不写出和弦图。
 */
import type * as alphaTab from "@coderline/alphatab";

type Score = alphaTab.model.Score;
type Track = alphaTab.model.Track;
type Staff = alphaTab.model.Staff;
type Bar = alphaTab.model.Bar;
type Beat = alphaTab.model.Beat;
type Note = alphaTab.model.Note;
type BendPoint = alphaTab.model.BendPoint;

// alphaTab 的枚举在此只做类型导入，运行时取不到枚举对象，因此按值内联
const FADE_IN = 1;
const VIBRATO_NONE = 0;
const BRUSH_NONE = 0;
const BRUSH_UP = 1; // BrushUp=1 / ArpeggioUp=3 都算向上
const ARPEGGIO_UP = 3;
const RASGUEADO_NONE = 0;
const PICK_STROKE_NONE = 0;
const PICK_STROKE_UP = 1;
const ACCENT_NORMAL = 1;
const ACCENT_HEAVY = 2;
const FINGER_UNKNOWN = -2;
const GRACE_NONE = 0;
const GRACE_ON_BEAT = 1;
const SLIDE_OUT = { none: 0, shift: 1, legato: 2, outUp: 3, outDown: 4 };
const SLIDE_IN = { none: 0, fromBelow: 1, fromAbove: 2 };
const HARMONIC = { none: 0, natural: 1, artificial: 2, pinch: 3, tap: 4, semi: 5 };

const MAX_FRET = 29;

// 调音自高音弦到低音弦，值为 GP 存储的 MIDI 音高（标准吉他 E4..E2）
const TUNING_GUITAR = [64, 59, 55, 50, 45, 40];
const TUNING_GUITAR7 = [64, 59, 55, 50, 45, 40, 35];
const TUNING_BASS = [43, 38, 33, 28];

class ByteWriter {
  private chunks: number[] = [];

  u8(v: number) {
    this.chunks.push(v & 0xff);
  }
  i8(v: number) {
    this.u8(v < 0 ? v + 256 : v);
  }
  i16(v: number) {
    if (v < 0) v += 0x10000;
    this.u8(v);
    this.u8(v >> 8);
  }
  i32(v: number) {
    if (v < 0) v += 0x100000000;
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
    this.u8(v >> 24);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  chars(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  /** int32(len+1) + byte(len) + 字符，GP 的 "IntByte" 字符串 */
  stringIntByte(s: string) {
    const t = ascii(s);
    this.i32(t.length + 1);
    this.u8(t.length);
    this.chars(t);
  }
  /** byte(len) + 定长 n 字节缓冲区（不足补零） */
  stringByteLength(s: string, n: number) {
    const t = ascii(s).slice(0, n);
    this.u8(t.length);
    this.chars(t);
    this.zeros(n - t.length);
  }
  color(r: number, g: number, b: number) {
    this.u8(r);
    this.u8(g);
    this.u8(b);
    this.u8(0);
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

// GP5 传统上用 cp1252 编码，非 ASCII 字符在各家实现间无一致解码方式，统一降级为 '?'
// （alphaTab 的 MusicXML 导入会把空格转成 U+00A0，先归一化再降级）
function ascii(s: string, max = 250): string {
  return (s ?? "")
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);
}

/** alphaTab Duration 枚举值（1=全音符…64=64分）→ GP5 时值字节（-2..4） */
function gpDuration(d: number): number {
  const map: Record<number, number> = { 1: -2, 2: -1, 4: 0, 8: 1, 16: 2, 32: 3, 64: 4 };
  if (d in map) return map[d];
  return d > 64 ? 4 : -2;
}

const VALID_TUPLETS = new Set([2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13]);

interface Fingering {
  string: number; // alphaTab 弦号：1 = 最低音弦
  fret: number;
}

/**
 * 为整个 staff 选定调音：已有调弦（GP 来源）直接沿用；
 * 否则按音色与音域推断（这类输入通常来自 MusicXML/MIDI，只有音高信息）。
 */
function pickTuning(staff: Staff, program: number): number[] {
  const existing = staff.stringTuning.tunings;
  if (existing.length >= 3) return [...existing];
  if (staff.isPercussion) return [0, 0, 0, 0, 0, 0];
  if (program >= 32 && program <= 39) return TUNING_BASS;
  let min = Infinity;
  for (const bar of staff.bars)
    for (const voice of bar.voices)
      for (const beat of voice.beats)
        for (const note of beat.notes) min = Math.min(min, note.realValue);
  if (min >= TUNING_GUITAR7[6] && min < TUNING_GUITAR[5]) return TUNING_GUITAR7;
  return TUNING_GUITAR;
}

/**
 * 弦品指派：把一拍内的音符（按音高降序）从高音弦向低音弦贪心分配，
 * 每弦一音；超出音域的音高按八度折叠进 [最低空弦, 最高空弦+MAX_FRET]；
 * 延音目标复用起点的弦品（GP 的延音线按弦延续）；实在放不下的音符丢弃。
 */
function assignBeat(
  beat: Beat,
  tuning: number[],
  isPercussion: boolean,
  assigned: Map<Note, Fingering>,
): void {
  const L = tuning.length;
  const used = new Set<number>();

  if (isPercussion) {
    let s = L;
    for (const note of beat.notes) {
      if (s < 1) break;
      assigned.set(note, { string: s--, fret: Math.max(0, Math.min(127, note.realValue)) });
    }
    return;
  }

  const pending: Note[] = [];
  for (const note of beat.notes) {
    if (note.isTieDestination && note.tieOrigin && assigned.has(note.tieOrigin)) {
      const f = assigned.get(note.tieOrigin)!;
      if (!used.has(f.string)) {
        assigned.set(note, f);
        used.add(f.string);
        continue;
      }
    }
    if (note.string >= 1 && note.string <= L && note.fret >= 0 && !used.has(note.string)) {
      assigned.set(note, { string: note.string, fret: note.fret });
      used.add(note.string);
      continue;
    }
    pending.push(note);
  }

  const low = tuning[L - 1];
  const high = tuning[0] + MAX_FRET;
  for (const note of pending.sort((a, b) => b.realValue - a.realValue)) {
    let v = note.realValue;
    while (v > high) v -= 12;
    while (v < low) v += 12;
    // tuning[0] 是最高音弦，对应 alphaTab 弦号 L；从高音弦往下找第一个可用弦
    for (let idx = 0; idx < L; idx++) {
      const stringNo = L - idx;
      const fret = v - tuning[idx];
      if (fret >= 0 && fret <= MAX_FRET && !used.has(stringNo)) {
        assigned.set(note, { string: stringNo, fret });
        used.add(stringNo);
        break;
      }
    }
  }
}

/**
 * 就地补齐缺失的调弦与弦品（MusicXML/MIDI 来源的音符没有弦号品格），
 * 供 TAB 序列化使用；GP 来源已有的调弦和弦品原样保留。
 */
export function ensureFingerings(score: Score): void {
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      const tuning = pickTuning(staff, track.playbackInfo.program);
      if (staff.stringTuning.tunings.length < 3) staff.stringTuning.tunings = tuning;
      const assigned = new Map<Note, Fingering>();
      for (const bar of staff.bars)
        for (const voice of bar.voices)
          for (const beat of voice.beats) {
            assignBeat(beat, tuning, false, assigned);
            for (const note of beat.notes) {
              const f = assigned.get(note);
              if (f) {
                note.string = f.string;
                note.fret = f.fret;
              }
            }
          }
    }
  }
}

/**
 * GP5 没有"多谱表音轨"的概念，钢琴大谱表这类输入在 GP5 里的原生表示就是拆成
 * 多个音轨，因此把每个 (track, staff) 展开成一个 GP5 音轨；只有一个谱表时
 * 沿用原音轨名，多谱表则加序号区分（左右手）。
 */
interface Unit {
  track: Track;
  staff: Staff;
  name: string;
}

function expandStaves(score: Score): Unit[] {
  const units: Unit[] = [];
  for (const track of score.tracks) {
    const staves = track.staves.filter((s) => s.bars.length > 0);
    staves.forEach((staff, i) => {
      units.push({
        track,
        staff,
        name: staves.length > 1 ? `${track.name} (${i + 1})` : track.name,
      });
    });
  }
  return units;
}

/**
 * 取一个小节里实际要写进 GP5 的声部（每个元素是该声部要写的拍列表，最多 2 个）。
 * GP5 每小节固定 2 个声部，但 alphaTab 的声部下标沿用来源编号：MuseScore 导出的
 * 大谱表下谱表用 <voice>5</voice>，对应下标 4，前面 4 个是空占位，所以按"非空优先"
 * 取；整小节皆空时退回原下标，保留休止符原样。没有拍可写的声部一律剔除，
 * 因为 GP5 里它写成拍数 0，alphaTab 读到时不会建出 Voice。
 */
function pickVoices(bar: Bar | undefined): Beat[][] {
  const all = bar?.voices ?? [];
  const nonEmpty = all.filter((v) => !v.isEmpty);
  return (nonEmpty.length > 0 ? nonEmpty : all)
    .map((v) => v.beats.filter((bt) => bt.graceType === 0))
    .filter((beats) => beats.length > 0)
    .slice(0, 2);
}

export function exportGp5(score: Score): Uint8Array {
  const w = new ByteWriter();
  const units = expandStaves(score);
  const barCount = score.masterBars.length;

  // 预先完成全部弦品指派
  const tunings: number[][] = [];
  const assigned = new Map<Note, Fingering>();
  for (const { track, staff } of units) {
    const tuning = pickTuning(staff, track.playbackInfo.program);
    tunings.push(tuning);
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const beat of voice.beats) assignBeat(beat, tuning, staff.isPercussion, assigned);
  }

  // ---- 版本头 ----
  w.stringByteLength("FICHIER GUITAR PRO v5.00", 30);

  // ---- 曲谱信息 ----
  for (const s of [
    score.title, score.subTitle, score.artist, score.album, score.words,
    score.music, score.copyright, score.tab, score.instructions,
  ])
    w.stringIntByte(s);
  w.i32(0); // notice 行数

  // ---- 歌词 ----
  // GP5 歌词是曲谱级：挂载音轨号 + 固定 5 行（每行：起始小节 + int32 长度文本），
  // 打开时按空格分隔的音节从起始小节起顺次分配到该轨声部 1 的**每个**非休止拍上。
  // 因此收集必须沿写出后的声部 1（pickVoices 的第一个声部）逐拍走：无歌词的拍写
  // "-" 占位（解析后是空音节，占一拍不显示），否则后续音节整体前移错位。
  // 音节内的空格/连字符换成 +（两者都是 GP 的音节分隔符，保留会拆散音节），
  // 非 ASCII 歌词同其他字符串一样降级为 '?'。取歌词拍最多的展开单元作为挂载轨
  let lyricUnit = -1;
  let lyricChunks: string[] = [];
  let lyricStartBar = 0;
  let lyricBest = 0;
  units.forEach(({ staff }, ui) => {
    const chunks: string[] = [];
    let first = -1;
    let count = 0;
    for (const bar of staff.bars) {
      for (const beat of pickVoices(bar)[0] ?? []) {
        if (beat.isRest || beat.isEmpty) continue;
        const text = beat.lyrics?.[0];
        if (text && first < 0) first = bar.index;
        if (first < 0) continue;
        if (text) count++;
        chunks.push(text ? text.replace(/[\s-]+/g, "+") : "-");
      }
    }
    while (chunks.length && chunks[chunks.length - 1] === "-") chunks.pop();
    if (count > lyricBest) {
      lyricBest = count;
      lyricUnit = ui;
      lyricChunks = chunks;
      lyricStartBar = first;
    }
  });
  w.i32(lyricUnit + 1); // 1-based，0 表示无歌词轨
  for (let i = 0; i < 5; i++) {
    w.i32(i === 0 ? lyricStartBar + 1 : 1);
    const t = i === 0 ? ascii(lyricChunks.join(" "), Infinity) : "";
    w.i32(t.length);
    w.chars(t);
  }

  // ---- 页面设置 ----
  for (const v of [210, 297, 10, 10, 15, 10, 100]) w.i32(v);
  w.i16(0x1ff);
  for (const s of [
    "%title%", "%subtitle%", "%artist%", "%album%", "%words%", "%music%",
    "%words% & %music%", "Copyright %copyright%",
    "All Rights Reserved - International Copyright Secured", "Page %N%/%P%",
  ])
    w.stringIntByte(s);

  // ---- 速度 / 调号 ----
  w.stringIntByte("");
  w.i32(Math.round(score.tempo));
  const firstBar = units[0]?.staff.bars[0];
  w.i32(firstBar ? firstBar.keySignature : 0);
  w.u8(0); // 八度

  // ---- 64 个 MIDI 通道 ----
  const channelOf = (i: number) => (units[i].staff.isPercussion ? 9 : (i * 2) % 64);
  const programs = new Array<number>(64).fill(0);
  for (let i = 0; i < units.length; i++)
    programs[channelOf(i)] = Math.max(0, units[i].track.playbackInfo.program);
  for (let c = 0; c < 64; c++) {
    w.i32(programs[c]);
    w.u8(13); // 音量（GP 0-16 刻度）
    w.u8(8); // 声像（居中）
    w.zeros(6);
  }

  // ---- 反复跳转标记（全部未使用）----
  for (let i = 0; i < 19; i++) w.i16(-1);
  w.i32(0);

  w.i32(barCount);
  w.i32(units.length);

  // ---- 小节头 ----
  const keyBars = units[0]?.staff.bars ?? [];
  for (let b = 0; b < barCount; b++) {
    const mb = score.masterBars[b];
    const prev = b > 0 ? score.masterBars[b - 1] : null;
    const tsChanged =
      !prev ||
      mb.timeSignatureNumerator !== prev.timeSignatureNumerator ||
      mb.timeSignatureDenominator !== prev.timeSignatureDenominator;
    const key = keyBars[b];
    const keyChanged =
      key && (b === 0 || key.keySignature !== keyBars[b - 1].keySignature);

    let flags = 0;
    if (tsChanged) flags |= 1 | 2;
    if (mb.isRepeatStart) flags |= 4;
    if (mb.repeatCount > 0) flags |= 8;
    if (mb.section) flags |= 32;
    if (keyChanged) flags |= 64;
    if (mb.isDoubleBar) flags |= 128;

    w.u8(flags);
    if (flags & 1) w.u8(mb.timeSignatureNumerator);
    if (flags & 2) w.u8(mb.timeSignatureDenominator);
    if (flags & 8) w.u8(mb.repeatCount);
    if (flags & 32) {
      w.stringIntByte(mb.section!.text);
      w.color(255, 0, 0);
    }
    if (flags & 64) {
      w.i8(key.keySignature);
      w.u8(key.keySignatureType);
    }
    if (flags & 3) {
      // 符杠分组：把整小节的八分音符总数尽量按 2 个一组切成 4 组
      const eighths = Math.max(1, Math.round((mb.timeSignatureNumerator * 8) / mb.timeSignatureDenominator));
      const groups = [0, 0, 0, 0];
      let rest = eighths;
      for (let i = 0; i < 4 && rest > 0; i++) {
        groups[i] = i === 3 ? rest : Math.min(2, rest);
        rest -= groups[i];
      }
      for (const g of groups) w.u8(g);
    }
    w.u8(mb.alternateEndings);
    w.u8(0); // triplet feel
    w.u8(0);
  }

  // ---- 音轨 ----
  for (let t = 0; t < units.length; t++) {
    const { track, staff, name } = units[t];
    const tuning = tunings[t];
    w.u8((staff.isPercussion ? 1 : 0) | 8);
    w.stringByteLength(name, 40);
    w.i32(tuning.length);
    for (let i = 0; i < 7; i++) w.i32(i < tuning.length ? tuning[i] : 0);
    w.i32(1); // port
    w.i32(channelOf(t) + 1);
    w.i32(channelOf(t) + 2);
    w.i32(24); // 品数
    w.i32(Math.max(0, staff.capo));
    w.color(track.color.r, track.color.g, track.color.b);
    // v5.00 附加块（45 字节）：谱表显示标志 + RSE 占位
    w.u8(staff.isPercussion ? 2 : 3);
    w.zeros(4);
    w.i32(0);
    w.i32(0);
    w.i32(0);
    w.zeros(10);
    w.zeros(2);
    w.zeros(16);
  }

  // 声部数必须在同一音轨的所有小节间一致：alphaTab 读到拍数为 0 的声部时干脆不建
  // Voice，相邻小节声部数不一致会让 Bar.finish 的链接阶段取空（voices[1] 是 undefined）
  // 而崩溃。所以只要该轨任一小节写了 2 个声部，其余小节的第二声部就写空拍占位。
  const twoVoices = units.map(({ staff }) =>
    staff.bars.some((bar) => pickVoices(bar).length > 1),
  );

  // ---- 小节内容：按小节 × 音轨，每格 1 个换行字节 + 2 个声部 ----
  for (let b = 0; b < barCount; b++) {
    for (let t = 0; t < units.length; t++) {
      const picked = pickVoices(units[t].staff.bars[b]);
      w.u8(0);
      for (let v = 0; v < 2; v++) {
        const beats = picked[v] ?? [];
        if (beats.length === 0) {
          if (v === 0 || twoVoices[t]) {
            // 第一声部不能为空，写全小节休止符；第二声部只在该轨用到 2 声部时补位，
            // 写 GP5 的"空拍"（0x40 后跟 0），不渲染出多余的休止符
            w.i32(1);
            w.u8(0x40);
            w.u8(v === 0 ? 2 : 0);
            w.i8(-2);
            w.u8(0);
            w.i16(0);
          } else {
            w.i32(0);
          }
          continue;
        }
        w.i32(beats.length);
        for (const beat of beats) writeBeat(w, beat, tunings[t], assigned);
      }
    }
  }

  return w.toBytes();
}

function writeBeat(
  w: ByteWriter,
  beat: Beat,
  tuning: number[],
  assigned: Map<Note, Fingering>,
): void {
  const L = tuning.length;
  const notes = beat.notes
    .filter((n) => assigned.has(n))
    .sort((a, b) => assigned.get(b)!.string - assigned.get(a)!.string);
  const isRest = beat.isRest || notes.length === 0;

  const hasTuplet =
    beat.tupletNumerator > 1 && beat.tupletDenominator > 0 && VALID_TUPLETS.has(beat.tupletNumerator);
  const beatFx = beatEffectFlags(beat);

  let flags = 0;
  if (beat.dots > 0) flags |= 1;
  if (beatFx) flags |= 8;
  if (hasTuplet) flags |= 32;
  if (isRest) flags |= 64;

  w.u8(flags);
  if (isRest) w.u8(beat.isEmpty ? 0 : 2); // 0 = 空拍（不画休止符），2 = 真休止符
  w.i8(gpDuration(beat.duration));
  if (hasTuplet) w.i32(beat.tupletNumerator);
  if (beatFx) writeBeatEffects(w, beat, beatFx);

  let stringFlags = 0;
  for (const note of notes) stringFlags |= 1 << (6 - (L - assigned.get(note)!.string));
  w.u8(stringFlags);

  // 音符按高音弦在前的顺序写出（与 stringFlags 从 bit6 向下读取的顺序一致）
  notes.forEach((note, i) => {
    writeNote(w, beat, note, assigned.get(note)!, tuning, i === 0, assigned);
  });

  w.i16(0); // v5 拍级 flags2（符杠/八度记号，不使用）
}

/**
 * 拍级效果的两个 flag 字节，无效果时返回 null。
 * GP5 表达不了因而跳过的：fade-out / volume swell（只有 fade-in 位）。
 * 有损降级：wide vibrato → slight；rasgueado 的 18 种细分 → 唯一的 Ii；
 * arpeggio up/down → brush up/down（GP5 的击弦只有上下两向）。
 */
function beatEffectFlags(beat: Beat): [number, number] | null {
  let f1 = 0;
  let f2 = 0;
  if (beat.fade === FADE_IN) f1 |= 16;
  if (beat.vibrato !== VIBRATO_NONE) f1 |= 2;
  if (beat.tap || beat.slap || beat.pop) f1 |= 32;
  if (beat.brushType !== BRUSH_NONE) f1 |= 64;
  if (beat.rasgueado !== RASGUEADO_NONE) f2 |= 1;
  if (beat.pickStroke !== PICK_STROKE_NONE) f2 |= 2;
  if (beat.whammyBarPoints && beat.whammyBarPoints.length > 0) f2 |= 4;
  return f1 || f2 ? [f1, f2] : null;
}

function writeBeatEffects(w: ByteWriter, beat: Beat, [f1, f2]: [number, number]): void {
  w.u8(f1);
  w.u8(f2);
  if (f1 & 32) w.i8(beat.tap ? 1 : beat.slap ? 2 : 3);
  if (f2 & 4) writeBendPoints(w, beat.whammyBarPoints!);
  if (f1 & 64) {
    // v5.00 先 up 后 down，只有一侧非零
    const stroke = strokeValue(beat.brushDuration);
    const up = beat.brushType === BRUSH_UP || beat.brushType === ARPEGGIO_UP;
    w.u8(up ? stroke : 0);
    w.u8(up ? 0 : stroke);
  }
  if (f2 & 2) w.i8(beat.pickStroke === PICK_STROKE_UP ? 1 : 2);
}

/** brushDuration（ticks）→ GP5 击弦速度档位，取值来自 Gp3To5Importer._toStrokeValue 的逆映射 */
function strokeValue(duration: number): number {
  if (duration >= 480) return 6;
  if (duration >= 240) return 5;
  if (duration >= 120) return 4;
  if (duration >= 60) return 3;
  return 2; // 档位 1 与 2 读回来都是 30
}

/** 推弦 / 摇把的点列表，GP5 的存储单位是 alphaTab 的 25 倍（Gp3To5Importer._bendStep） */
function writeBendPoints(w: ByteWriter, points: BendPoint[]): void {
  let max = 0;
  for (const p of points) max = Math.max(max, p.value);
  w.u8(1); // 类型；alphaTab 读取时忽略，由点列表推断
  w.i32(max * 25);
  w.i32(points.length);
  for (const p of points) {
    w.i32(p.offset);
    w.i32(p.value * 25);
    w.u8(0); // 该点是否带颤音；alphaTab 读取时忽略
  }
}

/**
 * GP5 把倚音存成主音符的一个效果，而 alphaTab 存成独立的 grace beat，
 * 因此取紧邻主拍之前的那个 grace beat。GP5 每音符只能挂一个倚音，
 * 连续多个 grace beat / 倚音和弦只保留最后一个 beat 的首音。
 */
function graceOf(beat: Beat, assigned: Map<Note, Fingering>): Note | null {
  const prev = beat.voice.beats[beat.index - 1];
  if (!prev || prev.graceType === GRACE_NONE) return null;
  return prev.notes.find((n) => assigned.has(n)) ?? null;
}

function writeNote(
  w: ByteWriter,
  beat: Beat,
  note: Note,
  f: Fingering,
  tuning: number[],
  isFirst: boolean,
  assigned: Map<Note, Fingering>,
): void {
  const grace = isFirst ? graceOf(beat, assigned) : null;
  const fx = noteEffectFlags(note, beat, grace, isFirst, tuning[tuning.length - f.string]);

  let flags = 0x20 | 0x10; // 音符类型 + 力度
  if (note.accentuated === ACCENT_HEAVY) flags |= 2;
  else if (note.accentuated === ACCENT_NORMAL) flags |= 64;
  if (note.isGhost) flags |= 4;
  if (fx) flags |= 8;
  if (note.leftHandFinger !== FINGER_UNKNOWN || note.rightHandFinger !== FINGER_UNKNOWN) flags |= 128;

  w.u8(flags);
  w.u8(note.isDead ? 3 : note.isTieDestination ? 2 : 1);
  w.i8(Math.max(1, Math.min(8, note.dynamics + 1)));
  w.i8(f.fret);
  if (flags & 128) {
    w.i8(note.leftHandFinger);
    w.i8(note.rightHandFinger);
  }
  w.u8(0); // v5 附加 flags（变音记号交换，不使用）
  if (fx) writeNoteEffects(w, note, beat, fx, grace, tuning[tuning.length - f.string], assigned);
}

/**
 * 音符级效果的两个 flag 字节，无效果时返回 null。
 * GP5 表达不了因而跳过的：拨片刮弦（SlideOutType.PickSlideUp/Down）、
 * feedback 泛音、tenuto 重音、左手点弦（GP6+ 才有）、bendStyle。
 */
function noteEffectFlags(
  note: Note,
  beat: Beat,
  grace: Note | null,
  isFirst: boolean,
  stringTuning: number,
): [number, number] | null {
  let f1 = 0;
  let f2 = 0;
  if (note.bendPoints && note.bendPoints.length > 0) f1 |= 1;
  if (note.isHammerPullOrigin) f1 |= 2;
  if (note.isLetRing) f1 |= 8;
  if (grace) f1 |= 16;
  if (note.isStaccato) f2 |= 1;
  if (note.isPalmMute) f2 |= 2;
  // 颤音拨片在 GP5 里是音符效果、在 alphaTab 里挂在拍上，只随首音写一次
  if (isFirst && beat.tremoloPicking) f2 |= 4;
  if (slideBits(note) !== 0) f2 |= 8;
  if (harmonicKind(note) !== 0) f2 |= 16;
  if (trillFret(note, stringTuning) >= 0) f2 |= 32;
  if (note.vibrato !== VIBRATO_NONE) f2 |= 64;
  return f1 || f2 ? [f1, f2] : null;
}

function writeNoteEffects(
  w: ByteWriter,
  note: Note,
  beat: Beat,
  [f1, f2]: [number, number],
  grace: Note | null,
  stringTuning: number,
  assigned: Map<Note, Fingering>,
): void {
  w.u8(f1);
  w.u8(f2);
  if (f1 & 1) writeBendPoints(w, note.bendPoints!);
  if (f1 & 16) writeGrace(w, grace!, assigned);
  if (f2 & 4) w.u8(beat.tremoloPicking!.marks);
  if (f2 & 8) w.i8(slideBits(note));
  if (f2 & 16) writeHarmonic(w, note, stringTuning);
  if (f2 & 32) {
    w.u8(trillFret(note, stringTuning));
    w.u8(note.trillSpeed === 32 ? 2 : note.trillSpeed === 64 ? 3 : 1);
  }
}

function writeGrace(w: ByteWriter, grace: Note, assigned: Map<Note, Fingering>): void {
  w.i8(assigned.get(grace)!.fret);
  w.i8(Math.max(1, Math.min(8, grace.dynamics + 1)));
  // 过渡方式：0 无 / 1 圆滑滑音 / 2 推弦 / 3 击勾弦
  w.i8(grace.slideOutType === SLIDE_OUT.legato ? 1 : grace.isHammerPullOrigin ? 3 : 0);
  w.u8(1); // 倚音时值；alphaTab 固定按 32 分音符读回
  w.u8((grace.isDead ? 1 : 0) | (grace.beat.graceType === GRACE_ON_BEAT ? 2 : 0));
}

/** v5.00 的滑音是位域：出向 1/2/4/8，入向 16/32 */
function slideBits(note: Note): number {
  let bits = 0;
  if (note.slideOutType === SLIDE_OUT.shift) bits |= 1;
  else if (note.slideOutType === SLIDE_OUT.legato) bits |= 2;
  else if (note.slideOutType === SLIDE_OUT.outDown) bits |= 4;
  else if (note.slideOutType === SLIDE_OUT.outUp) bits |= 8;
  if (note.slideInType === SLIDE_IN.fromBelow) bits |= 16;
  else if (note.slideInType === SLIDE_IN.fromAbove) bits |= 32;
  return bits;
}

/** 泛音类型字节；GP5 没有 feedback 泛音，返回 0 表示不写 */
function harmonicKind(note: Note): number {
  switch (note.harmonicType) {
    case HARMONIC.natural:
      return 1;
    case HARMONIC.artificial:
      return 2;
    case HARMONIC.tap:
      return 3;
    case HARMONIC.pinch:
      return 4;
    case HARMONIC.semi:
      return 5;
    default:
      return 0;
  }
}

// ModelUtils.deltaFretToHarmonicValue 的逆映射（同值多解时取 alphaTab 会写回原值的那个）
const HARMONIC_DELTA = new Map<number, number>([
  [2.4, 2], [3.2, 3], [8.2, 8], [9.6, 10], [14.7, 15], [21.7, 22],
  [4, 4], [5, 5], [7, 7], [9, 9], [12, 12], [16, 16], [17, 17], [19, 19], [24, 24],
]);

function writeHarmonic(w: ByteWriter, note: Note, stringTuning: number): void {
  const kind = harmonicKind(note);
  w.u8(kind);
  if (kind !== 2 && kind !== 3) return; // 自然 / 掐拨 / 半泛音无附加字节
  const delta = HARMONIC_DELTA.get(note.harmonicValue) ?? 12;
  if (kind === 3) {
    w.u8(delta); // 点弦泛音直接存品格差
    return;
  }
  // 人工泛音存的是目标音（tone + key + 八度偏移），alphaTab 读回时减去实际发声音级
  const played = (note.fret + stringTuning) % 12;
  const target = played + delta;
  w.u8(target % 12);
  w.u8(0); // key（升降号），0 表示无
  w.u8(Math.floor(target / 12));
}

/** 颤音的目标品格；无颤音或超出字节范围时返回 -1 */
function trillFret(note: Note, stringTuning: number): number {
  if (note.trillValue < 0) return -1;
  const fret = note.trillValue - stringTuning;
  return fret >= 0 && fret <= 255 ? fret : -1;
}
