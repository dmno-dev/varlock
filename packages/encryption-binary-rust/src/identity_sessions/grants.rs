//! Grant bookkeeping for identity-backed sessions.
//!
//! A grant is what makes the daemon's holding of an identity key legitimate. It
//! is keyed by (sessionId x keyId): the same session unlocking a different key
//! is a separate grant, and the same key in a different session is too. The
//! session id comes from the connecting process, so a grant cannot be borrowed
//! by an unrelated session on the same machine.
//!
//! This is a port of `SessionGrants.swift`, kept deliberately close to it so the
//! two daemons cannot drift on lifetime rules. Like the Swift original it is
//! pure bookkeeping with an injected clock, so every rule here is unit testable
//! without a TPM, a keyring, or a daemon. Key material lives in
//! [`super::manager::IdentitySessionManager`], which drives its erase decisions
//! off what this table reports.

use serde_json::{json, Value};
use std::collections::HashMap;

use super::clock::ClockReading;
use super::lock_policy::{SessionLockEvent, SessionLockPolicy};

/// Hard ceiling on any grant, whatever scope or duration was asked for.
/// A `session` grant on a session that never ends still expires here.
pub const MAX_GRANT_MS: i64 = 12 * 60 * 60 * 1000;

/// How long a grant survives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionGrantScope {
    /// a single decrypt call, then the grant is spent
    Once,
    /// until the session it is bound to ends, or the cap is hit
    Session,
    /// a caller-chosen window, still bounded by the cap
    Duration,
}

impl SessionGrantScope {
    pub fn wire_value(&self) -> &'static str {
        match self {
            SessionGrantScope::Once => "once",
            SessionGrantScope::Session => "session",
            SessionGrantScope::Duration => "duration",
        }
    }

    pub fn from_wire_value(value: Option<&str>) -> Option<Self> {
        match value? {
            "once" => Some(SessionGrantScope::Once),
            "session" => Some(SessionGrantScope::Session),
            "duration" => Some(SessionGrantScope::Duration),
            _ => None,
        }
    }
}

/// Identifies one grant.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionGrantRef {
    pub session_id: String,
    pub key_id: String,
}

impl SessionGrantRef {
    pub fn new(session_id: impl Into<String>, key_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), key_id: key_id.into() }
    }
}

/// When a grant runs out, measured on both clocks at once.
///
/// Whichever clock runs out first ends the grant. Under a normal clock the two
/// are indistinguishable; they only diverge when someone moves the system clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantDeadline {
    /// epoch ms
    pub wall: i64,
    /// monotonic ms, from [`super::clock::monotonic_now_ms`]
    pub monotonic: i64,
}

impl GrantDeadline {
    /// A deadline `duration_ms` out from the clock readings given.
    pub fn after(duration_ms: i64, now: ClockReading) -> Self {
        Self {
            wall: now.wall.saturating_add(duration_ms),
            monotonic: now.monotonic.saturating_add(duration_ms),
        }
    }

    pub fn is_expired(&self, now: ClockReading) -> bool {
        self.wall <= now.wall || self.monotonic <= now.monotonic
    }

    /// Time left, on whichever clock has less of it. Never negative.
    ///
    /// The monotonic side governs in practice; the wall side only becomes the
    /// smaller of the two after the system clock jumps forward, and in that case
    /// the grant really does have less time than the monotonic clock thinks, so
    /// reporting the smaller number keeps the answer honest.
    pub fn remaining_ms(&self, now: ClockReading) -> i64 {
        let by_wall = self.wall.saturating_sub(now.wall);
        let by_monotonic = self.monotonic.saturating_sub(now.monotonic);
        by_wall.min(by_monotonic).max(0)
    }

    /// The earlier of two deadlines, taken per clock.
    ///
    /// Element-wise rather than picking one whole deadline: clamping a grant to
    /// its session cap has to clamp both halves, or a caller could ask for a
    /// long window and keep the session's later monotonic deadline.
    pub fn earliest(lhs: Self, rhs: Self) -> Self {
        Self {
            wall: lhs.wall.min(rhs.wall),
            monotonic: lhs.monotonic.min(rhs.monotonic),
        }
    }
}

