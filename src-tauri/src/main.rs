#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    configure_linux_renderer();

    agent_k_lib::run();
}

#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    // Respect WebKitGTK's native override first. AgentK's setting provides a
    // clearer three-state switch without changing upstream WebKit semantics.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }

    let mode = std::env::var("AGENT_K_WEBKIT_RENDERER")
        .unwrap_or_else(|_| "auto".into())
        .to_ascii_lowercase();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::path::Path::new("/sys/module/nvidia").exists();
    let nvidia_driver_healthy = !nvidia
        || std::process::Command::new("nvidia-smi")
            .arg("-L")
            .output()
            // A working NVIDIA installation may omit the management CLI.
            // Only treat an installed command that reports failure as broken.
            .map_or(true, |output| output.status.success());

    if wayland && nvidia && std::env::var_os("WEBKIT_GST_DMABUF_SINK_DISABLED").is_none() {
        // Do not pass decoded video frames to WebKit's media sink as DMA-BUFs
        // on NVIDIA. Some YUV layouts are imported as solid green frames.
        std::env::set_var("WEBKIT_GST_DMABUF_SINK_DISABLED", "1");
    }
    if wayland && nvidia && std::env::var_os("WEBKIT_GST_DISABLE_GL_SINK").is_none() {
        // Disabling the media sink's DMA-BUF support alone still leaves
        // WebKitGLVideoSink's GL upload/conversion path active. Its NVIDIA
        // path can produce the same green H.264 frames from system memory.
        // Force WebKit's BGRA/BGRx fallback video sink instead. This affects
        // video presentation only; the web view remains GPU accelerated.
        std::env::set_var("WEBKIT_GST_DISABLE_GL_SINK", "1");
    }

    // DMA-BUF is normally the faster path and noticeably improves scrolling
    // and panel resizing. Fall back automatically only when NVIDIA's loaded
    // kernel module and userspace libraries cannot communicate (commonly
    // after a driver update before rebooting).
    let use_compatibility_renderer = match mode.as_str() {
        "compatible" => true,
        "accelerated" => false,
        // Unknown values intentionally retain the automatic behavior.
        _ => wayland && nvidia && !nvidia_driver_healthy,
    };
    if use_compatibility_renderer {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    } else if wayland && nvidia && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        // WebKitGTK can submit an NVIDIA DMA-BUF without an acquire point and
        // be disconnected by the Wayland compositor with protocol error 71.
        // Disabling NVIDIA's explicit-sync path keeps DMA-BUF acceleration
        // while avoiding that upstream interoperability bug.
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}
