// 桌面版外壳：用随包附带的 bun 启动 Next.js standalone 服务，再开窗口加载它。
// 转换逻辑全在服务端（lib/convert.ts），这里只管进程、窗口和下载
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);

fn start_server(dir: &Path, port: u16) -> std::io::Result<Child> {
    // externalBin 打包后和主程序在同一目录，文件名已去掉目标三元组后缀
    let bun = std::env::current_exe()?.with_file_name(if cfg!(windows) { "bun.exe" } else { "bun" });
    let mut cmd = Command::new(bun);
    cmd.arg("server.js")
        .current_dir(dir)
        // standalone 默认监听 0.0.0.0，会把转换接口暴露给局域网，限定为本机
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        // GUI 程序没有可用的标准输出，继承给子进程可能导致写日志出错
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台窗口
    }
    cmd.spawn()
}

// 端口能连上即视为就绪。不发 HTTP 请求：请求页面会触发 MuseScore 版本检测
fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        if Instant::now() > deadline {
            return Err("内置服务启动超时".into());
        }
        sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // 让系统分配空闲端口，避免和开发服务器等冲突
            let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
            let child = start_server(&app.path().resource_dir()?.join("server"), port)?;
            app.manage(Server(Mutex::new(Some(child))));
            wait_for_port(port)?;

            let url = format!("http://127.0.0.1:{port}").parse()?;
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("乐谱格式转换")
                .inner_size(960.0, 900.0)
                // 交给页面自己的 HTML5 拖拽上传，Tauri 默认会拦截文件拖放
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
