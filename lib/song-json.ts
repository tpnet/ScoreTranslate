/** LiberLive 原始谱及二维 GP 时间线的输入适配。统一成 480 PPQ 后桥接 MusicXML。 */
type Obj = Record<string, unknown>;
type Note = { start: number; end: number; pitch: number; words?: string; velocity?: number };
type Track = { name: string; notes: Note[] };
type Chord = { start: number; name: string; section?: string };
export type SongJsonOptions = { jsonTempo?: number; jsonMiddleC?: number };
const object = (x: unknown): Obj => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('歌曲 JSON 中应为对象');
  return x as Obj;
};
const array = (x: unknown): unknown[] => {
  if (!Array.isArray(x)) throw new Error('歌曲 JSON 中应为数组');
  return x;
};
const num = (x: unknown): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('歌曲 JSON 中存在无效数值');
  return x;
};
const esc = (x: unknown) => String(x ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const ticks = (x: unknown, multiplier: number) => Math.round(num(x) * multiplier);

/** 普通 alphaTab JSON 返回 null，避免改变既有 JSON 导入流程。 */
export function songJsonToXml(value: unknown, options: SongJsonOptions = {}, title = '歌曲'): string | null {
  const raw = !Array.isArray(value) && value && typeof value === 'object' ? value as Obj : null;
  if (!Array.isArray(value) && !Array.isArray(raw?.lyrics)) return null;
  const tracks = new Map<string, Track>();
  const chords: Chord[] = [];
  let total = 0;
  let tempo = options.jsonTempo ?? 120;
  let artist = '';
  const add = (key: string, name: string, note: Note) => {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || note.start < 0 || note.end <= note.start)
      throw new Error('歌曲 JSON 中存在非法音高或音符时长');
    if (!tracks.has(key)) tracks.set(key, { name, notes: [] });
    tracks.get(key)!.notes.push(note);
  };
  if (raw) {
    if (raw.beat !== '4/4') throw new Error('LiberLive JSON 目前仅支持 4/4 拍');
    title = typeof raw.title === 'string' ? raw.title : title;
    artist = typeof raw.originalSinger === 'string' ? raw.originalSinger : '';
    tempo = options.jsonTempo ?? num(raw.tempo);
    const middleC = options.jsonMiddleC ?? 60;
    if (middleC % 12 !== 0 || middleC < 0 || middleC > 120) throw new Error('八度基准必须为有效的 MIDI C 音');
    const names = new Map((raw.trackConfigs ? array(raw.trackConfigs) : []).map(x => {
      const t = object(x); return [num(t.index), String(t.name ?? `LEAD ${t.index}`)];
    }));
    for (const [pi, p] of array(raw.lyrics).entries()) {
      for (const [bi, b] of array(object(p).bars).entries()) {
        const bar = object(b);
        if (num(bar.bar) !== bi) throw new Error('LiberLive 段内小节编号不连续');
        for (const item of array(bar.beats)) {
          const beat = object(item), beatIndex = num(beat.beat);
          if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex > 3) throw new Error('拍位置超出 4/4 小节');
          const base = total + beatIndex * 480;
          if (beat.chord) {
            const c = object(beat.chord);
            chords.push({ start: base, name: `${c.mainKey}${c.attachKey ?? ''}${c.transKey ? `/${c.transKey}` : ''}`, section: bi === 0 && beatIndex === 0 ? `Section ${pi + 1}` : undefined });
          }
          const lyrics = new Map((beat.words ? array(beat.words) : []).map(x => {
            const w = object(x); return [ticks(w.start, 120), String(w.word ?? '')];
          }));
          const groups = [{ index: 0, notes: beat.notes ?? [] }, ...(beat.extraTracks ? array(beat.extraTracks).map(object) : [])];
          for (const g of groups) {
            const index = num(g.index);
            if (!Number.isInteger(index) || index < 0) throw new Error('非法音轨编号');
            for (const n of array(g.notes)) {
              const note = object(n), pitchClass = num(note.note), octave = num(note.upOctave);
              if (!Number.isInteger(pitchClass) || pitchClass < 1 || pitchClass > 12 || !Number.isInteger(octave) || note.stretch)
                throw new Error('不支持的 LiberLive 音符编码或 stretch 音符');
              const start = ticks(note.start, 120);
              add(String(index), index === 0 ? 'VOCAL' : names.get(index) ?? `LEAD ${index}`, {
                start: base + start, end: base + ticks(num(note.start) + num(note.length), 120),
                // 与已生成的 GP JSON 保持一致；tone/leadNote 不参与未经验证的转调。
                pitch: middleC + pitchClass - 1 + 12 * octave,
                words: index === 0 ? lyrics.get(start) : undefined,
                velocity: note.velocity === undefined ? undefined : num(note.velocity),
              });
            }
          }
        }
        total += 1920;
      }
    }
  } else {
    // 外层 beat 是时间片时长；音符 tick 相对 chord 起点，不能把每行当成小节。
    for (const row of array(value)) for (const item of array(row)) {
      const cell = object(item);
      if (cell.chord) {
        const c = object(cell.chord);
        if (typeof c.name !== 'string') throw new Error('GP JSON 缺少和弦名称');
        chords.push({ start: total, name: c.name, section: typeof c.section === 'string' ? c.section : undefined });
        for (const t of array(c.tracks ?? [])) {
          const track = object(t);
          if (track.type !== 'VOCAL' && track.type !== 'LEAD') throw new Error('歌曲 JSON 暂仅支持 VOCAL 和 LEAD 音轨');
          const key = `${track.type}:${num(track.index)}`;
          for (const n of array(track.midi_notes)) {
            const note = object(n);
            add(key, `${track.type} ${track.index}`, {
              start: total + ticks(note.start_tick, 1), end: total + ticks(note.end_tick, 1), pitch: num(note.note),
              words: typeof note.words === 'string' ? note.words : undefined,
              velocity: note.velocity === undefined ? undefined : num(note.velocity),
            });
          }
        }
      }
      const duration = ticks(cell.beat, 480);
      if (duration <= 0) throw new Error('GP JSON 时间片时长必须为正数');
      total += duration;
    }
  }
  if (!tracks.size || total <= 0) throw new Error('歌曲 JSON 没有可导出的音符');
  if (tempo < 20 || tempo > 400) throw new Error('歌曲速度必须在 20–400 BPM 之间');
  // 延音可以超出最后一个和弦；补齐末小节，绝不裁掉尾音。
  for (const track of tracks.values()) for (const note of track.notes) total = Math.max(total, note.end);
  const bars = Math.ceil(total / 1920);
  if (bars > 5000) throw new Error('歌曲超过 5000 小节限制');
  const list = [...tracks.values()];
  const parts = list.map((t, i) => `<score-part id="P${i}"><part-name>${esc(t.name)}</part-name><score-instrument id="I${i}"><instrument-name>Piano</instrument-name></score-instrument><midi-instrument id="I${i}"><midi-channel>${i % 8 + 1}</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work><identification><creator type="composer">${esc(artist)}</creator></identification><part-list>${parts}</part-list>${list.map((t, i) => renderPart(t, i, bars, tempo, chords)).join('')}</score-partwise>`;
}

