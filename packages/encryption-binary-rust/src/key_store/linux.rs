//! Linux key protection using TPM2 seal/unseal via tpm2-tools.
//!
//! Strategy:
//!   1. Create a TPM2 Storage Root Key (SRK) under the owner hierarchy
//!      (deterministic — same template always produces the same key)
//!   2. Seal the PKCS8 private key under the SRK using tpm2_create
//!   3. Store the sealed public/private blobs on disk
//!   4. To decrypt: recreate SRK, load sealed object, unseal
//!
//! The sealed blob can ONLY be unsealed by the same machine's TPM chip.
//! Survives reboots, survives logout — the TPM hardware is the anchor.
//!
//! Requirements:
//!   - TPM 2.0 hardware (present on most machines since ~2018)
//!   - tpm2-tools installed (tpm2_createprimary, tpm2_create, tpm2_load, tpm2_unseal)
//!   - Access to /dev/tpmrm0 (user must be in 'tss' group or have udev rule)
//!
//! Fallback: If TPM2 is not available, falls back to file-based (plaintext) storage.

use std::io::Write;
use std::process::Command;

/// Detailed result of TPM2 availability check.
pub enum Tpm2Status {
    /// TPM2 is available and ready to use
    Available,
    /// tpm2-tools not installed
    ToolsNotInstalled,
    /// /dev/tpmrm0 doesn't exist (no TPM hardware or not enabled in BIOS)
    NoDevice,
    /// /dev/tpmrm0 exists but not accessible (permission issue)
    PermissionDenied,
    /// TPM device exists but SRK creation failed (TPM in bad state?)
    SrkFailed(String),
}

/// Check if TPM2 is available and usable.
pub fn check_tpm2_status() -> Tpm2Status {
    // Check if tpm2_createprimary is in PATH
    if Command::new("which")
        .arg("tpm2_createprimary")
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true)
    {
        return Tpm2Status::ToolsNotInstalled;
    }

    // Check if TPM device exists
    let tpmrm = std::path::Path::new("/dev/tpmrm0");
    if !tpmrm.exists() {
        return Tpm2Status::NoDevice;
    }

    // Check if we can access it
    match std::fs::metadata(tpmrm) {
        Ok(_meta) => {
            // Try to actually use it with a quick SRK creation
            let tmp = std::env::temp_dir().join(format!("varlock-tpm-check-{}", std::process::id()));
            let result = Command::new("tpm2_createprimary")
                .args(["-C", "o", "-g", "sha256", "-G", "ecc256", "-c"])
                .arg(&tmp)
                .output();

            let _ = std::fs::remove_file(&tmp);

            match result {
                Ok(output) if output.status.success() => Tpm2Status::Available,
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if stderr.contains("Permission denied") || stderr.contains("TCTI") {
                        Tpm2Status::PermissionDenied
                    } else {
                        Tpm2Status::SrkFailed(stderr.to_string())
                    }
                }
                Err(_) => Tpm2Status::PermissionDenied,
            }
        }
        Err(_) => Tpm2Status::PermissionDenied,
    }
}

/// Simple check: is TPM2 available?
pub fn is_tpm2_available() -> bool {
    matches!(check_tpm2_status(), Tpm2Status::Available)
}

/// Protect a private key by sealing it with the TPM.
///
/// Returns a blob containing the sealed public + private portions,
/// which can only be unsealed by this machine's TPM.
///
/// Format: pub_len(4 LE) || pub_data || priv_data
pub fn tpm2_protect(private_key_der: &[u8]) -> Result<Vec<u8>, String> {
    let tmp_dir = std::env::temp_dir().join(format!("varlock-tpm-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let srk_ctx = tmp_dir.join("srk.ctx");
    let sealed_pub = tmp_dir.join("sealed.pub");
    let sealed_priv = tmp_dir.join("sealed.priv");
    let input_file = tmp_dir.join("input.dat");

    // Clean up on exit
    let _cleanup = CleanupDir(tmp_dir.clone());

    // Write private key to temp file (restricted permissions)
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&input_file)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        f.write_all(private_key_der)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
    }

    // Step 1: Create SRK (Storage Root Key) — deterministic
    run_tpm2_command(
        "tpm2_createprimary",
        &["-C", "o", "-g", "sha256", "-G", "ecc256", "-c"],
        Some(&srk_ctx),
    )?;

    // Step 2: Seal the private key under the SRK
    run_tpm2_command_with_args(
        "tpm2_create",
        &[
            "-C", srk_ctx.to_str().unwrap(),
            "-i", input_file.to_str().unwrap(),
            "-u", sealed_pub.to_str().unwrap(),
            "-r", sealed_priv.to_str().unwrap(),
        ],
    )?;

    // Step 3: Read the sealed blobs
    let pub_data = std::fs::read(&sealed_pub)
        .map_err(|e| format!("Failed to read sealed public blob: {e}"))?;
    let priv_data = std::fs::read(&sealed_priv)
        .map_err(|e| format!("Failed to read sealed private blob: {e}"))?;

    // Pack into a single blob: pub_len(4 LE) || pub_data || priv_data
    let mut output = Vec::with_capacity(4 + pub_data.len() + priv_data.len());
    output.extend_from_slice(&(pub_data.len() as u32).to_le_bytes());
    output.extend_from_slice(&pub_data);
    output.extend_from_slice(&priv_data);

    Ok(output)
}

