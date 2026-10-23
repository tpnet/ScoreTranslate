# ScoreTranslate

[简体中文](README.md) | English · [Website](https://tpnet.github.io/ScoreTranslate/)

A React + Vite sheet-music converter for the web and Tauri desktop. Desktop conversion runs locally; the web version uses its companion server. Running that server locally keeps files on your machine.

## Conversion matrix

| Input | Output |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` `.json` `.atex` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.json` `.atex` `.mscz` `.pdf` `.png` `.png` long image |

Maximum 50MB per file. PNG is exported page by page and zipped automatically when the score spans multiple pages; "PNG long image" stitches all pages vertically into a single image. `.json` is [alphaTab](https://alphatab.net)'s serialized score model, handy for rendering in the browser or further processing; `.atex` is alphaTab's text notation format, [alphaTex](https://alphatab.net/docs/alphatex/syntax), which you can write by hand — syntax errors are reported with their line and column.

Some targets accept export options: DPI and margin trimming for PNG, paper size and scaling for PDF, repeat unrolling for MIDI, staff type (tablature / standard notation) for MusicXML, PDF and PNG, and lyric merging for lead-sheet style scores. Multi-track scores can also be narrowed down to selected tracks, which works for every target format.

For PDF with the original staff layout, if MuseScore cannot produce a PDF directly from Guitar Pro input, conversion retries through MusicXML, retaining the original standard notation / tablature visibility. Incorrect durations in recognition drafts still need manual correction against the source score.

## Prerequisites

You need [bun](https://bun.sh) and [MuseScore 4](https://musescore.org) — MuseScore acts as a conversion engine and must be installed locally.

By default the official installer locations are used: `/Applications/MuseScore 4.app/Contents/MacOS/mscore` on macOS and `C:\Program Files\MuseScore 4\bin\MuseScore4.exe` on Windows. If you installed it elsewhere, override it with an environment variable:

```bash
export MSCORE_PATH=/your/path/to/mscore
```

## Running

```bash
bun install && bun run dev
```

Then open http://localhost:3000 . Vite serves the frontend and proxies `/api` to the Bun API on port 3001.

Production:

```bash
bun run build
bun run start
```

Bun serves both `dist/` and the API, listening on `127.0.0.1:3000` by default. Configure `HOSTNAME` / `PORT` and an HTTPS reverse proxy for remote deployment. MuseScore must be installed on the server; browser users do not need it. Hosting only `dist/` does not provide full conversion support.

## Desktop app

The desktop app loads static assets and calls Rust through Tauri IPC. It bundles no Bun, Node.js or Next.js and starts no local HTTP server. The macOS arm64 DMG is approximately 2.5MB and the installed app approximately 4.9MB; Bun is not required.

**MuseScore 4 must still be installed separately.** Without it, conversion between Guitar Pro / JSON / alphaTex and export to MusicXML remain available. Score processing runs in a Worker; Rust handles MuseScore and file operations. Long PNG export decodes one page at a time and retains the 100-million-pixel limit.

Building requires the [Rust](https://rustup.rs) toolchain and only produces a package for the host platform:

```bash
bun install && bun tauri build
```

Output goes to `src-tauri/target/release/bundle/` (`dmg/` on macOS, `nsis/` on Windows). macOS 13 or later is required.

The `desktop` GitHub Actions workflow supports manual builds and automatically builds and uploads all platform packages when a Release is published. Windows includes both `ScoreTranslate_<version>_x64-setup.exe` and `ScoreTranslate_<version>_x64-portable.exe`; extracting the main executable from the installer is no longer necessary. Manual builds only save Actions artifacts and do not modify a Release. Update the project version before publishing and use the matching `v<version>` Release tag. The portable EXE requires an installed WebView2 Runtime; MuseScore 4 remains a separate dependency.

The app is not signed with a paid certificate, so the OS blocks the first launch: on macOS go to System Settings → Privacy & Security and click "Open Anyway" (or run `xattr -dr com.apple.quarantine /Applications/ScoreTranslate.app`); on Windows click "More info → Run anyway" in the SmartScreen prompt.

## Verification

```bash
bun run build            # TypeScript + Vite
bun run verify           # Real HTTP conversions, requires MuseScore 4
bun run verify --native  # Same cases through Rust; builds the native verification entry
bun tauri dev            # Desktop development window
```

Checks cover all output formats, track selection, TAB, JSON/alphaTex, MIDI/MusicXML bridging, multipage PNG and long images, GP5 readback through two independent parsers, and invalid inputs. The conversion engine is not mocked.

## HTTP API

Besides the UI you can call the endpoint directly. `POST /api/convert` takes a multipart form with the fields `file` and `target`:

```bash
curl -O -J -F "file=@score.gp5" -F "target=pdf" http://localhost:3000/api/convert
```

On success it returns a file stream, with the filename in the `Content-Disposition` and `X-Filename` response headers. On failure it returns JSON: `{"error": "..."}`.

Export options are passed as optional form fields; invalid values are silently ignored: `dpi` (50–1200), `trim` (0–500, margin in pixels), `scale` (50–200), `paper` (`a4` / `letter`), `staffMode` (`tab` / `standard`), `unrollRepeats` (`1`), `mergeLyrics` (`1`, copies the vocal track's lyrics onto the other tracks, time-aligned), `tracks` (comma-separated track indices; exports only those, all tracks by default).

The indices for `tracks` come from `POST /api/tracks`, which takes the same `file` field and returns `{"tracks": ["Track name", ...]}` — the array order is the index:

```bash
curl -F "file=@score.gp5" http://localhost:3000/api/tracks
```

## Known limitations

**gp3 / gp4 / gpx are input-only.** Any software that opens gp3/gp4 also opens gp5, so a dedicated writer would only serve long-obsolete versions; gpx is GP6's proprietary BCFZ container and GP6 itself has been abandoned by the vendor. The `.gp` output is Guitar Pro 7/8 format, produced by alphaTab.

**`.gp5` output comes from a from-scratch writer** (no existing open-source implementation was available). It preserves notes, rhythms, ties, tuplets, dynamics, time and key signatures, repeat marks, tunings and capo position, plus playing techniques (bends, hammer-ons and pull-offs, slides, harmonics, palm mutes, let ring, vibrato, grace notes, strums, staccato, accents, fingering, …) — except what the GP5 format cannot express, such as left-hand taps and pick slides. Chord diagrams are not preserved. When the source is not a guitar score (MIDI or piano MusicXML), the writer picks a 6-string guitar, 7-string or bass tuning based on the pitch range and assigns string/fret positions automatically, folding out-of-range notes by octaves. Non-ASCII text such as titles and lyrics degrades to `?` — a limitation of the GP5 format's encoding — so for non-Latin lyrics prefer MusicXML, pdf or png targets.

**MIDI-to-notation conversion has a quality ceiling.** MIDI carries no engraving information (voice separation, ties, enharmonic spelling of accidentals), so the result is inferred by MuseScore's quantization. Scores converted from performance-recorded MIDI usually need manual cleanup. This is inherent to the format, not to this tool.

## Layout

- `lib/convert.ts` — conversion core and routing; Guitar Pro input is parsed directly, everything else goes through a MusicXML bridge
- `lib/gp5-writer.ts` — GP5 binary writer, including the string/fret assignment algorithm
- `lib/gp-to-musicxml.ts` — Guitar Pro model → MusicXML serializer, preserving TAB staves and string/fret data
- `server/convert.ts` — conversion endpoint: validation and file-stream response
- `server/tracks.ts` — track-name listing endpoint, used by the UI's track picker
- `src/App.tsx` — single-page UI for upload, target selection and download
- `src/convert.worker.ts` — desktop background processing using `lib/convert.ts`
- `src/platform.ts` — web HTTP / desktop IPC entry
- `server/render.ts` — web MuseScore and PNG adapter
- `src-tauri/src/render.rs` — native MuseScore, temporary files, PNG/ZIP
- `src-tauri/` — Tauri static frontend and native commands, without a server runtime

## License

[MIT](LICENSE)

## LL / GP timeline JSON

Upload a LL `lyrics-*.json` song detail file or a two-dimensional `*.gp.json` timeline, then select Guitar Pro (.gp). File-index-only `song.json` files are not supported. Titles, artist and tempo are read from raw songs; timelines default to 120 BPM. Override tempo with the “歌曲速度 BPM” field or HTTP `jsonTempo` (20–400).

Raw songs currently support 4/4 and default to C4 (MIDI 60), without applying device `tone/leadNote` offsets. Use “原始谱八度” / HTTP `jsonMiddleC` to select C3 (48), C4 (60) or C5 (72); timeline MIDI pitches are unchanged. Tracks, lyrics, chords, sections and tied note durations are preserved. Tuning and string/fret assignments are validated before GP serialization; unsupported ranges fail explicitly instead of silently transposing or dropping notes. Existing track selection and lyric merging remain available on both platforms.

`*.gp.json` downloads use the song basename, e.g. `song.gp.json` → `song.gp`. For a real timeline/GP readback comparison:

```bash
bun scripts/verify-song-gp.ts input.gp.json output.gp
```

The upstream real-song check found a MuseScore tie-import difference for one final sustained note; alphaTab readback preserved the tie. Guitar Pro desktop audio still requires manual listening confirmation.
