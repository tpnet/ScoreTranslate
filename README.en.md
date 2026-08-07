# ScoreTranslate

[简体中文](README.md) | English

A local sheet-music format converter that runs as a web app: pick a score file, convert it to another format, download the result. Everything happens on your own machine — no file is ever uploaded to an external service.

## Conversion matrix

| Input | Output |
| --- | --- |
| `.mid` `.midi` `.gp` `.gpx` `.gp3` `.gp4` `.gp5` `.mxl` `.musicxml` `.xml` | `.mid` `.musicxml` `.xml` `.mxl` `.gp` `.gp5` `.mscz` `.pdf` `.png` `.png` long image |

Maximum 50MB per file. PNG is exported page by page and zipped automatically when the score spans multiple pages; "PNG long image" stitches all pages vertically into a single image.

Some targets accept export options: DPI and margin trimming for PNG, paper size and scaling for PDF, repeat unrolling for MIDI, and staff type (tablature / standard notation) for MusicXML, PDF and PNG.

## Prerequisites

You need [bun](https://bun.sh) and [MuseScore 4](https://musescore.org) — MuseScore acts as a conversion engine and must be installed locally.

The default MuseScore path is the macOS one, `/Applications/MuseScore 4.app/Contents/MacOS/mscore`. On other platforms, or if you installed it elsewhere, override it with an environment variable:

```bash
export MSCORE_PATH=/your/path/to/mscore
```

## Running

```bash
bun install && bun run dev
```

Then open http://localhost:3000 .

## HTTP API

Besides the UI you can call the endpoint directly. `POST /api/convert` takes a multipart form with the fields `file` and `target`:

```bash
curl -O -J -F "file=@score.gp5" -F "target=pdf" http://localhost:3000/api/convert
```

On success it returns a file stream, with the filename in the `Content-Disposition` and `X-Filename` response headers. On failure it returns JSON: `{"error": "..."}`.

Export options are passed as optional form fields; invalid values are silently ignored: `dpi` (50–1200), `trim` (0–500, margin in pixels), `scale` (50–200), `paper` (`a4` / `letter`), `staffMode` (`tab` / `standard`), `unrollRepeats` (`1`).

## Known limitations

**gp3 / gp4 / gpx are input-only.** Any software that opens gp3/gp4 also opens gp5, so a dedicated writer would only serve long-obsolete versions; gpx is GP6's proprietary BCFZ container and GP6 itself has been abandoned by the vendor. The `.gp` output is Guitar Pro 7/8 format, produced by alphaTab.

**`.gp5` output comes from a from-scratch writer** (no existing open-source implementation was available). It preserves notes, rhythms, ties, tuplets, dynamics, time and key signatures, repeat marks, tunings and capo position. It does not preserve playing techniques (bends, slides, harmonics, …) or chord diagrams. When the source is not a guitar score (MIDI or piano MusicXML), the writer picks a 6-string guitar, 7-string or bass tuning based on the pitch range and assigns string/fret positions automatically, folding out-of-range notes by octaves. Non-ASCII metadata such as titles degrades to `?` — a limitation of the GP5 format's encoding.

**MIDI-to-notation conversion has a quality ceiling.** MIDI carries no engraving information (voice separation, ties, enharmonic spelling of accidentals), so the result is inferred by MuseScore's quantization. Scores converted from performance-recorded MIDI usually need manual cleanup. This is inherent to the format, not to this tool.

## Layout

- `lib/convert.ts` — conversion core and routing; `.gp` / `.gp5` targets are exported via a MusicXML bridge
- `lib/gp5-writer.ts` — GP5 binary writer, including the string/fret assignment algorithm
- `lib/gp-to-musicxml.ts` — Guitar Pro model → MusicXML serializer, preserving TAB staves and string/fret data
- `app/api/convert/route.ts` — conversion endpoint: validation and file-stream response
- `app/page.tsx` — single-page UI for upload, target selection and download

## License

[MIT](LICENSE)
