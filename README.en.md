# ScoreTranslate

[简体中文](README.md) | English · [Website](https://tpnet.github.io/ScoreTranslate/)

A local sheet-music format converter that runs as a web app: pick a score file, convert it to another format, download the result. Everything happens on your own machine — no file is ever uploaded to an external service.

## Conversion matrix

| Input | Output |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` `.json` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.json` `.mscz` `.pdf` `.png` `.png` long image |

Maximum 50MB per file. PNG is exported page by page and zipped automatically when the score spans multiple pages; "PNG long image" stitches all pages vertically into a single image. `.json` is [alphaTab](https://alphatab.net)'s serialized score model, handy for rendering in the browser or further processing.

Some targets accept export options: DPI and margin trimming for PNG, paper size and scaling for PDF, repeat unrolling for MIDI, staff type (tablature / standard notation) for MusicXML, PDF and PNG, and lyric merging for lead-sheet style scores. Multi-track scores can also be narrowed down to selected tracks, which works for every target format.

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

Then open http://localhost:3000 .

## Desktop app

The project can also be packaged as a macOS / Windows desktop app (Tauri, ~32MB installer on macOS). It ships its own runtime, so no bun is needed — just double-click. **MuseScore 4 still has to be installed separately**; without it only Guitar Pro → MusicXML / gp / gp5 works.

Building requires the [Rust](https://rustup.rs) toolchain and only produces a package for the host platform:

```bash
bun install && bun tauri build
```

Output goes to `src-tauri/target/release/bundle/` (`dmg/` on macOS, `nsis/` on Windows). The Windows package can also be built by manually running the `desktop` workflow in GitHub Actions. macOS 13 or later is required.

The app is not signed with a paid certificate, so the OS blocks the first launch: on macOS go to System Settings → Privacy & Security and click "Open Anyway" (or run `xattr -dr com.apple.quarantine /Applications/ScoreTranslate.app`); on Windows click "More info → Run anyway" in the SmartScreen prompt.

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
- `app/api/convert/route.ts` — conversion endpoint: validation and file-stream response
- `app/api/tracks/route.ts` — track-name listing endpoint, used by the UI's track picker
- `app/page.tsx` — single-page UI for upload, target selection and download
- `src-tauri/` — desktop shell: starts the Next.js standalone server with the bundled bun, then opens a window on it

## License

[MIT](LICENSE)
