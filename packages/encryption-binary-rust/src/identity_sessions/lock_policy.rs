//! What ends an unlock session, short of its TTL running out.
//!
//! A port of `SessionLockPolicy.swift`. The hard cap and explicit invalidation
//! are not covered here: those always apply. This only decides which system
//! events erase a session's key material, and where that decision came from.

use serde_json::Value;

/// Which system events erase a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLockPolicy {
    /// Erase on screen lock and on sleep.
    ScreenLock,
    /// Erase on sleep only. Sessions survive the screen locking.
    Sleep,
    /// Erase only on TTL expiry, the 12h cap, or an explicit lock.
    None,
}

/// Used when neither the session nor the machine config says otherwise.
pub const BUILT_IN_DEFAULT_LOCK_POLICY: SessionLockPolicy = SessionLockPolicy::Sleep;

/// Key path into the machine config file: `{ "sessions": { "lockOn": "sleep" } }`
pub const CONFIG_SECTION_KEY: &str = "sessions";
pub const CONFIG_FIELD_KEY: &str = "lockOn";

impl SessionLockPolicy {
    pub fn wire_value(&self) -> &'static str {
        match self {
            SessionLockPolicy::ScreenLock => "screenLock",
            SessionLockPolicy::Sleep => "sleep",
            SessionLockPolicy::None => "none",
        }
    }

    pub fn from_wire_value(value: &str) -> Option<Self> {
        match value {
            "screenLock" => Some(SessionLockPolicy::ScreenLock),
            "sleep" => Some(SessionLockPolicy::Sleep),
            "none" => Some(SessionLockPolicy::None),
            _ => None,
        }
    }

    /// Every value a caller may send, for error messages.
    pub fn wire_values() -> [&'static str; 3] {
        ["screenLock", "sleep", "none"]
    }

    pub fn erases_on(&self, event: SessionLockEvent) -> bool {
        match self {
            SessionLockPolicy::ScreenLock => true,
            SessionLockPolicy::Sleep => event == SessionLockEvent::Sleep,
            SessionLockPolicy::None => false,
        }
    }
}

/// A system event that may end sessions, depending on their policy.
///
/// Only [`super::lock_events`] constructs these, and only on the platforms that
/// have a source for them, so a macOS development build has no producer for
/// `ScreenLock`. The policy rules still have to know about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(any(target_os = "linux", target_os = "windows")),
    allow(dead_code)
)]
pub enum SessionLockEvent {
    /// The machine is going to sleep.
    Sleep,
    /// The screen locked, or the login session was locked.
    ScreenLock,
}

impl SessionLockEvent {
    pub fn wire_value(&self) -> &'static str {
        match self {
            SessionLockEvent::Sleep => "sleep",
            SessionLockEvent::ScreenLock => "screenLock",
        }
    }
}

/// Where an effective policy came from, for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockPolicySource {
    SessionOverride,
    MachineConfig,
    BuiltInDefault,
}

