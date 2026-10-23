// 桌面版直接加载 Vite 静态资源；乐谱算法在 Worker，原生能力通过 IPC 调用。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod render;
#[cfg(target_os = "macos")]
use std::{process::Command, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    WebviewUrl, WebviewWindowBuilder,
};

#[tauri::command]
async fn render_score(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("缺少文件内容".into());
    };
    if bytes.len() > render::MAX_SIZE {
        return Err("文件超过 50MB 限制".into());
    }
    let options = request
        .headers()
        .get("x-score-options")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少导出参数")?;
    let options: render::RenderRequest =
        serde_json::from_str(options).map_err(|_| "导出参数无效")?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        render::render(&bytes, &options).map(Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mscore_status() -> Result<render::MuseScoreStatus, String> {
    tauri::async_runtime::spawn_blocking(render::status)
        .await
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![render_score, mscore_status])
        .setup(|app| {
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("乐谱格式转换")
                    .inner_size(960.0, 900.0)
                    .disable_drag_drop_handler();
            // WKWebView 没有下载界面，不设处理器时 <a download> 会被直接取消。
            // 沿用默认保存位置（「下载」文件夹，重名自动编号），完成后在访达中选中文件。
            // Windows 的 WebView2 自带下载气泡，设了处理器反而会被隐藏，所以只管 macOS
            #[cfg(target_os = "macos")]
            let builder = {
                use tauri::webview::DownloadEvent;
                // macOS 的 Finished 事件拿不到保存路径，只能在 Requested 时记下
                let saved = Mutex::new(None);
                builder.on_download(move |_, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            *saved.lock().unwrap() = Some(destination.clone());
                        }
                        DownloadEvent::Finished { success: true, .. } => {
                            if let Some(path) = saved.lock().unwrap().take() {
                                let _ = Command::new("open").arg("-R").arg(path).status();
                            }
                        }
                        _ => {}
                    }
                    true
                })
            };

            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
