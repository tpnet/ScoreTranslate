/** 真实文件回读检查：比较合并连音线后的音符音高、绝对起止与歌词。不是模拟写出器。 */
import * as alphaTab from '@coderline/alphatab';
import { readFileSync } from 'node:fs';
const [timelinePath, gpPath] = process.argv.slice(2);
if (!timelinePath || !gpPath) throw new Error('用法：bun scripts/verify-song-gp.ts input.gp.json output.gp');
const expected = new Map<string, string[]>();
const expectedChords: string[] = [];
let time = 0;
for (const row of JSON.parse(readFileSync(timelinePath, 'utf8'))) for (const cell of row) {
  if (cell.chord) expectedChords.push(JSON.stringify([time, cell.chord.name]));
  for (const track of cell.chord?.tracks ?? []) {
    const key = `${track.type}:${track.index}`;
    if (!expected.has(key)) expected.set(key, []);
    for (const n of track.midi_notes) expected.get(key)!.push(JSON.stringify([n.note, time + n.start_tick, time + n.end_tick, (n.words || '').trim()]));
  }
  time += Math.round(cell.beat * 480);
}
const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(readFileSync(gpPath), new alphaTab.Settings());
// 音高独立字段能让 alphaTab 正常回读，却不能证明 Guitar Pro 的弦乐轨可播放。
// 额外校验真实调弦与每个音符的弦品音高，捕获 C-1 空调弦导出回归。
for (const track of score.tracks) for (const staff of track.staves) {
  if (staff.isPercussion) continue;
  const tuning = staff.stringTuning.tunings;
  if (!tuning.length || tuning.some(p => p <= 0)) throw new Error(`${track.name}: 缺少有效调弦`);
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
    if (note.string < 1 || note.string > tuning.length || note.fret < 0 ||
        tuning[tuning.length - note.string] + note.fret + staff.capo !== note.realValue)
      throw new Error(`${track.name}: 弦品与实际音高不一致`);
  }
}
if (score.tracks.length !== expected.size) throw new Error('音轨数量改变');
for (const [index, [key, want]] of [...expected].entries()) {
  const got: string[] = [];
  for (const staff of score.tracks[index].staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
    for (const note of beat.notes) {
      if (note.isTieDestination) continue;
      let end = note;
      const seen = new Set();
      while (end.tieDestination) {
        if (seen.has(end)) throw new Error('连音线循环');
        seen.add(end); end = end.tieDestination;
      }
      // alphaTab 内部 960 PPQ；源 GP JSON 为 480 PPQ。
      got.push(JSON.stringify([note.realValue, beat.absolutePlaybackStart / 2,
        (end.beat.absolutePlaybackStart + end.beat.playbackDuration) / 2, (beat.lyrics?.[0] || '').trim()]));
    }
  }
  const a = want.sort(), b = got.sort();
  const differences = a.filter((n, i) => n !== b[i]);
  if (a.length !== b.length || differences.length) {
    console.error(key, { expected: a.length, actual: b.length, missing: a.filter(n => !b.includes(n)).slice(0, 8), extra: b.filter(n => !a.includes(n)).slice(0, 8) });
    process.exitCode = 1;
  } else console.log(`${key}: ${a.length} 音符音高、起止 tick、歌词内容匹配（忽略首尾空白）`);
}
const chordStaff = score.tracks[0].staves[0];
const actualChords = chordStaff.bars.flatMap(bar => bar.voices.flatMap(voice => voice.beats
  .filter(beat => beat.chordId !== null)
  .map(beat => JSON.stringify([beat.absolutePlaybackStart / 2, chordStaff.chords?.get(beat.chordId!)?.name]))));
if (JSON.stringify(expectedChords) !== JSON.stringify(actualChords)) throw new Error('和弦名称或起点改变');
console.log(`和弦名称和起点匹配：${actualChords.length}`);
console.log({ tempo: score.tempo, bars: score.masterBars.length, expectedBeats: time / 480 });
