import type { model } from "@coderline/alphatab";

// 把 alphaTab 解析出的 Guitar Pro 乐谱模型序列化为 MusicXML 4.0（partwise）。
// 与 MuseScore 的 MusicXML 导出不同，这里保留 TAB 谱表、调弦和每个音的弦/品，
// 使 MuseScore 等软件打开后能还原 Guitar Pro 的六线谱视图和把位。

const DIVISIONS = 480; // 每四分音符的时值单位，能整除 64 分音符、附点和常见连音

const STEP_SHARP = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const ALTER_SHARP = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const STEP_FLAT = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
const ALTER_FLAT = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

const TYPE_NAMES: Record<number, string> = {
  [-4]: "long", [-2]: "breve", 1: "whole", 2: "half", 4: "quarter", 8: "eighth",
  16: "16th", 32: "32nd", 64: "64th", 128: "128th", 256: "256th",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pitchXml(midi: number, useFlats: boolean, tag = "pitch"): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const step = useFlats ? STEP_FLAT[pc] : STEP_SHARP[pc];
  const alter = useFlats ? ALTER_FLAT[pc] : ALTER_SHARP[pc];
  return (
    `<${tag}><step>${step}</step>` +
    (alter !== 0 ? `<alter>${alter}</alter>` : "") +
    `<octave>${octave}</octave></${tag}>`
  );
}

// Duration 枚举值 → 以 DIVISIONS 为单位的时值（含附点与连音修正）
function beatTicks(beat: model.Beat): number {
  const d = beat.duration as number;
  let ticks = d > 0 ? (DIVISIONS * 4) / d : DIVISIONS * 4 * -d;
  let dotAdd = ticks / 2;
  for (let i = 0; i < beat.dots; i++) {
    ticks += dotAdd;
    dotAdd /= 2;
  }
  if (beat.tupletNumerator > 0 && beat.tupletDenominator > 0 && beat.tupletNumerator !== 1) {
    ticks = (ticks * beat.tupletDenominator) / beat.tupletNumerator;
  }
  return Math.round(ticks);
}

function noteXml(
  note: model.Note,
  beat: model.Beat,
  opts: { isChord: boolean; stringed: boolean; stringCount: number; useFlats: boolean; voice: number; ticks: number },
): string {
  const { isChord, stringed, stringCount, useFlats, voice, ticks } = opts;
  const grace = (beat.graceType as number) !== 0;
  let xml = "<note>";
  if (grace) xml += `<grace${(beat.graceType as number) === 2 ? ' slash="yes"' : ""}/>`;
  if (isChord) xml += "<chord/>";
  // 直接写实际发声音高：MuseScore 4 导入时会忽略 transpose 的八度声明，
  // 若按吉他记谱惯例写高八度会导致品位整体上移一个八度
  xml += pitchXml(note.realValue, useFlats);
  if (!grace) xml += `<duration>${ticks}</duration>`;
  if (note.isTieDestination) xml += '<tie type="stop"/>';
  if (note.isTieOrigin) xml += '<tie type="start"/>';
  xml += `<voice>${voice}</voice>`;
  const typeName = TYPE_NAMES[beat.duration as number];
  if (typeName) xml += `<type>${typeName}</type>`;
  xml += "<dot/>".repeat(beat.dots);
  if (beat.tupletNumerator > 0 && beat.tupletDenominator > 0 && beat.tupletNumerator !== 1) {
    xml += `<time-modification><actual-notes>${beat.tupletNumerator}</actual-notes><normal-notes>${beat.tupletDenominator}</normal-notes></time-modification>`;
  }
  if (note.isDead) xml += "<notehead>x</notehead>";
  else if (note.isGhost) xml += '<notehead parentheses="yes">normal</notehead>';

  const notations: string[] = [];
  if (note.isTieDestination) notations.push('<tied type="stop"/>');
  if (note.isTieOrigin) notations.push('<tied type="start"/>');
  if (stringed && note.string >= 1 && note.fret >= 0) {
    // MusicXML 的 1 弦是最高音弦，alphaTab 的 1 弦是最低音弦，需换算
    notations.push(
      `<technical><string>${stringCount - note.string + 1}</string><fret>${note.fret}</fret></technical>`,
    );
  }
  if (notations.length) xml += `<notations>${notations.join("")}</notations>`;
  return xml + "</note>";
}