/// A grant as the daemon reports it back. Never includes key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGrantInfo {
    pub session_id: String,
    pub key_id: String,
    pub identity_id: String,
    pub scope: SessionGrantScope,
    /// epoch ms
    pub granted_at: i64,
    /// epoch ms; always set, since every scope is capped. Display only: what
    /// actually ends the grant is `remaining_ms`, which the table measures on
    /// the monotonic clock as well as this one.
    pub expires_at: i64,
    /// ms of life left, as the table measured it when it built this record.
    ///
    /// Not derived from `expires_at` by the reader: the wall clock can be moved,
    /// and this number cannot be.
    pub remaining_ms: i64,
    /// epoch ms of the last decrypt this grant served, absent until first use
    pub last_used_at: Option<i64>,
    /// epoch ms when the session this grant belongs to was unlocked
    pub session_unlocked_at: i64,
    /// epoch ms when the session's hard cap runs out
    pub session_expires_at: i64,
    /// ms left on the session's hard cap, measured the same way as
    /// `remaining_ms`. Never shorter, since every grant is clamped to the cap.
    pub session_remaining_ms: i64,
    /// which system events erase this session, as resolved at unlock time
    pub lock_on: SessionLockPolicy,
    /// how many decrypts this grant has served
    pub use_count: u64,
}

impl SessionGrantInfo {
    /// The wire shape, field for field identical to the Swift daemon's, so a
    /// client cannot tell the two apart.
    pub fn to_json(&self) -> Value {
        let mut object = json!({
            "sessionId": self.session_id,
            "keyId": self.key_id,
            "identityId": self.identity_id,
            "scope": self.scope.wire_value(),
            "grantedAt": self.granted_at,
            "expiresAt": self.expires_at,
            "sessionUnlockedAt": self.session_unlocked_at,
            "sessionExpiresAt": self.session_expires_at,
            "sessionExpiresInMs": self.session_remaining_ms,
            "lockOn": self.lock_on.wire_value(),
            "useCount": self.use_count,
            "expiresInMs": self.remaining_ms,
        });
        if let (Some(last_used_at), Some(map)) = (self.last_used_at, object.as_object_mut()) {
            map.insert("lastUsedAt".into(), json!(last_used_at));
        }
        object
    }
}

/// Why a decrypt could not be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionGrantError {
    NoGrant(SessionGrantRef),
    Expired(SessionGrantRef),
}

impl SessionGrantError {
    /// Stable code the TS client can branch on without matching message text.
    pub fn code(&self) -> &'static str {
        match self {
            SessionGrantError::NoGrant(_) => "NO_SESSION_GRANT",
            SessionGrantError::Expired(_) => "SESSION_GRANT_EXPIRED",
        }
    }
}

impl std::fmt::Display for SessionGrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionGrantError::NoGrant(r) => write!(
                f,
                "No unlock session for key \"{}\"; run an unlock first",
                r.key_id
            ),
            SessionGrantError::Expired(r) => write!(
                f,
                "The unlock session for key \"{}\" has expired; unlock again",
                r.key_id
            ),
        }
    }
}

/// What changed after a mutation, so the caller knows when to erase key material.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionGrantChange {
    /// how many grants were dropped
    pub dropped: usize,
    /// sessions that no longer hold any live grant, and whose key should be erased
    pub closed_sessions: Vec<String>,
}

#[derive(Debug, Clone)]
struct Grant {
    identity_id: String,
    scope: SessionGrantScope,
    granted_at: i64,
    deadline: GrantDeadline,
    last_used_at: Option<i64>,
    use_count: u64,
}

#[derive(Debug, Clone)]
struct SessionState {
    unlocked_at: i64,
    /// `unlocked_at` + cap on both clocks; every grant in the session is clamped to this
    deadline: GrantDeadline,
    /// Which system events erase this session. Held per session rather than
    /// globally, so one session can outlive a screen lock that ends another.
    lock_on: SessionLockPolicy,
    /// keyed by key id
    grants: HashMap<String, Grant>,
}

/// The live grant table.
///
/// Not internally synchronized: the manager that owns it holds it behind a
/// mutex, the same way the Swift version runs everything on one queue.
pub struct SessionGrantTable {
    sessions: HashMap<String, SessionState>,
    clock: Box<dyn Fn() -> ClockReading + Send + Sync>,
}

impl Default for SessionGrantTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionGrantTable {
    pub fn new() -> Self {
        Self::with_clock(ClockReading::now)
    }

