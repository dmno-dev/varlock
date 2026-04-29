//! Windows Hello biometric verification.
//!
//! Uses the WinRT `UserConsentVerifier` API to show the Windows Hello dialog
//! (face recognition, fingerprint, or PIN). This is the same dialog that
//! Windows uses for login and app authentication.
//!
//! The verification is decoupled from key storage (DPAPI handles that).
//! This module purely handles user presence verification.

use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};

/// Check if Windows Hello is available and configured.
pub fn is_hello_available() -> bool {
    match UserConsentVerifier::CheckAvailabilityAsync() {
        Ok(op) => match op.get() {
            Ok(availability) => availability == UserConsentVerifierAvailability::Available,
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Detailed availability check for status reporting.
pub fn get_hello_status() -> HelloStatus {
    match UserConsentVerifier::CheckAvailabilityAsync() {
        Ok(op) => match op.get() {
            Ok(availability) => match availability {
                UserConsentVerifierAvailability::Available => HelloStatus::Available,
                UserConsentVerifierAvailability::DeviceNotPresent => HelloStatus::NoDevice,
                UserConsentVerifierAvailability::NotConfiguredForUser => HelloStatus::NotConfigured,
                UserConsentVerifierAvailability::DisabledByPolicy => HelloStatus::DisabledByPolicy,
                _ => HelloStatus::Unknown,
            },
            Err(e) => HelloStatus::Error(format!("{e}")),
        },
        Err(e) => HelloStatus::Error(format!("{e}")),
    }
}

pub enum HelloStatus {
    Available,
    NoDevice,
    NotConfigured,
    DisabledByPolicy,
    Unknown,
    Error(String),
}

/// Request user verification via Windows Hello.
///
/// Shows the Windows Hello dialog with the given message.
/// Returns Ok(true) if verified, Ok(false) if cancelled, Err on failure.
pub fn verify_user(message: &str) -> Result<bool, String> {
    // The daemon is windowless, so the Hello prompt would normally be blocked
    // from coming to the foreground (Windows focus-stealing prevention) and
    // would only appear as a flashing taskbar item. Granting ASFW_ANY lets
    // the prompt window foreground itself.
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
        const ASFW_ANY: u32 = 0xFFFFFFFF;
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }

    let message = windows::core::HSTRING::from(message);

    let op = UserConsentVerifier::RequestVerificationAsync(&message)
        .map_err(|e| format!("Failed to request verification: {e}"))?;

    let result = op.get().map_err(|e| format!("Verification failed: {e}"))?;

    match result {
        UserConsentVerificationResult::Verified => Ok(true),
        UserConsentVerificationResult::Canceled => Ok(false),
        UserConsentVerificationResult::DeviceNotPresent => {
            Err("Windows Hello device not present".into())
        }
        UserConsentVerificationResult::NotConfiguredForUser => {
            Err("Windows Hello not configured".into())
        }
        UserConsentVerificationResult::DisabledByPolicy => {
            Err("Windows Hello disabled by policy".into())
        }
        UserConsentVerificationResult::DeviceBusy => Err("Windows Hello device busy".into()),
        UserConsentVerificationResult::RetriesExhausted => {
            Err("Windows Hello retries exhausted".into())
        }
        _ => Err("Unknown verification result".into()),
    }
}

/// Get a setup hint if Windows Hello could be available.
pub fn get_setup_hint() -> Option<String> {
    match get_hello_status() {
        HelloStatus::Available => None,
        HelloStatus::NoDevice => Some(
            "No Windows Hello compatible device found.\n\
             Windows Hello requires a fingerprint reader, IR camera, or compatible security key."
                .into(),
        ),
        HelloStatus::NotConfigured => Some(
            "Windows Hello is available but not set up.\n\
             Configure it in Settings > Accounts > Sign-in options."
                .into(),
        ),
        HelloStatus::DisabledByPolicy => Some(
            "Windows Hello is disabled by group policy.".into(),
        ),
        _ => None,
    }
}
