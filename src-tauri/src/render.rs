use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufReader, Cursor},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

pub const MAX_SIZE: usize = 50 * 1024 * 1024;
const MAX_LONG_PIXELS: u64 = 100_000_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub input_ext: String,
    pub target: String,
    pub dpi: Option<u32>,
    pub trim: Option<u32>,
    pub unroll_repeats: Option<bool>,
    pub style: Option<String>,
}

#[derive(Serialize)]
pub struct MuseScoreStatus {
    path: String,
    major: Option<u32>,
}

fn mscore_path() -> PathBuf {
    if let Some(path) = std::env::var_os("MSCORE_PATH") {
        return path.into();
    }
    #[cfg(target_os = "windows")]
    return PathBuf::from(
        std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()),
    )
    .join("MuseScore 4/bin/MuseScore4.exe");
    #[cfg(target_os = "macos")]
    return PathBuf::from("/Applications/MuseScore 4.app/Contents/MacOS/mscore");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return PathBuf::from("mscore");
}

fn command() -> Command {
    let mut cmd = Command::new(mscore_path());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn run(cmd: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 MuseScore，可通过 MSCORE_PATH 指定路径：{e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            // MuseScore 退出阶段可能崩溃；由调用方检查产物，不检查退出码。
            Ok(Some(_)) => return Ok(()),
            Ok(None) if start.elapsed() < timeout => sleep(Duration::from_millis(50)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(e) => format!("MuseScore 进程错误：{e}"),
                    _ => "MuseScore 转换超时，请减小文件后重试".into(),
                });
            }
        }
    }
}

pub fn status() -> MuseScoreStatus {
    let major = (|| -> Option<u32> {
        let dir = tempfile::tempdir().ok()?;
        let output = dir.path().join("version.txt");
        let file = fs::File::create(&output).ok()?;
        run(command().arg("-v").stdout(file), Duration::from_secs(10)).ok()?;
        let text = fs::read_to_string(output).ok()?;
        text.split_whitespace().find_map(|word| {
            let (major, rest) = word.split_once('.')?;
            if !rest.starts_with(|c: char| c.is_ascii_digit()) {
                return None;
            }
            major.parse().ok()
        })
    })();
    MuseScoreStatus {
        path: mscore_path().to_string_lossy().into_owned(),
        major,
    }
}

pub fn render(input: &[u8], request: &RenderRequest) -> Result<Vec<u8>, String> {
    if input.len() > MAX_SIZE {
        return Err("文件超过 50MB 限制".into());
    }
    if ![
        "mid", "midi", "gp", "gpx", "gp3", "gp4", "gp5", "mxl", "musicxml", "xml",
    ]
    .contains(&request.input_ext.as_str())
    {
        return Err("不支持的输入格式".into());
    }
    if ![
        "musicxml", "xml", "mxl", "mid", "mscz", "pdf", "png", "png-long",
    ]
    .contains(&request.target.as_str())
    {
        return Err("不支持的目标格式".into());
    }
    if request.dpi.is_some_and(|v| !(50..=1200).contains(&v))
        || request.trim.is_some_and(|v| v > 500)
        || request.style.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return Err("导出参数超出范围".into());
    }
    let dir = tempfile::Builder::new()
        .prefix("score-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let in_path = dir.path().join(format!("input.{}", request.input_ext));
    let ext = match request.target.as_str() {
        "xml" => "musicxml",
        "png-long" => "png",
        other => other,
    };
    let out_path = dir.path().join(format!("output.{ext}"));
    fs::write(&in_path, input).map_err(|e| e.to_string())?;
    let mut cmd = command();
    cmd.arg(&in_path).arg("-o").arg(&out_path);
    if ext == "png" {
        if let Some(dpi) = request.dpi {
            cmd.arg("-r").arg(dpi.to_string());
        }
        if let Some(trim) = request.trim {
            cmd.arg("-T").arg(trim.to_string());
        }
    }
    if ext == "mid" && request.unroll_repeats == Some(true) {
        cmd.arg("--unroll-repeats");
    }
    if ext == "pdf" {
        if let Some(style) = &request.style {
            let style_path = dir.path().join("style.mss");
            fs::write(&style_path, style).map_err(|e| e.to_string())?;
            cmd.arg("-S").arg(style_path);
        }
    }
    run(&mut cmd, Duration::from_secs(120))?;
    if ext != "png" {
        return fs::read(out_path)
            .map_err(|_| format!("转换失败：MuseScore 未生成 {} 文件", request.target));
    }
    let mut pages: Vec<(u32, PathBuf)> = fs::read_dir(dir.path())
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let n = name
                .strip_prefix("output-")?
                .strip_suffix(".png")?
                .parse()
                .ok()?;
            Some((n, path))
        })
        .collect();
    pages.sort_by_key(|(n, _)| *n);
    if pages.is_empty() {
        return Err("PNG 导出失败：未生成页面".into());
    }
    if request.target == "png-long" {
        return stitch_pages(
            &pages
                .iter()
                .map(|(_, path)| path.as_path())
                .collect::<Vec<_>>(),
        );
    }
    if pages.len() == 1 {
        return fs::read(&pages[0].1).map_err(|e| e.to_string());
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (n, path) in pages {
        zip.start_file(
            format!("output-{n}.png"),
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(|e| e.to_string())?;
        std::io::copy(
            &mut fs::File::open(path).map_err(|e| e.to_string())?,
            &mut zip,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}

pub fn stitch_pages(pages: &[&Path]) -> Result<Vec<u8>, String> {
    let mut width = 0_u32;
    let mut height = 0_u64;
    for path in pages {
        let reader = png::Decoder::new(BufReader::new(
            fs::File::open(path).map_err(|e| e.to_string())?,
        ))
        .read_info()
        .map_err(|e| e.to_string())?;
        width = width.max(reader.info().width);
        height += u64::from(reader.info().height);
    }
    if width == 0 || height == 0 || height > MAX_LONG_PIXELS / u64::from(width) {
        return Err(format!(
            "长图尺寸过大或无效（{width}×{height} 像素，上限 100 百万像素），请降低 DPI 或减少页数"
        ));
    }
    let mut rgb = vec![255; width as usize * height as usize * 3];
    let mut y = 0;
    for path in pages {
        let mut decoder = png::Decoder::new(BufReader::new(
            fs::File::open(path).map_err(|e| e.to_string())?,
        ));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        decoder.set_limits(png::Limits {
            bytes: (MAX_LONG_PIXELS * 4) as usize,
        });
        let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
        let mut data = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut data).map_err(|e| e.to_string())?;
        let channels = info.color_type.samples();
        for row in 0..info.height as usize {
            for x in 0..info.width as usize {
                let si = (row * info.width as usize + x) * channels;
                let di = ((y + row) * width as usize + x) * 3;
                let alpha = match info.color_type {
                    png::ColorType::Rgba => data[si + 3],
                    png::ColorType::GrayscaleAlpha => data[si + 1],
                    _ => 255,
                } as u32;
                for c in 0..3 {
                    let v = data[si + if channels <= 2 { 0 } else { c }] as u32;
                    rgb[di + c] = ((v * alpha + 255 * (255 - alpha)) / 255) as u8;
                }
            }
        }
        y += info.height as usize;
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(&rgb)
            .map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}