/// Unprotect a private key by unsealing it with the TPM.
pub fn tpm2_unprotect(sealed_blob: &[u8]) -> Result<Vec<u8>, String> {
    if sealed_blob.len() < 4 {
        return Err("Sealed blob too short".into());
    }

    // Parse: pub_len(4 LE) || pub_data || priv_data
    let pub_len = u32::from_le_bytes(sealed_blob[..4].try_into().unwrap()) as usize;
    if sealed_blob.len() < 4 + pub_len {
        return Err("Sealed blob truncated".into());
    }
    let pub_data = &sealed_blob[4..4 + pub_len];
    let priv_data = &sealed_blob[4 + pub_len..];

    let tmp_dir = std::env::temp_dir().join(format!("varlock-tpm-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let srk_ctx = tmp_dir.join("srk.ctx");
    let sealed_pub = tmp_dir.join("sealed.pub");
    let sealed_priv = tmp_dir.join("sealed.priv");
    let sealed_ctx = tmp_dir.join("sealed.ctx");

    let _cleanup = CleanupDir(tmp_dir.clone());

    // Write sealed blobs to temp files
    std::fs::write(&sealed_pub, pub_data)
        .map_err(|e| format!("Failed to write sealed pub: {e}"))?;
    std::fs::write(&sealed_priv, priv_data)
        .map_err(|e| format!("Failed to write sealed priv: {e}"))?;

    // Step 1: Recreate SRK (deterministic — same params = same key)
    run_tpm2_command(
        "tpm2_createprimary",
        &["-C", "o", "-g", "sha256", "-G", "ecc256", "-c"],
        Some(&srk_ctx),
    )?;

    // Step 2: Load the sealed object
    run_tpm2_command_with_args(
        "tpm2_load",
        &[
            "-C", srk_ctx.to_str().unwrap(),
            "-u", sealed_pub.to_str().unwrap(),
            "-r", sealed_priv.to_str().unwrap(),
            "-c", sealed_ctx.to_str().unwrap(),
        ],
    )?;

    // Step 3: Unseal
    let output = Command::new("tpm2_unseal")
        .args(["-c", sealed_ctx.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run tpm2_unseal: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("TPM2 unseal failed: {stderr}"));
    }

    Ok(output.stdout)
}

// ── Helpers ──────────────────────────────────────────────────────

fn run_tpm2_command(cmd: &str, args: &[&str], ctx_path: Option<&std::path::Path>) -> Result<(), String> {
    let mut command = Command::new(cmd);
    command.args(args);
    if let Some(ctx) = ctx_path {
        command.arg(ctx);
    }

    let output = command
        .output()
        .map_err(|e| format!("Failed to run {cmd}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{cmd} failed: {stderr}"));
    }

    Ok(())
}

fn run_tpm2_command_with_args(cmd: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {cmd}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{cmd} failed: {stderr}"));
    }

    Ok(())
}

/// RAII cleanup for temp directories.
struct CleanupDir(std::path::PathBuf);

impl Drop for CleanupDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Get a user-friendly hint about why TPM2 isn't available.
pub fn get_tpm2_setup_hint() -> Option<String> {
    match check_tpm2_status() {
        Tpm2Status::Available => None,
        Tpm2Status::ToolsNotInstalled => Some(
            "TPM2 hardware may be available but tpm2-tools is not installed.\n\
             Install with: sudo apt install tpm2-tools (Debian/Ubuntu)\n\
             or: sudo dnf install tpm2-tools (Fedora)\n\
             or: sudo pacman -S tpm2-tools (Arch)"
                .into(),
        ),
        Tpm2Status::NoDevice => Some(
            "No TPM2 device found (/dev/tpmrm0). TPM may need to be enabled in BIOS.".into(),
        ),
        Tpm2Status::PermissionDenied => Some(
            "TPM2 device exists but access denied.\n\
             Add your user to the tss group: sudo usermod -aG tss $USER\n\
             Then log out and back in."
                .into(),
        ),
        Tpm2Status::SrkFailed(e) => Some(format!(
            "TPM2 device accessible but key creation failed: {e}"
        )),
    }
}