    /// Build a table over an injected clock, so tests can move either half of it.
    pub fn with_clock(clock: impl Fn() -> ClockReading + Send + Sync + 'static) -> Self {
        Self { sessions: HashMap::new(), clock: Box::new(clock) }
    }

    pub fn now(&self) -> ClockReading {
        (self.clock)()
    }

    // ── Session lifetime ──────────────────────────────────────────

    /// Whether the session still holds at least one live grant, meaning the
    /// daemon is still holding its identity key.
    ///
    /// The daemon asks [`SessionGrantTable::has_live_sessions`] instead, since it
    /// only cares whether it is holding anything at all. This narrower question
    /// is what the lifetime tests are written against.
    #[cfg(test)]
    pub fn is_session_live(&mut self, session_id: &str) -> bool {
        self.prune_expired();
        self.sessions
            .get(session_id)
            .is_some_and(|state| !state.grants.is_empty())
    }

    /// Whether any session is live. The daemon refuses to idle-quit while this holds.
    pub fn has_live_sessions(&mut self) -> bool {
        self.prune_expired();
        self.sessions.values().any(|state| !state.grants.is_empty())
    }

    pub fn live_session_ids(&mut self) -> Vec<String> {
        self.prune_expired();
        let mut ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, state)| !state.grants.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// The live grant for one (session x key), if there is one.
    ///
    /// Read-only, and it charges nothing.
    pub fn live_grant(&mut self, grant_ref: &SessionGrantRef) -> Option<SessionGrantInfo> {
        self.prune_expired();
        let state = self.sessions.get(&grant_ref.session_id)?;
        let grant = state.grants.get(&grant_ref.key_id)?;
        Some(self.info(grant_ref, grant, state))
    }

    /// The lock policy a live session is running under. See
    /// [`super::manager::IdentitySessionManager::lock_policy`].
    #[cfg(test)]
    pub fn lock_policy(&mut self, session_id: &str) -> Option<SessionLockPolicy> {
        self.prune_expired();
        self.sessions.get(session_id).map(|state| state.lock_on)
    }

    // ── Granting ──────────────────────────────────────────────────

    /// Record a grant, opening the session if this is its first one.
    ///
    /// The session's cap starts at its first unlock, so a caller cannot extend
    /// its hold past 12h by re-granting the same key over and over.
    pub fn grant(
        &mut self,
        grant_ref: &SessionGrantRef,
        identity_id: &str,
        scope: SessionGrantScope,
        duration_ms: Option<i64>,
        lock_on: SessionLockPolicy,
    ) -> SessionGrantInfo {
        self.prune_expired();
        let now = self.now();

        let session_deadline = match self.sessions.get_mut(&grant_ref.session_id) {
            Some(existing) => {
                // The most recent unlock sets the session's lock policy, so
                // re-unlocking is how someone changes their mind about it.
                existing.lock_on = lock_on;
                existing.deadline
            }
            None => {
                let deadline = GrantDeadline::after(MAX_GRANT_MS, now);
                self.sessions.insert(
                    grant_ref.session_id.clone(),
                    SessionState {
                        unlocked_at: now.wall,
                        deadline,
                        lock_on,
                        grants: HashMap::new(),
                    },
                );
                deadline
            }
        };

        let requested_deadline = match scope {
            SessionGrantScope::Once | SessionGrantScope::Session => session_deadline,
            SessionGrantScope::Duration => {
                let window = duration_ms.unwrap_or(MAX_GRANT_MS).clamp(0, MAX_GRANT_MS);
                GrantDeadline::after(window, now)
            }
        };

        let grant = Grant {
            identity_id: identity_id.to_string(),
            scope,
            granted_at: now.wall,
            // never past the session cap, whatever was asked for, on either clock
            deadline: GrantDeadline::earliest(requested_deadline, session_deadline),
            last_used_at: None,
            use_count: 0,
        };

        let state = self
            .sessions
            .get_mut(&grant_ref.session_id)
            .expect("session was just inserted");
        state.grants.insert(grant_ref.key_id.clone(), grant.clone());
        let state = &self.sessions[&grant_ref.session_id];
        self.info(grant_ref, &grant, state)
    }

    // ── Using ─────────────────────────────────────────────────────

