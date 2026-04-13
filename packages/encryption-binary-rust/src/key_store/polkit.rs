//! Linux biometric / user-presence verification via polkit.
//!
//! Polkit delegates auth to PAM, so whatever factors the user has configured
//! (fingerprint via fprintd, face via Howdy, YubiKey via pam_u2f, or just the
//! login password) are what get used. This gives us broad biometric coverage
//! without integrating with each provider separately.
//!
//! Requires:
//!   - polkit installed (`pkcheck` in PATH — present on every desktop distro)
//!   - Our policy file installed at /usr/share/polkit-1/actions/
//!     (run `varlock-local-encrypt setup-linux-biometrics` once with sudo)
//!
//! The pkcheck invocation uses the (PID, start-time, UID) process spec rather
//! than a bare PID — modern polkit rejects bare PIDs due to reuse risk.

use std::process::Command;

pub const POLKIT_ACTION_ID: &str = "io.varlock.local-encrypt.decrypt";
pub const POLKIT_POLICY_PATH: &str =
    "/usr/share/polkit-1/actions/io.varlock.local-encrypt.policy";

pub const POLKIT_POLICY_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC
 "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>Varlock</vendor>
  <vendor_url>https://varlock.dev</vendor_url>
  <action id="io.varlock.local-encrypt.decrypt">
    <description>Decrypt Varlock-encrypted secrets</description>
    <message>Authentication required to decrypt Varlock secrets</message>
    <defaults>
      <allow_any>auth_self</allow_any>
      <allow_inactive>auth_self</allow_inactive>
      <allow_active>auth_self_keep</allow_active>
    </defaults>
  </action>
</policyconfig>
"#;

/// Is `pkcheck` on PATH?
pub fn has_pkcheck() -> bool {
    Command::new("pkcheck")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Is our polkit action registered (policy file present)?
pub fn is_action_registered() -> bool {
    std::path::Path::new(POLKIT_POLICY_PATH).exists()
}

/// Is polkit-based user-presence verification fully available?
pub fn is_available() -> bool {
    has_pkcheck() && is_action_registered()
}

/// Read the current process's (start-time, uid) — required by modern polkit
/// to avoid PID-reuse attacks.
fn process_spec() -> Result<String, String> {
    let stat = std::fs::read_to_string("/proc/self/stat")
        .map_err(|e| format!("Failed to read /proc/self/stat: {e}"))?;
    // Field 2 (comm) can contain spaces and parens, so scan past the last ')'.
    let after_comm = stat
        .rfind(')')
        .ok_or_else(|| "Malformed /proc/self/stat".to_string())?;
    let tail: Vec<&str> = stat[after_comm + 1..].split_whitespace().collect();
    // After ')', field 3 is at index 0 → starttime (field 22) is at index 19.
    let starttime = tail
        .get(19)
        .ok_or_else(|| "Missing starttime in /proc/self/stat".to_string())?;
    let pid = std::process::id();
    // SAFETY: getuid() is always safe.
    let uid = unsafe { libc::getuid() };
    Ok(format!("{pid},{starttime},{uid}"))
}

/// Prompt the user to authenticate. Returns Ok(true) on success,
/// Ok(false) if the user cancelled or was denied.
pub fn check_authorization() -> Result<bool, String> {
    let spec = process_spec()?;
    let output = Command::new("pkcheck")
        .args([
            "--action-id",
            POLKIT_ACTION_ID,
            "--process",
            &spec,
            "--allow-user-interaction",
        ])
        .output()
        .map_err(|e| format!("Failed to run pkcheck: {e}"))?;

    if output.status.success() {
        return Ok(true);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    // pkcheck exits non-zero for both "not authorized" and real errors.
    // Treat known "denied / not authorized" as a cancel, everything else as err.
    let s = stderr.to_lowercase();
    if s.contains("not authorized") || s.contains("dismissed") || s.contains("cancel") {
        Ok(false)
    } else if stderr.trim().is_empty() {
        Ok(false)
    } else {
        Err(stderr.trim().to_string())
    }
}

/// Write the polkit policy file. Requires root.
pub fn install_policy() -> Result<(), String> {
    let path = std::path::Path::new(POLKIT_POLICY_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create polkit actions dir: {e}"))?;
    }
    std::fs::write(path, POLKIT_POLICY_XML)
        .map_err(|e| format!("Failed to write polkit policy (need root?): {e}"))?;
    Ok(())
}

/// Remove the polkit policy file. Requires root.
pub fn uninstall_policy() -> Result<(), String> {
    let path = std::path::Path::new(POLKIT_POLICY_PATH);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path)
        .map_err(|e| format!("Failed to remove polkit policy (need root?): {e}"))
}

/// Status hint for `varlock encrypt status`.
pub fn get_setup_hint() -> Option<String> {
    if !has_pkcheck() {
        return Some(
            "polkit not installed — biometric unlock unavailable. \
             Install with: sudo apt install policykit-1 (Debian/Ubuntu), \
             sudo dnf install polkit (Fedora), or sudo pacman -S polkit (Arch)."
                .into(),
        );
    }
    if !is_action_registered() {
        return Some(
            "Biometric unlock (fingerprint/face/YubiKey via PAM) is available but not enabled.\n\
             Run once to enable: sudo varlock-local-encrypt setup-linux-biometrics"
                .into(),
        );
    }
    None
}
