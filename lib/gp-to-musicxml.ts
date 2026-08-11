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

// DynamicValue 枚举下标 → MusicXML dynamics 元素名（顺序与 alphaTab 枚举一致）
const DYNAMIC_NAMES = [
  "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "pppp", "ppppp", "pppppp",
  "ffff", "fffff", "ffffff", "sf", "sfp", "sfpp", "fp", "rf", "rfz", "sfz",
  "sffz", "fz", "n", "pf", "sfzp",
];
const LEFT_FINGERS = ["T", "1", "2", "3", "4"]; // Fingers 枚举 0=Thumb..4=Little
const PLUCK_FINGERS = ["p", "i", "m", "a", "c"];
const TREMOLO_MARKS: Record<number, number> = { 8: 1, 16: 2, 32: 3 };

const words = (text: string, italic = false) =>
  `<direction placement="above"><direction-type><words${italic ? ' font-style="italic"' : ""}>${text}</words></direction-type></direction>`;
const wedge = (type: string) =>
  `<direction><direction-type><wedge type="${type}"/></direction-type></direction>`;

// 推弦：不看 bendType，直接由点列推导——起始值>0 写预推，有上推写峰值，
// 末值低于峰值写释放。bendPoint.value 单位是 1/4 音，bend-alter 单位是半音
function bendXml(note: model.Note): string {
  const pts = note.bendPoints;
  if (!pts || pts.length === 0) return "";
  const semis = (v: number) => String(v / 2);
  const first = pts[0].value;
  const peak = Math.max(...pts.map((p) => p.value));
  const last = pts[pts.length - 1].value;
  let xml = "";
  if (first > 0) xml += `<bend><bend-alter>${semis(first)}</bend-alter><pre-bend/></bend>`;
  if (peak > first) xml += `<bend><bend-alter>${semis(peak)}</bend-alter></bend>`;
  if (last < peak) xml += `<bend><bend-alter>${semis(last)}</bend-alter><release/></bend>`;
  return xml;
}

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
  // 并发连线/滑音按弦编号区分（击勾弦和滑音的两端总在同一根弦上）
  const lineNo = stringed && note.string >= 1 ? stringCount - note.string + 1 : 1;
  // 滑音（shift/legato）：起点写 start，终点凭 slideOrigin 写 stop
  if (note.slideOrigin && ((note.slideOrigin.slideOutType as number) === 1 || (note.slideOrigin.slideOutType as number) === 2)) {
    notations.push(`<slide type="stop" number="${lineNo}"/>`);
  }
  if ((note.slideOutType as number) === 1 || (note.slideOutType as number) === 2) {
    notations.push(`<slide type="start" number="${lineNo}"/>`);
  }
  // MuseScore 4 导入时忽略 hammer-on/pull-off 元素，只认 slur 弧线；
  // 因此连线用 slur 写出，hammer-on/pull-off 元素照写供 Guitar Pro 等识别
  if (note.isHammerPullOrigin && note.hammerPullDestination) {
    notations.push(`<slur type="start" number="${lineNo}"/>`);
  }
  if (note.isHammerPullDestination && note.hammerPullOrigin) {
    notations.push(`<slur type="stop" number="${lineNo}"/>`);
  }

  const first = !isChord; // beat 级技巧只写在和弦首音上，避免重复

  const tech: string[] = [];
  if (stringed && note.string >= 1 && note.fret >= 0) {
    // MusicXML 的 1 弦是最高音弦，alphaTab 的 1 弦是最低音弦，需换算
    tech.push(`<string>${stringCount - note.string + 1}</string><fret>${note.fret}</fret>`);
  }
  // 击弦/勾弦：GP 只有一个 hammer/pull 标记，按终点品位高低区分
  if (note.isHammerPullOrigin && note.hammerPullDestination) {
    const tag = note.hammerPullDestination.fret > note.fret ? "hammer-on" : "pull-off";
    tech.push(`<${tag} type="start" number="1">${tag === "hammer-on" ? "H" : "P"}</${tag}>`);
  }
  if (note.isHammerPullDestination && note.hammerPullOrigin) {
    const tag = note.fret > note.hammerPullOrigin.fret ? "hammer-on" : "pull-off";
    tech.push(`<${tag} type="stop" number="1"/>`);
  }
  tech.push(bendXml(note));
  if ((note.harmonicType as number) !== 0) {
    tech.push(`<harmonic>${(note.harmonicType as number) === 1 ? "<natural/>" : "<artificial/>"}</harmonic>`);
  }
  if (note.isLeftHandTapped) tech.push('<tap hand="left">T</tap>');
  if (first && beat.tap) tech.push("<tap/>");
  if (first && beat.pop) tech.push("<snap-pizzicato/>");
  if (first && (beat.golpe as number) !== 0) tech.push("<golpe/>");
  if (first && (beat.pickStroke as number) === 2) tech.push("<down-bow/>");
  if (first && (beat.pickStroke as number) === 1) tech.push("<up-bow/>");
  if ((note.leftHandFinger as number) >= 0) tech.push(`<fingering>${LEFT_FINGERS[note.leftHandFinger as number]}</fingering>`);
  if ((note.rightHandFinger as number) >= 0) tech.push(`<pluck>${PLUCK_FINGERS[note.rightHandFinger as number]}</pluck>`);
  const techXml = tech.join("");
  if (techXml) notations.push(`<technical>${techXml}</technical>`);

  const orns: string[] = [];
  if (note.isTrill) orns.push("<trill-mark/>");
  if ((note.vibrato as number) !== 0 || (first && (beat.vibrato as number) !== 0)) {
    orns.push('<wavy-line type="start"/><wavy-line type="stop"/>');
  }
  if (first && beat.isTremolo && beat.tremoloSpeed != null) {
    orns.push(`<tremolo type="single">${TREMOLO_MARKS[beat.tremoloSpeed as number] ?? 3}</tremolo>`);
  }
  if (orns.length) notations.push(`<ornaments>${orns.join("")}</ornaments>`);

  const artics: string[] = [];
  if (note.isStaccato) artics.push("<staccato/>");
  if ((note.accentuated as number) === 1) artics.push("<accent/>");
  if ((note.accentuated as number) === 2) artics.push("<strong-accent/>");
  if ((note.accentuated as number) === 3) artics.push("<tenuto/>");
  // 滑入：下方滑入 → scoop，上方滑入 → plop
  if ((note.slideInType as number) === 1) artics.push("<scoop/>");
  if ((note.slideInType as number) === 2) artics.push("<plop/>");
  // 无目标音的滑出/拨片滑弦：向上 → doit，向下 → falloff
  const so = note.slideOutType as number;
  if (so === 3 || so === 6) artics.push("<doit/>");
  if (so === 4 || so === 5) artics.push("<falloff/>");
  if (artics.length) notations.push(`<articulations>${artics.join("")}</articulations>`);

  // 扫弦/琶音：GP 是 beat 级标记，MusicXML 要求写在和弦每个音上
  if ((beat.brushType as number) !== 0) {
    notations.push(`<arpeggiate direction="${(beat.brushType as number) % 2 === 1 ? "up" : "down"}"/>`);
  }
  if (notations.length) xml += `<notations>${notations.join("")}</notations>`;
  // 歌词是 beat 级，写在和弦首音上
  if (first && beat.lyrics) {
    beat.lyrics.forEach((line, li) => {
      if (line) xml += `<lyric number="${li + 1}"><syllabic>single</syllabic><text>${esc(line)}</text></lyric>`;
    });
  }
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
  partLastBar: boolean,
  useFlats: boolean,
  tabStaff: boolean,
  state: { dyn: number; wedge: number },
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
    // 闷音/延音按连续段标记：段首写一次文字（GP 是逐音符标记，谱面惯例是段首标注）
    let prevPalmMute = false;
    let prevLetRing = false;
    for (const beat of v.beats) {
      const grace = (beat.graceType as number) !== 0;
      const ticks = beatTicks(beat);
      if (beat.isRest) {
        if (grace) continue;
        prevPalmMute = false;
        prevLetRing = false;
        xml += restXml(beat, vi + 1, ticks);
      } else {
        const palmMute = beat.notes.some((n) => n.isPalmMute);
        if (palmMute && !prevPalmMute) xml += words("P.M.", true);
        prevPalmMute = palmMute;
        const letRing = beat.notes.some((n) => n.isLetRing);
        if (letRing && !prevLetRing) xml += words("let ring", true);
        prevLetRing = letRing;
        if (beat.slap) xml += words("slap");
        if ((beat.rasgueado as number) !== 0) xml += words("rasg.", true);
        if ((beat.whammyBarType as number) !== 0) xml += words("w/bar");
        if (beat.text) xml += words(esc(beat.text));
        // 力度与渐强渐弱只在声部 1 写一份，避免多声部重复标记
        if (vi === 0) {
          const dyn = beat.dynamics as number;
          if (dyn !== state.dyn) {
            if (state.dyn >= 0 && DYNAMIC_NAMES[dyn]) {
              xml += `<direction placement="below"><direction-type><dynamics><${DYNAMIC_NAMES[dyn]}/></dynamics></direction-type></direction>`;
            }
            state.dyn = dyn;
          }
          // 渐强/渐弱跨小节跟踪（state.wedge），连续段只写一条楔形线
          const cres = beat.crescendo as number;
          if (cres !== state.wedge) {
            if (state.wedge) xml += wedge("stop");
            if (cres) xml += wedge(cres === 1 ? "crescendo" : "diminuendo");
            state.wedge = cres;
          }
        }
        // fade in/out/swell：围绕该拍写一对楔形线
        const fade = beat.fade as number;
        if (fade) xml += wedge(fade === 2 ? "diminuendo" : "crescendo");
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
        if (fade) xml += wedge("stop");
      }
      if (!grace) written += ticks;
    }
    if (vi === 0 && partLastBar && state.wedge) {
      xml += wedge("stop");
      state.wedge = 0;
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
      // 力度与渐强渐弱跨小节跟踪，只在变化时写记号
      const state = { dyn: -1, wedge: 0 };
      for (let i = 0; i < staff.bars.length; i++) {
        xml += measureXml(staff, i, i === 0, i === staff.bars.length - 1, useFlats, staffMode === "tab", state);
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