    /// Check a grant and charge one use against it.
    ///
    /// A `once` grant is spent here: it serves exactly one `decrypt-v2` call,
    /// however many payloads that call carries, and is then dropped.
    pub fn consume(
        &mut self,
        grant_ref: &SessionGrantRef,
    ) -> Result<(SessionGrantInfo, SessionGrantChange), SessionGrantError> {
        // Deliberately no prune first: an expired grant should still be found
        // here so the caller is told the session ran out, not that it never
        // existed.
        let now = self.now();

        let Some(state) = self.sessions.get(&grant_ref.session_id) else {
            return Err(SessionGrantError::NoGrant(grant_ref.clone()));
        };
        let Some(grant) = state.grants.get(&grant_ref.key_id) else {
            return Err(SessionGrantError::NoGrant(grant_ref.clone()));
        };

        if grant.deadline.is_expired(now) || state.deadline.is_expired(now) {
            // Drop it here rather than leaving a dead row for the next prune.
            self.drop_grant(grant_ref);
            return Err(SessionGrantError::Expired(grant_ref.clone()));
        }

        let state = self
            .sessions
            .get_mut(&grant_ref.session_id)
            .expect("session was just read");
        let grant = state
            .grants
            .get_mut(&grant_ref.key_id)
            .expect("grant was just read");
        grant.use_count += 1;
        grant.last_used_at = Some(now.wall);
        let served_grant = grant.clone();
        let scope = served_grant.scope;

        let state = &self.sessions[&grant_ref.session_id];
        let served = self.info(grant_ref, &served_grant, state);

        if scope == SessionGrantScope::Once {
            let change = self.drop_grant(grant_ref);
            return Ok((served, change));
        }
        Ok((served, SessionGrantChange::default()))
    }

    // ── Listing ───────────────────────────────────────────────────

    /// Every live grant, oldest session first, stable within a session by key id.
    pub fn list(&mut self) -> Vec<SessionGrantInfo> {
        self.prune_expired();
        let mut out: Vec<SessionGrantInfo> = Vec::new();
        for (session_id, state) in &self.sessions {
            for (key_id, grant) in &state.grants {
                let grant_ref = SessionGrantRef::new(session_id.clone(), key_id.clone());
                out.push(self.info(&grant_ref, grant, state));
            }
        }
        out.sort_by(|a, b| {
            a.session_unlocked_at
                .cmp(&b.session_unlocked_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
                .then_with(|| a.key_id.cmp(&b.key_id))
        });
        out
    }

    // ── Invalidating ──────────────────────────────────────────────

    /// Drop grants.
    ///
    /// Passing neither argument drops every grant, which is what the
    /// argument-less `invalidate-session` has always done. Naming a session
    /// drops that session's grants; naming both drops exactly one.
    pub fn invalidate(
        &mut self,
        session_id: Option<&str>,
        key_id: Option<&str>,
    ) -> SessionGrantChange {
        let mut dropped = 0usize;
        let mut closed: Vec<String> = Vec::new();

        let target_sessions: Vec<String> = self
            .sessions
            .keys()
            .filter(|sid| session_id.is_none_or(|wanted| wanted == sid.as_str()))
            .cloned()
            .collect();

        for sid in target_sessions {
            let Some(state) = self.sessions.get_mut(&sid) else { continue };
            let target_keys: Vec<String> = state
                .grants
                .keys()
                .filter(|kid| key_id.is_none_or(|wanted| wanted == kid.as_str()))
                .cloned()
                .collect();
            for kid in target_keys {
                if state.grants.remove(&kid).is_some() {
                    dropped += 1;
                }
            }
            if state.grants.is_empty() {
                self.sessions.remove(&sid);
                closed.push(sid);
            }
        }

        closed.sort();
        SessionGrantChange { dropped, closed_sessions: closed }
    }

    /// Drop the sessions whose own lock policy says this event ends them.
    ///
    /// Each session is judged individually, so a `screenLock` session can be
    /// erased by the same event a `none` session in the same daemon shrugs off.
    pub fn invalidate_on_lock_event(&mut self, event: SessionLockEvent) -> SessionGrantChange {
        let mut dropped = 0usize;
        let mut closed: Vec<String> = Vec::new();

        let doomed: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, state)| state.lock_on.erases_on(event))
            .map(|(sid, _)| sid.clone())
            .collect();

        for sid in doomed {
            if let Some(state) = self.sessions.remove(&sid) {
                dropped += state.grants.len();
                closed.push(sid);
            }
        }