impl LockPolicySource {
    pub fn wire_value(&self) -> &'static str {
        match self {
            LockPolicySource::SessionOverride => "session-override",
            LockPolicySource::MachineConfig => "machine-config",
            LockPolicySource::BuiltInDefault => "built-in-default",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedLockPolicy {
    pub policy: SessionLockPolicy,
    pub source: LockPolicySource,
}

/// Resolve the effective lock policy for one unlock.
///
/// Order is: what this unlock asked for, then the machine config, then the
/// built-in default. Anything unparseable is reported and skipped rather than
/// failing the unlock, so a typo in a config file cannot lock someone out of
/// their own secrets.
pub fn resolve_lock_policy(
    override_wire_value: Option<&str>,
    machine_config_data: Option<&[u8]>,
    warn: &mut dyn FnMut(&str),
) -> ResolvedLockPolicy {
    if let Some(raw) = override_wire_value.filter(|value| !value.is_empty()) {
        match SessionLockPolicy::from_wire_value(raw) {
            Some(policy) => {
                return ResolvedLockPolicy { policy, source: LockPolicySource::SessionOverride }
            }
            None => warn(&invalid_value_message(raw, "unlock-session lockOn")),
        }
    }

    if let Some(policy) = machine_lock_policy(machine_config_data, warn) {
        return ResolvedLockPolicy { policy, source: LockPolicySource::MachineConfig };
    }

    ResolvedLockPolicy {
        policy: BUILT_IN_DEFAULT_LOCK_POLICY,
        source: LockPolicySource::BuiltInDefault,
    }
}

/// Read `sessions.lockOn` out of the user-level config file's contents.
///
/// A missing file, a missing section, or a missing field all mean "not
/// configured", silently. Only a value that is present and wrong is worth
/// saying something about.
pub fn machine_lock_policy(
    data: Option<&[u8]>,
    warn: &mut dyn FnMut(&str),
) -> Option<SessionLockPolicy> {
    let data = data.filter(|bytes| !bytes.is_empty())?;

    let Ok(json) = serde_json::from_slice::<Value>(data) else {
        warn("could not parse the varlock config file; ignoring it for session lock settings");
        return None;
    };
    let sessions = json.get(CONFIG_SECTION_KEY)?.as_object()?;
    let raw = sessions.get(CONFIG_FIELD_KEY)?;

    let Some(raw_string) = raw.as_str() else {
        warn(&invalid_value_message(
            &raw.to_string(),
            &format!("config {CONFIG_SECTION_KEY}.{CONFIG_FIELD_KEY}"),
        ));
        return None;
    };
    match SessionLockPolicy::from_wire_value(raw_string) {
        Some(policy) => Some(policy),
        None => {
            warn(&invalid_value_message(
                raw_string,
                &format!("config {CONFIG_SECTION_KEY}.{CONFIG_FIELD_KEY}"),
            ));
            None
        }
    }
}

/// The default warning sink: one line on stderr, same wording as the Swift side.
pub fn warn_on_stderr(message: &str) {
    eprintln!("varlock: {message}");
}

fn invalid_value_message(value: &str, origin: &str) -> String {
    let expected = SessionLockPolicy::wire_values()
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("ignoring invalid {origin} value \"{value}\"; expected one of {expected}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve, capturing whatever the user would have been told on stderr.
    fn resolve_collecting(
        override_value: Option<&str>,
        config: Option<&[u8]>,
    ) -> (ResolvedLockPolicy, Vec<String>) {
        let mut warnings: Vec<String> = Vec::new();
        let resolved = {
            let mut warn = |message: &str| warnings.push(message.to_string());
            resolve_lock_policy(override_value, config, &mut warn)
        };
        (resolved, warnings)
    }

    #[test]
    fn a_session_override_wins() {
        let config = br#"{"sessions":{"lockOn":"none"}}"#;
        let (resolved, warnings) = resolve_collecting(Some("screenLock"), Some(config));
        assert_eq!(resolved.policy, SessionLockPolicy::ScreenLock);
        assert_eq!(resolved.source, LockPolicySource::SessionOverride);
        assert!(warnings.is_empty());
    }

    #[test]
    fn the_machine_config_is_used_when_the_unlock_says_nothing() {
        let config = br#"{"sessions":{"lockOn":"none"}}"#;
        let (resolved, _) = resolve_collecting(None, Some(config));
        assert_eq!(resolved.policy, SessionLockPolicy::None);
        assert_eq!(resolved.source, LockPolicySource::MachineConfig);
    }

    #[test]
    fn nothing_configured_falls_back_to_sleep() {
        let (resolved, warnings) = resolve_collecting(None, None);
        assert_eq!(resolved.policy, SessionLockPolicy::Sleep);
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert!(warnings.is_empty());
    }

    #[test]
    fn an_empty_override_is_treated_as_absent() {
        let (resolved, warnings) = resolve_collecting(Some(""), None);
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_bad_override_warns_and_falls_through() {
        let config = br#"{"sessions":{"lockOn":"none"}}"#;
        let (resolved, warnings) = resolve_collecting(Some("whenever"), Some(config));
        assert_eq!(resolved.policy, SessionLockPolicy::None);
        assert_eq!(resolved.source, LockPolicySource::MachineConfig);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("unlock-session lockOn"));
        assert!(warnings[0].contains("\"whenever\""));
    }

    #[test]
    fn a_bad_config_value_warns_and_falls_back_to_the_default() {
        let config = br#"{"sessions":{"lockOn":"whenever"}}"#;
        let (resolved, warnings) = resolve_collecting(None, Some(config));
        assert_eq!(resolved.policy, SessionLockPolicy::Sleep);
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("config sessions.lockOn"));
    }

    #[test]
    fn an_unparseable_config_warns_once_and_is_ignored() {
        let (resolved, warnings) = resolve_collecting(None, Some(b"{not json"));
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("could not parse"));
    }

    #[test]
    fn a_config_without_the_section_is_silent() {
        let config = br#"{"telemetry":{"disabled":true}}"#;
        let (resolved, warnings) = resolve_collecting(None, Some(config));
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_non_string_config_value_warns() {
        let config = br#"{"sessions":{"lockOn":42}}"#;
        let (resolved, warnings) = resolve_collecting(None, Some(config));
        assert_eq!(resolved.source, LockPolicySource::BuiltInDefault);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn policies_erase_on_the_events_they_claim() {
        assert!(SessionLockPolicy::ScreenLock.erases_on(SessionLockEvent::ScreenLock));
        assert!(SessionLockPolicy::ScreenLock.erases_on(SessionLockEvent::Sleep));
        assert!(!SessionLockPolicy::Sleep.erases_on(SessionLockEvent::ScreenLock));
        assert!(SessionLockPolicy::Sleep.erases_on(SessionLockEvent::Sleep));
        assert!(!SessionLockPolicy::None.erases_on(SessionLockEvent::ScreenLock));
        assert!(!SessionLockPolicy::None.erases_on(SessionLockEvent::Sleep));
    }

    #[test]
    fn wire_values_round_trip() {
        for value in SessionLockPolicy::wire_values() {
            let parsed = SessionLockPolicy::from_wire_value(value).expect("should parse");
            assert_eq!(parsed.wire_value(), value);
        }
        assert_eq!(SessionLockPolicy::from_wire_value("nope"), None);
    }
}
