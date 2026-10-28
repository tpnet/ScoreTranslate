import * as alphaTab from "@coderline/alphatab";
import JSZip from "jszip";

const SECTOR_SIZE = 4096;
const MAX_FILE_SECTORS = (SECTOR_SIZE - 148) / 4 - 1;

// GP6 每轨只有一组调弦/变调夹属性，多谱表拆轨才能保留各自的配置与音符。
function splitStaves(score: alphaTab.model.Score): void {
  const originalIndices: number[] = [];
  score.tracks = score.tracks.flatMap(track => track.staves.map((staff, i) => {
    const copy = Object.assign(new alphaTab.model.Track(), track);
    copy.name = track.staves.length > 1 ? `${track.name} (${i + 1})` : track.name;
    copy.index = originalIndices.length;
    originalIndices.push(track.index);
    copy.staves = [];
    copy.addStaff(staff);
    return copy;
  }));
  const remap = <T>(map: Map<number, T> | null) => map && new Map(originalIndices.flatMap((old, i) =>
    map.has(old) ? [[i, map.get(old)!] as const] : []));
  const ss = score.stylesheet;
  ss.perTrackDisplayTuning = remap(ss.perTrackDisplayTuning);
  ss.perTrackChordDiagramsOnTop = remap(ss.perTrackChordDiagramsOnTop);
  if (ss.perTrackMultiBarRest) {
    const old = ss.perTrackMultiBarRest;
    ss.perTrackMultiBarRest = new Set(originalIndices.flatMap((index, i) => old.has(index) ? [i] : []));
  }
}

function gp6Xml(xml: string, score: alphaTab.model.Score): string {
  // 先转义 CDATA，后续只改写导出器生成的标签，不会误改标题、歌词里的 XML 文本。
  xml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  xml = xml.replace(/<GPVersion>[^<]*<\/GPVersion>/, "")
    .replace(/<GPRevision\b[^>]*>[^<]*<\/GPRevision>/, "<GPRevision>11686</GPRevision>")
    .replace(/<(Encoding|AudioTracks|BackingTrack|Assets)\b[^>]*\/>|<(Encoding|AudioTracks|BackingTrack|Assets)\b[^>]*>[\s\S]*?<\/\2>/g, "");
  xml = xml.replace(/<Track id="(\d+)">[\s\S]*?<\/Track>/g, (trackXml: string, id: string) => {
    const track = score.tracks[Number(id)];
    const staff = track.staves[0];
    const program = track.playbackInfo.program;
    const strings = staff.tuning.length;
    const instrument = staff.isPercussion ? "drmkt" : program >= 24 && program <= 31
      ? `${program === 24 ? "n" : program === 25 ? "s" : "e"}-gtr${strings || 6}`
      : program >= 32 && program <= 39 ? `${program === 32 ? "a" : "e"}-bass${strings || 4}` : "a-piano-ss";
    const nominalKey = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][(staff.displayTranspositionPitch % 12 + 12) % 12];
    const sounding = `<PartSounding><NominalKey>${nominalKey}</NominalKey><TranspositionPitch>${staff.displayTranspositionPitch}</TranspositionPitch></PartSounding>`;
    return trackXml
      .replace(/<InstrumentSet>[\s\S]*?<\/InstrumentSet>/, `<Instrument ref="${instrument}"/>${sounding}`)
      .replace(/<Transpose>[\s\S]*?<\/Transpose>/, "")
      .replace(/<MidiConnection>([\s\S]*?)<\/MidiConnection>/, (_, midi: string) =>
        `<GeneralMidi table="${staff.isPercussion ? "Percussion" : "Instrument"}"><Program>${program}</Program>${midi}</GeneralMidi>`)
      .replace(/<Staves>\s*<Staff>([\s\S]*?)<\/Staff>\s*<\/Staves>/, "$1")
      .replace(/<Sounds>[\s\S]*?<\/Sounds>/, "");
  });
  const drums = new Map<number, alphaTab.model.Note>();
  for (const track of score.tracks) for (const staff of track.staves) if (staff.isPercussion) {
    for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
      drums.set(note.id, note);
    }
  }
  return xml.replace(/<Note id="(\d+)">[\s\S]*?<\/Note>/g, (noteXml: string, id: string) => {
    const drum = drums.get(Number(id));
    if (drum) {
      const articulations = drum.beat.voice.bar.staff.track.percussionArticulations;
      const midi = articulations[drum.percussionArticulation]?.outputMidiNumber ?? drum.percussionArticulation;
      const element = drum.element < 0 ? "" : `<Property name="Element"><Element>${drum.element}</Element></Property>` +
        `<Property name="Variation"><Variation>${drum.variation}</Variation></Property>`;
      // GP6 用 MIDI / Element，alphaTab 用 InstrumentArticulation；统一为实际 MIDI 鼓音，避免把自定义索引当音高。
      return noteXml.replace(/<Property name="Midi">[\s\S]*?<\/Property>/g, "")
        .replace("</Properties>", `<Property name="Midi"><Number>${midi}</Number></Property>${element}</Properties>`)
        .replace(/<InstrumentArticulation>[^<]*<\/InstrumentArticulation>/, `<InstrumentArticulation>${midi}</InstrumentArticulation>`);
    }
    return noteXml.replace(/<InstrumentArticulation>[^<]*<\/InstrumentArticulation>/, "");
  });
}

