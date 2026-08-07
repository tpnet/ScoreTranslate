/**
 * GP5 (Guitar Pro 5, "FICHIER GUITAR PRO v5.00") 二进制写出器。
 *
 * 字节布局逐字段镜像 alphaTab 的 Gp3To5Importer（node_modules/@coderline/alphatab
 * dist 源码中 readScore 的 v5.00 分支）——写出顺序必须与其读取顺序严格一致，
 * 任何一个字节的偏差都会让整个文件后续错位。修改前先对照该解析器。
 *
 * 支持：多轨、音符/休止符、时值/附点/连音、延音线、力度、拍号/调号、
 * 反复记号、小节标记、调弦/变调夹。不写出演奏效果（推弦、滑音等）与和弦图。
 */
import type * as alphaTab from "@coderline/alphatab";

type Score = alphaTab.model.Score;
type Track = alphaTab.model.Track;
type Staff = alphaTab.model.Staff;
type Beat = alphaTab.model.Beat;
type Note = alphaTab.model.Note;

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
function ascii(s: string): string {
  return (s ?? "")
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 250);
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

  // ---- 歌词（空） ----
  w.i32(0);
  for (let i = 0; i < 5; i++) {
    w.i32(1);
    w.i32(0);
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

  // ---- 小节内容：按小节 × 音轨，每格 1 个换行字节 + 2 个声部 ----
  for (let b = 0; b < barCount; b++) {
    for (let t = 0; t < units.length; t++) {
      const bar = units[t].staff.bars[b];
      // GP5 每小节固定 2 个声部，但 alphaTab 的声部下标沿用来源编号：MuseScore
      // 导出的大谱表下谱表用 <voice>5</voice>，对应下标 4，前面 4 个是空占位。
      // 因此按"非空优先"取前两个；整小节皆空时退回原下标，保留休止符原样
      const all = bar?.voices ?? [];
      const nonEmpty = all.filter((v) => !v.isEmpty);
      const picked = nonEmpty.length > 0 ? nonEmpty : all;
      w.u8(0);
      for (let v = 0; v < 2; v++) {
        const voice = picked[v];
        const beats = voice ? voice.beats.filter((bt) => bt.graceType === 0) : [];
        if (beats.length === 0) {
          if (v === 0) {
            // 第一声部不能为空：写一个全休止符占位
            w.i32(1);
            w.u8(0x40);
            w.u8(2);
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

  let flags = 0;
  if (beat.dots > 0) flags |= 1;
  if (hasTuplet) flags |= 32;
  if (isRest) flags |= 64;

  w.u8(flags);
  if (isRest) w.u8(2);
  w.i8(gpDuration(beat.duration));
  if (hasTuplet) w.i32(beat.tupletNumerator);

  let stringFlags = 0;
  for (const note of notes) stringFlags |= 1 << (6 - (L - assigned.get(note)!.string));
  w.u8(stringFlags);

  // 音符按高音弦在前的顺序写出（与 stringFlags 从 bit6 向下读取的顺序一致）
  for (const note of notes) {
    const f = assigned.get(note)!;
    w.u8(0x20 | 0x10);
    w.u8(note.isDead ? 3 : note.isTieDestination ? 2 : 1);
    w.i8(Math.max(1, Math.min(8, note.dynamics + 1)));
    w.i8(f.fret);
    w.u8(0); // v5 flags2
  }

  w.i16(0); // v5 拍级 flags2（符杠/八度记号，不使用）
}
