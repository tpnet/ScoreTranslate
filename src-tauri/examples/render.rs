// 真实文件回归入口，复用桌面端的原生实现，不启动窗口。
#[path = "../src/render.rs"]
mod render;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("status") {
        println!(
            "{}",
            serde_json::to_string(&render::status()).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("stitch") && args.len() >= 4 {
        let pages: Vec<_> = args[2..args.len() - 1]
            .iter()
            .map(std::path::Path::new)
            .collect();
        let output = render::stitch_pages(&pages)?;
        return std::fs::write(args.last().unwrap(), output).map_err(|e| e.to_string());
    }
    if args.len() != 4 {
        return Err("用法：render input request-json output".into());
    }
    let input = std::fs::read(&args[1]).map_err(|e| e.to_string())?;
    let request = serde_json::from_str(&args[2]).map_err(|e| e.to_string())?;
    let output = render::render(&input, &request)?;
    std::fs::write(&args[3], output).map_err(|e| e.to_string())
}