/** 任意整数 tick 转为标准音值或精确连音比例，避免将 256 tick 等时值量化丢失。 */
function rhythm(duration: number): string {
  const values: [number, string][] = [[1920, 'whole'], [960, 'half'], [480, 'quarter'], [240, 'eighth'], [120, '16th'], [60, '32nd'], [30, '64th'], [15, '128th']];
  for (const [ticks, name] of values) {
    if (duration === ticks) return `<type>${name}</type>`;
    if (duration === ticks * 1.5) return `<type>${name}</type><dot/>`;
  }
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(480, duration);
  return `<type>quarter</type><time-modification><actual-notes>${480 / divisor}</actual-notes><normal-notes>${duration / divisor}</normal-notes></time-modification>`;
}

/** 按所有音符起止点分割和弦，并用 tie 连接续音，支持多音同时发声和跨小节长音。 */
function renderPart(track: Track, index: number, bars: number, tempo: number, chords: Chord[]): string {
  let xml = `<part id="P${index}">`;
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * 1920, end = start + 1920;
    const notes = track.notes.filter(n => n.start < end && n.end > start);
    const harmonies = index === 0 ? chords.filter(c => c.start >= start && c.start < end) : [];
    let boundaries = [...new Set([start, end, ...notes.flatMap(n => [Math.max(start, n.start), Math.min(end, n.end)]), ...harmonies.map(c => c.start)])].sort((a, b) => a - b);
    // 普通长音拆成常规音值后加连音线，避免用 2:5 连音表示常见的两拍半。
    const split: number[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      let at = boundaries[i];
      let remaining = boundaries[i + 1] - at;
      split.push(at);
      if (remaining % 15 === 0) {
        for (const d of [1920, 1440, 960, 720, 480, 360, 240, 180, 120, 90, 60, 45, 30, 15]) {
          while (remaining > d) { at += d; remaining -= d; split.push(at); }
          if (remaining === d) break;
        }
      }
    }
    boundaries = [...split, end];
    xml += `<measure number="${bar + 1}">`;
    if (bar === 0) xml += `<attributes><divisions>480</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const at = boundaries[i], until = boundaries[i + 1], duration = until - at;
      for (const c of harmonies.filter(c => c.start === at)) {
        xml += harmony(c.name);
        if (c.section) xml += `<direction><direction-type><rehearsal>${esc(c.section)}</rehearsal></direction-type></direction>`;
      }
      const active = notes.filter(n => n.start <= at && n.end > at);
      if (!active.length) xml += `<note><rest/><duration>${duration}</duration><voice>1</voice>${rhythm(duration)}</note>`;
      for (const [ni, n] of active.entries()) {
        const pc = n.pitch % 12, name = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'][pc];
        const alter = [1, 3, 6, 8, 10].includes(pc) ? '<alter>1</alter>' : '';
        const ties = `${n.start < at ? '<tie type="stop"/>' : ''}${n.end > until ? '<tie type="start"/>' : ''}`;
        const dynamic = n.velocity === undefined ? '' : `<dynamics><${['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'][Math.max(0, Math.min(7, Math.round((n.velocity - 15) / 16)))]}/></dynamics>`;
        xml += `<note>${ni ? '<chord/>' : ''}<pitch><step>${name}</step>${alter}<octave>${Math.floor(n.pitch / 12) - 1}</octave></pitch><duration>${duration}</duration>${ties}<voice>1</voice>${rhythm(duration)}${ties || dynamic ? `<notations>${ties.replaceAll('<tie ', '<tied ')}${dynamic}</notations>` : ''}${n.start === at && n.words ? `<lyric><text>${esc(n.words)}</text></lyric>` : ''}</note>`;
      }
    }
    xml += '</measure>';
  }
  return xml + '</part>';
}

/** 和弦名直接保留后缀；这里只解释根音和 slash bass，不把 m7b5 等降级成其他类型。 */
function harmony(name: string): string {
  const normalized = name.replace(/^([#b])([A-G])/, '$2$1');
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(normalized);
  if (!m) throw new Error(`不支持的和弦名称：${name}`);
  const alter = (value: string) => value ? `<root-alter>${value === '#' ? 1 : -1}</root-alter>` : '';
  const bass = m[4] ? `<bass><bass-step>${m[4]}</bass-step>${m[5] ? `<bass-alter>${m[5] === '#' ? 1 : -1}</bass-alter>` : ''}</bass>` : '';
  return `<harmony><root><root-step>${m[1]}</root-step>${alter(m[2])}</root><kind text="${esc(m[3])}">${m[3] ? 'other' : 'major'}</kind>${bass}</harmony>`;
}