function restXml(beat: model.Beat, voice: number, ticks: number): string {
  const typeName = TYPE_NAMES[beat.duration as number];
  return (
    `<note><rest/><duration>${ticks}</duration><voice>${voice}</voice>` +
    (typeName ? `<type>${typeName}</type>` : "") +
    "<dot/>".repeat(beat.dots) +
    "</note>"
  );
}

function measureXml(
  staff: model.Staff,
  barIndex: number,
  partFirstBar: boolean,
  useFlats: boolean,
  tabStaff: boolean,
): string {
  const bar = staff.bars[barIndex];
  const mb = bar.masterBar;
  const stringed = staff.isStringed && !staff.isPercussion;
  const stringCount = staff.tuning.length;
  const prev = mb.previousMasterBar;

  let xml = `<measure number="${mb.index + 1}"${mb.isAnacrusis ? ' implicit="yes"' : ""}>`;

  // 属性：divisions 只在首小节；调号/拍号在首小节或变化时写
  const attrs: string[] = [];
  if (partFirstBar) attrs.push(`<divisions>${DIVISIONS}</divisions>`);
  if (partFirstBar || (prev && prev.keySignature !== mb.keySignature)) {
    attrs.push(`<key><fifths>${mb.keySignature}</fifths></key>`);
  }
  if (
    partFirstBar ||
    (prev &&
      (prev.timeSignatureNumerator !== mb.timeSignatureNumerator ||
        prev.timeSignatureDenominator !== mb.timeSignatureDenominator))
  ) {
    attrs.push(
      `<time><beats>${mb.timeSignatureNumerator}</beats><beat-type>${mb.timeSignatureDenominator}</beat-type></time>`,
    );
  }
  if (partFirstBar) {
    if (stringed && !tabStaff) {
      // 标准五线谱：吉他惯用的低八度高音谱号，音高按实际发声写，谱面即正确八度
      attrs.push(`<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`);
    } else if (stringed) {
      attrs.push(`<clef><sign>TAB</sign><line>5</line></clef>`);
      let details = `<staff-details><staff-lines>${stringCount}</staff-lines>`;
      // staff-tuning 的 line 1 是谱表最底线（最低音弦）；alphaTab tuning[0] 是最高音弦
      for (let line = 1; line <= stringCount; line++) {
        const midi = staff.tuning[stringCount - line];
        const pc = ((midi % 12) + 12) % 12;
        const step = useFlats ? STEP_FLAT[pc] : STEP_SHARP[pc];
        const alter = useFlats ? ALTER_FLAT[pc] : ALTER_SHARP[pc];
        details +=
          `<staff-tuning line="${line}"><tuning-step>${step}</tuning-step>` +
          (alter !== 0 ? `<tuning-alter>${alter}</tuning-alter>` : "") +
          `<tuning-octave>${Math.floor(midi / 12) - 1}</tuning-octave></staff-tuning>`;
      }
      if (staff.capo > 0) details += `<capo>${staff.capo}</capo>`;
      details += `</staff-details>`;
      attrs.push(details);
    } else {
      attrs.push(`<clef><sign>${staff.isPercussion ? "percussion" : "G"}</sign></clef>`);
    }
  }
  if (attrs.length) xml += `<attributes>${attrs.join("")}</attributes>`;

  if (mb.isRepeatStart) {
    xml += `<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>`;
  }
  if (mb.section) {
    const marker = mb.section.marker ? `<rehearsal>${esc(mb.section.marker)}</rehearsal>` : "";
    const text = mb.section.text ? `<words>${esc(mb.section.text)}</words>` : "";
    if (marker || text) xml += `<direction placement="above"><direction-type>${marker}${text}</direction-type></direction>`;
  }
  const tempo = partFirstBar ? mb.score.tempo : mb.tempoAutomation?.value;
  if (tempo) {
    xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`;
  }

  const voices = bar.voices.filter((v) => !v.isEmpty);
  if (voices.length === 0) {
    xml += `<note><rest measure="yes"/><duration>${Math.round((DIVISIONS * 4 * mb.timeSignatureNumerator) / mb.timeSignatureDenominator)}</duration><voice>1</voice></note>`;
  }
  voices.forEach((v, vi) => {
    let written = 0;
    for (const beat of v.beats) {
      const grace = (beat.graceType as number) !== 0;
      const ticks = beatTicks(beat);
      if (beat.isRest) {
        if (grace) continue;
        xml += restXml(beat, vi + 1, ticks);
      } else {
        beat.notes.forEach((n, ni) => {
          xml += noteXml(n, beat, {
            isChord: ni > 0,
            stringed,
            stringCount,
            useFlats,
            voice: vi + 1,
            ticks,
          });
        });
      }
      if (!grace) written += ticks;
    }
    if (vi < voices.length - 1 && written > 0) {
      xml += `<backup><duration>${written}</duration></backup>`;
    }
  });

  if (mb.isRepeatEnd) {
    xml += `<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"${mb.repeatCount > 1 ? ` times="${mb.repeatCount}"` : ""}/></barline>`;
  } else if (barIndex === staff.bars.length - 1) {
    xml += `<barline location="right"><bar-style>light-heavy</bar-style></barline>`;
  }
  return xml + "</measure>";
}

