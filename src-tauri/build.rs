fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_state",
            "desktop_components",
            "desktop_components_cancel",
            "desktop_components_open",
            "desktop_autostart",
            "desktop_choose_legacy",
            "desktop_pick_directory",
            "desktop_logs",
            "desktop_start",
            "desktop_update_status",
            "desktop_update_operation",
            "desktop_update_cancel",
            "desktop_server_restart",
            "desktop_quit",
            "desktop_update_check",
            "desktop_update_install",
            "desktop_notification_preferences",
        ]),
    ))
    .expect("Desktop command permissions could not be generated");
}
