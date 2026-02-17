#[cfg(not(debug_assertions))]
use std::process::{Child, Command, Stdio};
#[cfg(not(debug_assertions))]
use std::sync::Mutex;
#[cfg(not(debug_assertions))]
use tauri::Manager;

#[cfg(not(debug_assertions))]
struct LocalServerState(Mutex<Option<Child>>);

#[cfg(not(debug_assertions))]
fn spawn_local_server(app: &tauri::AppHandle) -> Result<Child, String> {
  let server_script = app
    .path()
    .resolve("server.mjs", tauri::path::BaseDirectory::Resource)
    .map_err(|error| format!("failed to resolve bundled server.mjs: {error}"))?;

  Command::new("node")
    .arg(server_script)
    .env("NEURAL_COMPUTER_SERVER_PORT", "8787")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("failed to spawn local API server: {error}"))
}

#[cfg(not(debug_assertions))]
fn stop_local_server(app: &tauri::AppHandle) {
  if let Some(state) = app.try_state::<LocalServerState>() {
    if let Ok(mut guard) = state.0.lock() {
      if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
      }
      *guard = None;
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default().setup(|app| {
    #[cfg(debug_assertions)]
    {
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
    }

    #[cfg(not(debug_assertions))]
    {
      let child =
        spawn_local_server(&app.handle()).map_err(|error| std::io::Error::other(error))?;
      app.manage(LocalServerState(Mutex::new(Some(child))));
    }

    Ok(())
  });

  let app = builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|_app, event| match event {
      tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
        #[cfg(not(debug_assertions))]
        stop_local_server(_app);
      }
      _ => {}
    });
}