// 镜像 alphaTab GpxFileSystem / MuseScore GuitarPro6：小端目录项与扇区号均相对 BCFS 头之后。
function writeFileSystem(files: [string, Uint8Array][]): Uint8Array {
  const counts = files.map(([, data]) => Math.ceil(data.length / SECTOR_SIZE));
  // shortcut: 单文件使用一个目录扇区；超过约 3.85 MiB 时拒绝，待有大谱需求再实现扩展目录。
  if (counts.some(count => count > MAX_FILE_SECTORS)) {
    throw new Error("转换失败：GPX 内部文件超过 3.85 MiB，请减少音轨或改用 .gp 格式");
  }
  const sectorCount = 3 + files.length + counts.reduce((sum, n) => sum + n, 0);
  const out = new Uint8Array(4 + sectorCount * SECTOR_SIZE);
  out.set(new TextEncoder().encode("BCFS"));
  const view = new DataView(out.buffer, 4);
  const bytes = out.subarray(4);
  bytes.fill(255, 0, SECTOR_SIZE);
  for (let i = 0; i < sectorCount; i++) bytes[i >> 3] &= ~(1 << (i & 7));
  view.setUint32(SECTOR_SIZE, 1, true);
  bytes[SECTOR_SIZE + 4] = 47; // 根目录 /
  view.setUint32(SECTOR_SIZE + 136, 1, true);
  view.setUint32(SECTOR_SIZE + 140, files.length * 4, true);
  view.setUint32(SECTOR_SIZE + 148, 2, true);
  let sector = 3;
  files.forEach(([name, data], i) => {
    view.setUint32(2 * SECTOR_SIZE + i * 4, sector, true);
    const entry = sector++ * SECTOR_SIZE;
    view.setUint32(entry, 2, true);
    bytes.set(new TextEncoder().encode(name), entry + 4);
    view.setUint32(entry + 136, 1, true);
    view.setUint32(entry + 140, data.length, true);
    for (let block = 0; block < counts[i]; block++) view.setUint32(entry + 148 + block * 4, sector + block, true);
    bytes.set(data, sector * SECTOR_SIZE);
    sector += counts[i];
  });
  return out;
}

// GPX 的 BCFZ 不是 ZIP/deflate；回引用按低位优先编码，且不能重叠复制。
function compressFileSystem(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + Math.ceil(data.length * 9 / 8));
  out.set(new TextEncoder().encode("BCFZ"));
  new DataView(out.buffer).setUint32(4, data.length, true);
  let bit = 64;
  const write = (value: number, count: number, reversed = false) => {
    for (let i = 0; i < count; i++, bit++) {
      out[bit >> 3] |= ((value >> (reversed ? i : count - 1 - i)) & 1) << (7 - (bit & 7));
    }
  };
  const positions = new Int32Array(65536).fill(-1);
  const hash = (i: number) => ((data[i] << 8) ^ (data[i + 1] << 4) ^ data[i + 2]) & 65535;
  let position = 0;
  while (position < data.length) {
    const previous = position + 2 < data.length ? positions[hash(position)] : -1;
    const offset = position - previous;
    let length = 0;
    if (previous >= 0 && offset <= 32767) {
      const max = Math.min(offset, data.length - position);
      while (length < max && data[previous + length] === data[position + length]) length++;
    }
    const wordSize = Math.ceil(Math.log2(offset + 1));
    const start = position;
    if (length >= 3 && length * 8 > 5 + 2 * wordSize) {
      write(1, 1);
      write(wordSize, 4);
      write(offset, wordSize, true);
      write(length, wordSize, true);
      position += length;
    } else {
      const count = Math.min(3, data.length - position);
      write(0, 1);
      write(count, 2, true);
      for (let i = 0; i < count; i++) write(data[position++], 8);
    }
    for (let i = start; i < position && i + 2 < data.length; i++) {
      const key = hash(i);
      // 保留一定距离，零填充扇区才能用长回引用编码。
      if (positions[key] < 0 || i - positions[key] >= 16) positions[key] = i;
    }
  }
  return out.subarray(0, Math.ceil(bit / 8));
}

export async function exportGpx(score: alphaTab.model.Score): Promise<Uint8Array> {
  splitStaves(score);
  const gp = new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings());
  const zip = await JSZip.loadAsync(gp);
  const xml = await zip.file("Content/score.gpif")!.async("string");
  const files: [string, Uint8Array][] = [["score.gpif", new TextEncoder().encode(gp6Xml(xml, score))]];
  for (const name of ["BinaryStylesheet", "PartConfiguration", "LayoutConfiguration"]) {
    files.push([name, await zip.file(`Content/${name}`)!.async("uint8array")]);
  }
  return compressFileSystem(writeFileSystem(files));
}