        closed.sort();
        SessionGrantChange { dropped, closed_sessions: closed }
    }

    /// Drop everything whose time is up, and report the sessions that closed.
    pub fn prune_expired(&mut self) -> SessionGrantChange {
        let now = self.now();
        let mut dropped = 0usize;
        let mut closed: Vec<String> = Vec::new();

        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for sid in session_ids {
            let Some(state) = self.sessions.get_mut(&sid) else { continue };

            if state.deadline.is_expired(now) {
                dropped += state.grants.len();
                self.sessions.remove(&sid);
                closed.push(sid);
                continue;
            }

            let stale: Vec<String> = state
                .grants
                .iter()
                .filter(|(_, grant)| grant.deadline.is_expired(now))
                .map(|(kid, _)| kid.clone())
                .collect();
            for kid in stale {
                state.grants.remove(&kid);
                dropped += 1;
            }
            if state.grants.is_empty() {
                self.sessions.remove(&sid);
                closed.push(sid);
            }
        }

        closed.sort();
        SessionGrantChange { dropped, closed_sessions: closed }
    }

    // ── Private ───────────────────────────────────────────────────

    fn drop_grant(&mut self, grant_ref: &SessionGrantRef) -> SessionGrantChange {
        let Some(state) = self.sessions.get_mut(&grant_ref.session_id) else {
            return SessionGrantChange::default();
        };
        if state.grants.remove(&grant_ref.key_id).is_none() {
            return SessionGrantChange::default();
        }
        if state.grants.is_empty() {
            self.sessions.remove(&grant_ref.session_id);
            return SessionGrantChange {
                dropped: 1,
                closed_sessions: vec![grant_ref.session_id.clone()],
            };
        }
        SessionGrantChange { dropped: 1, closed_sessions: Vec::new() }
    }

    fn info(
        &self,
        grant_ref: &SessionGrantRef,
        grant: &Grant,
        session: &SessionState,
    ) -> SessionGrantInfo {
        let now = self.now();
        SessionGrantInfo {
            session_id: grant_ref.session_id.clone(),
            key_id: grant_ref.key_id.clone(),
            identity_id: grant.identity_id.clone(),
            scope: grant.scope,
            granted_at: grant.granted_at,
            expires_at: grant.deadline.wall,
            remaining_ms: grant.deadline.remaining_ms(now),
            last_used_at: grant.last_used_at,
            session_unlocked_at: session.unlocked_at,
            session_expires_at: session.deadline.wall,
            session_remaining_ms: session.deadline.remaining_ms(now),
            lock_on: session.lock_on,
            use_count: grant.use_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    /// A clock whose halves move independently, so a test can advance wall time
    /// without advancing monotonic time (and the other way round).
    #[derive(Clone, Default)]
    struct TestClock {
        wall: Arc<AtomicI64>,
        monotonic: Arc<AtomicI64>,
    }

    impl TestClock {
        fn start() -> Self {
            Self {
                wall: Arc::new(AtomicI64::new(1_700_000_000_000)),
                monotonic: Arc::new(AtomicI64::new(5_000)),
            }
        }

        fn reading(&self) -> ClockReading {
            ClockReading {
                wall: self.wall.load(Ordering::SeqCst),
                monotonic: self.monotonic.load(Ordering::SeqCst),
            }
        }

        /// Move both halves, the way real time passes.
        fn advance(&self, ms: i64) {
            self.wall.fetch_add(ms, Ordering::SeqCst);
            self.monotonic.fetch_add(ms, Ordering::SeqCst);
        }

        fn set_wall(&self, value: i64) {
            self.wall.store(value, Ordering::SeqCst);
        }

        fn advance_monotonic(&self, ms: i64) {
            self.monotonic.fetch_add(ms, Ordering::SeqCst);
        }

        fn table(&self) -> SessionGrantTable {
            let clock = self.clone();
            SessionGrantTable::with_clock(move || clock.reading())
        }
    }

    fn a_ref() -> SessionGrantRef {
        SessionGrantRef::new("tty:1:2", "varlock-default")
    }

    #[test]
    fn a_granted_key_is_live_and_consumable() {
        let clock = TestClock::start();
        let mut table = clock.table();
        let info = table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        assert_eq!(info.use_count, 0);
        assert_eq!(info.last_used_at, None);
        assert!(table.is_session_live("tty:1:2"));

        let (served, change) = table.consume(&a_ref()).expect("grant should serve");
        assert_eq!(served.use_count, 1);
        assert_eq!(served.last_used_at, Some(clock.reading().wall));
        assert_eq!(change.dropped, 0);
        assert!(table.is_session_live("tty:1:2"));
    }

    #[test]
    fn an_unknown_key_reports_no_grant() {
        let mut table = TestClock::start().table();
        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "NO_SESSION_GRANT");
    }

    #[test]
    fn a_once_grant_is_spent_by_a_single_call() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Once, None, SessionLockPolicy::Sleep);

        let (_, change) = table.consume(&a_ref()).expect("first call should serve");
        assert_eq!(change.dropped, 1);
        assert_eq!(change.closed_sessions, vec!["tty:1:2".to_string()]);

        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "NO_SESSION_GRANT");
        assert!(!table.has_live_sessions());
    }

    #[test]
    fn a_duration_grant_expires_on_its_own_window() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Duration,
            Some(60_000),
            SessionLockPolicy::Sleep,
        );

        clock.advance(59_000);
        assert!(table.consume(&a_ref()).is_ok());

        clock.advance(2_000);
        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "SESSION_GRANT_EXPIRED");
    }

    #[test]
    fn a_duration_longer_than_the_cap_is_clamped_to_it() {
        let clock = TestClock::start();
        let mut table = clock.table();
        let info = table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Duration,
            Some(MAX_GRANT_MS * 10),
            SessionLockPolicy::Sleep,
        );
        assert_eq!(info.remaining_ms, MAX_GRANT_MS);
        assert_eq!(info.expires_at, info.session_expires_at);
    }

    #[test]
    fn a_session_grant_still_dies_at_the_twelve_hour_cap() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::None);

        clock.advance(MAX_GRANT_MS - 1_000);
        assert!(table.consume(&a_ref()).is_ok());

        clock.advance(2_000);
        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "SESSION_GRANT_EXPIRED");
        assert!(!table.has_live_sessions());
    }

    #[test]
    fn re_granting_does_not_extend_the_session_cap() {
        let clock = TestClock::start();
        let mut table = clock.table();
        let first = table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        clock.advance(60 * 60 * 1000);
        let second = table.grant(
            &SessionGrantRef::new("tty:1:2", "other-key"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        assert_eq!(first.session_expires_at, second.session_expires_at);
        assert!(second.remaining_ms < MAX_GRANT_MS);
    }

    #[test]
    fn winding_the_wall_clock_back_cannot_buy_more_life() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Duration,
            Some(60_000),
            SessionLockPolicy::Sleep,
        );

        // Only the monotonic half moves past the deadline, and the wall clock is
        // dragged back a year. The grant must still be over.
        clock.advance_monotonic(61_000);
        clock.set_wall(1_600_000_000_000);

        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "SESSION_GRANT_EXPIRED");
    }

    #[test]
    fn winding_the_wall_clock_forward_ends_a_grant_early() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        // The wall clock alone jumps past the cap. Reporting the smaller of the
        // two remaining values is what makes this end the grant.
        clock.set_wall(clock.reading().wall + MAX_GRANT_MS + 1);
        let err = table.consume(&a_ref()).unwrap_err();
        assert_eq!(err.code(), "SESSION_GRANT_EXPIRED");
    }

    #[test]
    fn a_duration_grant_keeps_the_sessions_monotonic_cap() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::Sleep);

        // Asking for a window longer than what is left of the session must not
        // hand back the later deadline on either clock.
        clock.advance(MAX_GRANT_MS - 10_000);
        let info = table.grant(
            &SessionGrantRef::new("tty:1:2", "other-key"),
            "default",
            SessionGrantScope::Duration,
            Some(MAX_GRANT_MS),
            SessionLockPolicy::Sleep,
        );
        assert!(info.remaining_ms <= 10_000);
    }

    #[test]
    fn grants_are_scoped_to_their_own_session_and_key() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::Sleep);

        let other_session = SessionGrantRef::new("tty:9:9", "varlock-default");
        assert_eq!(
            table.consume(&other_session).unwrap_err().code(),
            "NO_SESSION_GRANT"
        );

        let other_key = SessionGrantRef::new("tty:1:2", "another-key");
        assert_eq!(
            table.consume(&other_key).unwrap_err().code(),
            "NO_SESSION_GRANT"
        );
    }

    #[test]
    fn invalidating_one_key_leaves_the_rest_of_the_session() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::Sleep);
        table.grant(
            &SessionGrantRef::new("tty:1:2", "second"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        let change = table.invalidate(Some("tty:1:2"), Some("second"));
        assert_eq!(change.dropped, 1);
        assert!(change.closed_sessions.is_empty());
        assert!(table.is_session_live("tty:1:2"));
    }

    #[test]
    fn invalidating_with_no_arguments_drops_everything() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::Sleep);
        table.grant(
            &SessionGrantRef::new("tty:9:9", "varlock-default"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        let change = table.invalidate(None, None);
        assert_eq!(change.dropped, 2);
        assert_eq!(change.closed_sessions, vec!["tty:1:2".to_string(), "tty:9:9".to_string()]);
        assert!(!table.has_live_sessions());
    }

    #[test]
    fn a_lock_event_only_erases_the_sessions_whose_policy_says_so() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &SessionGrantRef::new("locks", "k"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::ScreenLock,
        );
        table.grant(
            &SessionGrantRef::new("sleeps", "k"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );
        table.grant(
            &SessionGrantRef::new("never", "k"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::None,
        );

        let change = table.invalidate_on_lock_event(SessionLockEvent::ScreenLock);
        assert_eq!(change.closed_sessions, vec!["locks".to_string()]);
        assert!(table.is_session_live("sleeps"));
        assert!(table.is_session_live("never"));

        let change = table.invalidate_on_lock_event(SessionLockEvent::Sleep);
        assert_eq!(change.closed_sessions, vec!["sleeps".to_string()]);
        assert!(table.is_session_live("never"));
    }

    #[test]
    fn re_unlocking_replaces_the_sessions_lock_policy() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::None);
        assert_eq!(table.lock_policy("tty:1:2"), Some(SessionLockPolicy::None));

        table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::ScreenLock,
        );
        assert_eq!(table.lock_policy("tty:1:2"), Some(SessionLockPolicy::ScreenLock));
    }

    #[test]
    fn listing_is_ordered_by_session_age_then_key() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &SessionGrantRef::new("older", "b"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );
        table.grant(
            &SessionGrantRef::new("older", "a"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );
        clock.advance(1_000);
        table.grant(
            &SessionGrantRef::new("newer", "a"),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );

        let listed: Vec<(String, String)> = table
            .list()
            .into_iter()
            .map(|info| (info.session_id, info.key_id))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("older".to_string(), "a".to_string()),
                ("older".to_string(), "b".to_string()),
                ("newer".to_string(), "a".to_string()),
            ]
        );
    }

    #[test]
    fn pruning_closes_sessions_that_ran_out() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Duration,
            Some(1_000),
            SessionLockPolicy::Sleep,
        );

        clock.advance(2_000);
        let change = table.prune_expired();
        assert_eq!(change.dropped, 1);
        assert_eq!(change.closed_sessions, vec!["tty:1:2".to_string()]);
    }

    #[test]
    fn the_wire_shape_matches_the_swift_daemons() {
        let clock = TestClock::start();
        let mut table = clock.table();
        table.grant(&a_ref(), "default", SessionGrantScope::Session, None, SessionLockPolicy::Sleep);
        let (served, _) = table.consume(&a_ref()).unwrap();
        let json = served.to_json();
        let object = json.as_object().unwrap();

        let mut keys: Vec<&str> = object.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "expiresAt",
                "expiresInMs",
                "grantedAt",
                "identityId",
                "keyId",
                "lastUsedAt",
                "lockOn",
                "scope",
                "sessionExpiresAt",
                "sessionExpiresInMs",
                "sessionId",
                "sessionUnlockedAt",
                "useCount",
            ]
        );
        assert_eq!(object["scope"], json!("session"));
        assert_eq!(object["lockOn"], json!("sleep"));
        assert_eq!(object["useCount"], json!(1));
    }

    #[test]
    fn a_grant_that_has_never_been_used_omits_last_used_at() {
        let clock = TestClock::start();
        let mut table = clock.table();
        let info = table.grant(
            &a_ref(),
            "default",
            SessionGrantScope::Session,
            None,
            SessionLockPolicy::Sleep,
        );
        assert!(info.to_json().as_object().unwrap().get("lastUsedAt").is_none());
    }
}
