use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Handle tray yang disimpan supaya bisa diperbarui dari frontend.
struct Tray(Mutex<Option<TrayIcon>>);

/// Teks singkat untuk menu bar (macOS) dan tooltip (Windows/Linux).
/// Contoh: "Ashar 15:12 · 1j 20m"
#[tauri::command]
fn update_tray(text: String, tooltip: String, tray: State<Tray>) -> Result<(), String> {
    let guard = tray.0.lock().map_err(|e| e.to_string())?;
    if let Some(icon) = guard.as_ref() {
        // set_title hanya berefek di macOS (teks di menu bar). Di platform lain diabaikan.
        icon.set_title(Some(text.as_str())).map_err(|e| e.to_string())?;
        icon.set_tooltip(Some(tooltip.as_str())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Tray(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![update_tray])
        .on_window_event(|window, event| {
            // Tutup jendela = sembunyikan, aplikasi tetap berjalan di tray
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Tanpa ikon di Dock (khusus macOS), seperti aplikasi menu bar
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Buka Quran Insight", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("ikon default tidak ditemukan")?;

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Quran Insight")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            *app.state::<Tray>().0.lock().map_err(|e| e.to_string())? = Some(tray);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
