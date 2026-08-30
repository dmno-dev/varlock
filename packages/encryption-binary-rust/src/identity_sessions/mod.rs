//! Identity-backed unlock sessions.
//!
//! Values are not encrypted to the device key directly. An identity key sits in
//! between:
//!
//!   device key -> identity key -> values
//!
//! The identity is a software P-256 key pair whose private key is ECIES-wrapped
//! to one or more device keys, so unwrapping it goes through whatever gate the
//! device backend applies. Once unwrapped it has to be held somewhere for the
//! rest of a working session, or every value in an env file would cost its own
//! prompt. Holding it is what everything in this module exists to justify:
//!
//!   - [`grants`] decides how long a hold may last, on two clocks at once
//!   - [`lock_policy`] decides which system events end it early
//!   - [`lock_events`] delivers those events from the platform
//!   - [`audit`] records every authorization before any plaintext is released
//!   - [`custody`] is the device-key half: unwrapping, and user presence
//!   - [`manager`] ties them together and owns the held key material
//!
//! The protocol is the one the macOS daemon speaks (`unlock-session`,
//! `decrypt-v2`, `list-sessions`, `invalidate-session`), so a client cannot tell
//! which daemon it is talking to. Where the platforms genuinely differ, the
//! difference is documented at the point it appears rather than smoothed over.

pub mod audit;
pub mod clock;
pub mod custody;
pub mod grants;
pub mod identity_store;
pub mod lock_events;
pub mod lock_policy;
pub mod manager;