export function scoreToMusicXml(score: model.Score, staffMode: "tab" | "standard" = "tab"): string {
  // 每个（音轨, 谱表）对导出为一个 part；GP 吉他轨通常只有一个谱表
  const parts: { id: string; name: string; track: model.Track; staff: model.Staff }[] = [];
  for (const track of score.tracks) {
    const staves = track.staves.filter((s) => s.bars.length > 0);
    staves.forEach((staff, si) => {
      parts.push({
        id: `P${track.index + 1}${staves.length > 1 ? `-${si + 1}` : ""}`,
        name: staves.length > 1 ? `${track.name} (${si + 1})` : track.name,
        track,
        staff,
      });
    });
  }

  const partList = parts
    .map(({ id, name, track }) => {
      const program = track.playbackInfo.program;
      return (
        `<score-part id="${id}"><part-name>${esc(name)}</part-name>` +
        `<score-instrument id="${id}-I1"><instrument-name>${esc(name)}</instrument-name></score-instrument>` +
        `<midi-instrument id="${id}-I1"><midi-channel>${(track.playbackInfo.primaryChannel % 16) + 1}</midi-channel><midi-program>${program + 1}</midi-program></midi-instrument>` +
        `</score-part>`
      );
    })
    .join("");

  const useFlats = (score.masterBars[0]?.keySignature ?? 0) < 0;
  const body = parts
    .map(({ id, staff }) => {
      let xml = `<part id="${id}">`;
      for (let i = 0; i < staff.bars.length; i++) {
        xml += measureXml(staff, i, i === 0, useFlats, staffMode === "tab");
      }
      return xml + "</part>";
    })
    .join("");

  const title = score.title || "Untitled";
  const creators =
    (score.artist ? `<creator type="composer">${esc(score.artist)}</creator>` : "") +
    (score.music ? `<creator type="lyricist">${esc(score.music)}</creator>` : "");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0">` +
    `<work><work-title>${esc(title)}</work-title></work>` +
    `<identification>${creators}<encoding><software>ScoreTranslate (alphaTab)</software></encoding></identification>` +
    `<part-list>${partList}</part-list>` +
    body +
    `</score-partwise>`
  );
}
