# ScoreTranslate

[简体中文](README.md) | English · [Website](https://tpnet.github.io/ScoreTranslate/) · [Download desktop app](https://github.com/tpnet/ScoreTranslate/releases)

A sheet-music converter for Guitar Pro, MusicXML, MIDI, song JSON and more, with PDF and PNG export.

Desktop conversion runs locally. The web version processes files on its companion server; running that server locally keeps files on your machine. React + Vite powers the frontend, Bun serves the web app, and Tauri powers the desktop app. Both share a TypeScript conversion core, with no database.

[Supported formats](#supported-formats) · [Get started](#get-started) · [Song JSON to Guitar Pro](#song-json-to-guitar-pro) · [HTTP API](#http-api) · [Development and verification](#development-and-verification) · [Known limitations](#known-limitations)

## Supported formats

| Type | Input | Output |
| --- | --- | --- |
| Guitar Pro | `.gp` `.gpx` `.gp3` `.gp4` `.gp5` | `.gp` (GP7/8) `.gp5` (GP5 v5.00) |
| MusicXML | `.musicxml` `.xml` `.mxl` | `.musicxml` `.xml` `.mxl` |
| MIDI | `.mid` `.midi` | `.mid` |
| JSON | LL raw song details, two-dimensional GP timelines, alphaTab score models | alphaTab score model `.json` |
| alphaTex | `.atex` | `.atex` |
| MuseScore / documents / images | — | `.mscz` `.pdf` `.png`, long PNG |

Maximum **50 MB** per file. `.json` output always uses the [alphaTab](https://alphatab.net) score model; it does not recreate LL or timeline structures. [alphaTex](https://alphatab.net/docs/alphatex/syntax) is a text notation format you can write by hand; syntax errors include line and column information.

Select tracks and configure export options as needed:

| Target | Options |
| --- | --- |
| All formats | Export selected tracks only |
| MusicXML / PDF / PNG | Tablature or standard notation |
| PDF | Paper size, score scaling, or original staff layout |
| PNG / long PNG | DPI, margin trimming, or original staff layout |
| MIDI | Unroll repeats |
| GP / GP5 / MusicXML / PDF / PNG | Merge vocal lyrics onto other tracks, aligned by time |

PNG returns an image for a single page and a ZIP for multiple pages. Long PNG stitches pages vertically; exports exceeding **100 million pixels** fail with an error. Lower the DPI to retry.

## Get started

### Desktop app

Download the appropriate file from [Releases](https://github.com/tpnet/ScoreTranslate/releases):

| Platform | Package / requirements |
| --- | --- |
| macOS Apple Silicon / Intel | DMG for the appropriate architecture; macOS 13 or later |
| Windows x64 | `ScoreTranslate_<version>_x64-setup.exe` installer or `ScoreTranslate_<version>_x64-portable.exe`; the portable app requires an installed WebView2 Runtime |

The desktop app needs neither Bun nor Node.js and starts no local HTTP server. **Install MuseScore 4 separately.** Without it, conversion between Guitar Pro / JSON / alphaTex and export to MusicXML still work; other conversions require MuseScore.

The app has no formal developer signing or notarization. If the OS blocks the first launch:

- macOS: open System Settings → Privacy & Security and select “Open Anyway”.
- Windows: select “More info → Run anyway” in the SmartScreen prompt.

### Run the web app locally

Install [Bun](https://bun.sh) and [MuseScore 4](https://musescore.org), then run these commands in the project directory:

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). Vite serves the development frontend and proxies `/api` to the Bun API on local port `3001`.

### Production deployment

```bash
bun run build
bun run start
```

Bun serves both `dist/` and the conversion API, listening on `127.0.0.1:3000` by default. For remote deployment, explicitly set `HOSTNAME` / `PORT` and configure an HTTPS reverse proxy. Install MuseScore on the server; browser users do not need it. Hosting only `dist/` does not provide full conversion support.

### Configure the MuseScore path

The web and desktop apps use the same default lookup locations:

| System | Default path |
| --- | --- |
| macOS | `/Applications/MuseScore 4.app/Contents/MacOS/mscore` |
| Windows | `%ProgramFiles%\MuseScore 4\bin\MuseScore4.exe` |
| Other systems | `mscore` on `PATH` |

If MuseScore is installed elsewhere, set `MSCORE_PATH` to its version 4 executable in the environment that starts the service or app. For example, in a macOS / Linux terminal:

```bash
export MSCORE_PATH="/your/path/to/mscore"
```

## Song JSON to Guitar Pro

Upload a song JSON file and choose **Guitar Pro (.gp)** to create a GP7/8 file. Two song input formats are supported:

| Input | Metadata and tempo | Pitch settings |
| --- | --- | --- |
| LL raw song details `lyrics-*.json` | Reads title, artist and BPM; currently supports 4/4 only | `note=1, upOctave=0` defaults to C4 (MIDI 60), without applying `tone/leadNote` offsets |
| Two-dimensional GP timeline `*.gp.json` | No tempo metadata; defaults to 120 BPM, so enter the original tempo | Already contains MIDI pitches; octave settings do not apply |

File-index-only `song.json` files are unsupported. Override either input's tempo using the “歌曲速度 BPM” field or HTTP `jsonTempo` (20–400 BPM). If a raw song sounds an octave off, use “原始谱八度” to select C3 / C4 / C5, corresponding to HTTP `jsonMiddleC=48/60/72`.

Conversion preserves separate tracks, lyrics, chords and sections, using ties to retain overlapping notes and notes spanning barlines. Track selection and lyric merging remain available. Tuning, string and fret data are assigned before export; conversion fails if it cannot fit all notes or would have to change their pitches.

Device sounds, automatic accompaniment and extended control events are not converted; melody tracks initially use piano sounds. Velocities map to GP's supported dynamic levels, and the importer normalizes leading and trailing lyric whitespace. See [known limitations](#known-limitations) for playback differences between applications.

## HTTP API

These endpoints are provided by the web app. Start the development or production server first.

### Convert a file

`POST /api/convert` accepts a multipart form with required fields `file` and `target`:

```bash
curl -f -O -J \
  -F "file=@score.gp5" \
  -F "target=pdf" \
  http://localhost:3000/api/convert
```

Supported `target` values: `mid`, `musicxml`, `xml`, `mxl`, `gp`, `gp5`, `json`, `atex`, `mscz`, `pdf`, `png`, `png-long`.

Success returns a file stream. Read the filename from `Content-Disposition` or URL-decode the `X-Filename` header; multipage PNG returns a `.zip`. Failure returns a non-2xx status and JSON `{"error":"..."}`.

Optional form fields apply only to the relevant inputs or targets:

| Field | Values | Purpose |
| --- | --- | --- |
| `tracks` | Comma-separated zero-based track indices, e.g. `0,2` | All targets; exports all tracks by default. Get indices from `/api/tracks` |
| `dpi` | 50–1200 | PNG resolution; defaults to 360 for regular PNG and 150 for long PNG |
| `trim` | 0–500 | Pixel margin retained after trimming PNG whitespace |
| `paper` | `a4` / `letter` | PDF paper size; uses the source setting by default |
| `scale` | 50–200 | PDF score scaling percentage; 100 is the original size |
| `staffMode` | `tab` / `standard` | Tablature or standard notation for MusicXML / PDF / PNG; PDF / PNG use the original layout by default, while Guitar Pro family inputs default to tablature for MusicXML |
| `unrollRepeats` | `1` | Unroll MIDI repeats |
| `mergeLyrics` | `1` | Merge lyrics for GP / GP5 / MusicXML / PDF / PNG |
| `jsonTempo` | 20–400 | Override song JSON BPM |
| `jsonMiddleC` | MIDI C pitches from 0–120 (multiples of 12) | Octave reference for LL raw details; defaults to 60, commonly 48 / 60 / 72. Does not affect timelines |

Numeric fields are rounded and clamped to the ranges above. Empty or unparseable numeric values and invalid enum values are ignored. If the resulting `jsonMiddleC` is not a C pitch, LL import fails with an error.

### Read tracks

`POST /api/tracks` accepts `file` and returns `{"tracks":["Track name", "..."]}`. Array positions are the indices for `tracks`:

```bash
curl -f -F "file=@score.gp5" http://localhost:3000/api/tracks
```

### Check the conversion engine

`GET /api/status` returns `{"path":"MuseScore executable path","major":4}`. If no version is detected, `major` is `null`.

## Development and verification

### Common commands

```bash
bun run build            # TypeScript checks + Vite static build
bun run verify           # Real web HTTP regression checks; requires MuseScore 4
bun run verify --native  # Same cases through Rust; builds the native verification entry
bun tauri dev            # Desktop development window; requires Rust
bun tauri build          # Build desktop packages for the current platform; requires Rust
```

Desktop builds require [Rust](https://rustup.rs) and the platform's Tauri build dependencies. Run `bun install` first. Output goes to `src-tauri/target/release/bundle/`, with macOS DMGs in `dmg/` and Windows installers in `nsis/`.

The `desktop` GitHub Actions workflow supports manual builds for macOS Apple Silicon, macOS Intel and Windows x64. Publishing a Release automatically builds and uploads installers and the Windows portable app. Manual runs only save Actions artifacts. Synchronize project version numbers before publishing and use a matching `v<version>` Release tag.

Regression checks cover all output formats, track selection, TAB, song JSON / alphaTab JSON / alphaTex, MIDI / MusicXML bridging, multipage PNG and long images, GP5 readback through two independent parsers, and invalid inputs. They use real files and MuseScore, with no mocked conversion engine.

After converting a two-dimensional GP timeline to GP, run the dedicated readback check to compare pitches, start/end ticks, lyrics, chords, tuning and string/fret data. Leave track selection and lyric merging disabled when checking the complete score:

```bash
bun scripts/verify-song-gp.ts /path/to/source.gp.json /path/to/output.gp
```

### Project layout

| Path | Responsibility |
| --- | --- |
| `lib/convert.ts` | Shared conversion core, routing and track filtering |
| `lib/song-json.ts` | LL / two-dimensional GP timeline JSON input adapter |
| `lib/gp5-writer.ts` | GP5 binary writer, tuning and string/fret assignment |
| `lib/gp-to-musicxml.ts` | MusicXML serializer preserving TAB staves and string/fret data |
| `lib/formats.ts` / `lib/request.ts` | Format definitions, export options and upload validation |
| `src/App.tsx` | Upload, format and option selection, download UI |
| `src/platform.ts` / `src/convert.worker.ts` | Web HTTP / desktop IPC entry points and desktop background conversion |
| `server/` | Bun HTTP server, conversion / track endpoints and MuseScore / PNG adapter |
| `src-tauri/` | Static frontend packaging, Rust commands and MuseScore / PNG / ZIP adapter |
| `scripts/` | Development launcher and real-file verification |

Guitar Pro family inputs (JSON / alphaTex are first converted to GP) are parsed directly by alphaTab. MusicXML export uses a custom serializer to retain TAB, tunings and string/fret data. Other conversions use MuseScore 4 for parsing or rendering; non-GP inputs are bridged through MusicXML before GP / GP5 / alphaTex export.

When PDF uses the original staff layout and MuseScore cannot render Guitar Pro directly, conversion retries through MusicXML, preserving standard notation / tablature visibility. On desktop, the shared core runs in a Worker, while Rust handles MuseScore and file operations.

## Known limitations

- **Legacy formats are input-only:** `.gp3` / `.gp4` / `.gpx` cannot be exported. `.gp` output is GP7/8; `.gp5` output is GP5 v5.00.
- **GP5 has format and encoding limits:** the custom writer preserves notes, rhythms, ties, tuplets, dynamics, time/key signatures, repeats, tuning, capo position, and techniques including bends, hammer-ons/pull-offs, slides, harmonics, palm mutes and vibrato. Chord diagrams are not retained; effects GP5 cannot express are downgraded or skipped. Non-ASCII titles, lyrics and other text become `?`; use MusicXML / PDF / PNG for Chinese lyrics. MIDI or piano MusicXML exported to GP5 receives automatic tuning and string/fret assignments; out-of-range notes may be folded by octaves. The song JSON path instead fails if pitches would change.
- **MIDI and recognized scores need manual correction:** MIDI lacks voice, tie and accidental-spelling information, so MuseScore infers notation through quantization. Performance recordings and recognized drafts still need checking against the original score.
- **Song JSON playback across apps still needs confirmation:** alphaTab readback of the historical “普通朋友” sample retained all 957 notes' pitches and start/end times, but MuseScore 4 split one tied note near the end into two attacks. Playback and ties have not been manually checked in the Guitar Pro desktop app.

## License

[MIT](LICENSE)
