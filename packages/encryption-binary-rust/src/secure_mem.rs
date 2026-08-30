//! Secure memory utilities for protecting sensitive key material.
//!
//! - Locks memory pages to prevent swapping to disk (VirtualLock / mlock)
//! - Zeroizes memory on drop to prevent lingering secrets
//! - Keeps key bytes out of core dumps and out of another process's reach
//!
//! The daemon holds an identity key for as long as a session's grant lives, so
//! "in memory" here means minutes to hours rather than the microseconds a
//! one-shot decrypt needs. [`GuardedBuffer`] is the type that hold uses: a
//! fixed-size allocation that never grows (and so never leaves a stale copy
//! behind at an old address), locked, excluded from dumps, and zeroized the
//! moment the session ends.

use zeroize::Zeroize;

/// A Vec<u8> wrapper that locks its memory (prevents swapping) and
/// zeroizes contents on drop.
pub struct SecureBytes {
    inner: Vec<u8>,
}

impl SecureBytes {
    /// Create a SecureBytes from existing data. Locks the memory region.
    pub fn new(data: Vec<u8>) -> Self {
        if !data.is_empty() {
            lock_memory(data.as_ptr(), data.capacity());
        }
        Self { inner: data }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.inner
    }
}

impl Drop for SecureBytes {
    fn drop(&mut self) {
        // Zeroize first while memory is still valid and locked
        let cap = self.inner.capacity();
        self.inner.zeroize();

        // Unlock after zeroizing — pointer is still valid (Vec keeps allocation until drop)
        if cap > 0 {
            unlock_memory(self.inner.as_ptr(), cap);
        }
    }
}

/// A String wrapper that zeroizes on drop. For derived representations
/// of key material (e.g., base64-encoded private keys).
pub struct SecureString {
    inner: String,
}

impl SecureString {
    pub fn new(s: String) -> Self {
        Self { inner: s }
    }

    pub fn as_str(&self) -> &str {
        &self.inner
    }
}

impl Drop for SecureString {
    fn drop(&mut self) {
        // Safety: zeroize the underlying bytes
        unsafe {
            let bytes = self.inner.as_bytes_mut();
            bytes.zeroize();
        }
    }
}

/// A fixed-size buffer for key material the daemon holds across calls.
///
/// The size is fixed at construction and the allocation never moves, which is
/// the difference that matters against a `Vec` or a `String`: those reallocate
/// as they grow and leave the old, still-populated block behind for the
/// allocator to hand out. Everything else is defence in depth around that:
///
///   - the pages are locked (`mlock` / `VirtualLock`) so the bytes cannot be
///     written to swap or to a hibernation file
///   - on Linux the range is marked `MADV_DONTDUMP`, so a core dump of the
///     daemon does not carry it
///   - dropping zeroizes before unlocking, so nothing is readable afterwards
///
/// See [`harden_process`] for the process-wide half of this (no core dumps at
/// all, and no ptrace from a sibling process).
pub struct GuardedBuffer {
    /// Boxed rather than a `Vec`: a boxed slice has no spare capacity and no
    /// growth path, so the address and length we lock stay the ones we free.
    bytes: Box<[u8]>,
}

impl GuardedBuffer {
    /// A zeroed buffer of exactly `len` bytes, locked and dump-excluded.
    pub fn zeroed(len: usize) -> Self {
        let bytes = vec![0u8; len].into_boxed_slice();
        let buffer = Self { bytes };
        buffer.protect();
        buffer
    }

    /// Copy `data` into a guarded buffer of exactly its length.
    ///
    /// The source is the caller's problem: use [`GuardedBuffer::take_vec`] when
    /// the bytes arrived in a `Vec` that should not outlive the copy.
    pub fn from_slice(data: &[u8]) -> Self {
        let mut buffer = Self::zeroed(data.len());
        buffer.as_mut_slice().copy_from_slice(data);
        buffer
    }

    /// Move the contents of a `Vec` into a guarded buffer, scrubbing the `Vec`.
    ///
    /// The `Vec` is where most key material arrives (a keyring read, a DPAPI
    /// unprotect), and it is unguarded for its whole life. This does not undo
    /// that, but it does make the unguarded copy as short-lived as it can be.
    /// The borrow is deliberate: the caller keeps the `Vec` and can see that it
    /// came back empty.
    pub fn take_vec(data: &mut Vec<u8>) -> Self {
        let buffer = Self::from_slice(data);
        data.zeroize();
        buffer
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.bytes
    }

    fn protect(&self) {
        if self.bytes.is_empty() {
            return;
        }
        lock_memory(self.bytes.as_ptr(), self.bytes.len());
        exclude_from_dumps(self.bytes.as_ptr(), self.bytes.len());
    }
}

impl Drop for GuardedBuffer {
    fn drop(&mut self) {
        if self.bytes.is_empty() {
            return;
        }
        let ptr = self.bytes.as_ptr();
        let len = self.bytes.len();
        // Zeroize first, while the pages are still locked.
        self.bytes.zeroize();
        unlock_memory(ptr, len);
    }
}

impl std::fmt::Debug for GuardedBuffer {
    /// Never prints the contents. A stray `{:?}` on a key is a leak into a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GuardedBuffer({} bytes, redacted)", self.bytes.len())
    }
}

/// Process-wide hardening, called once as the daemon starts.
///
/// Buffer-level guards only cover the buffers we know about. These cover the
/// process: with core dumps disabled there is no file for anything to leak
/// into, and with `PR_SET_DUMPABLE` cleared another process running as the same
/// user cannot attach a debugger and read the address space out from under the
/// locks. Both are best effort: a platform that refuses either still runs, it
/// just runs with one less guard, so failures are reported rather than fatal.
pub fn harden_process() {
    #[cfg(unix)]
    {
        // No core file, so a crash cannot write held key material to disk.
        let limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // Safety: a well-formed rlimit for a resource that always exists.
        let rc = unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) };
        if rc != 0 {
            eprintln!("varlock: could not disable core dumps; held keys could reach a crash dump");
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Clearing the dumpable flag also stops a same-user process from
        // ptrace-attaching, which is the cheapest way to read a held key.
        //
        // The arguments are spelled as `c_ulong` on purpose: `prctl` is variadic,
        // so an untyped `0` would be promoted as an `int` and the kernel reads
        // these as `unsigned long`.
        // Safety: prctl with a constant option and no output pointers.
        let rc = unsafe {
            libc::prctl(
                libc::PR_SET_DUMPABLE,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            )
        };
        if rc != 0 {
            eprintln!(
                "varlock: could not clear PR_SET_DUMPABLE ({}); this daemon can be traced",
                std::io::Error::last_os_error()
            );
        }
    }
}

// ── Platform-specific memory locking ────────────────────────────

#[cfg(target_os = "windows")]
fn lock_memory(ptr: *const u8, len: usize) {
    use windows::Win32::System::Memory::VirtualLock;
    unsafe {
        let _ = VirtualLock(ptr as *const _, len);
    }
}

#[cfg(target_os = "windows")]
fn unlock_memory(ptr: *const u8, len: usize) {
    use windows::Win32::System::Memory::VirtualUnlock;
    unsafe {
        let _ = VirtualUnlock(ptr as *const _, len);
    }
}

#[cfg(unix)]
fn lock_memory(ptr: *const u8, len: usize) {
    unsafe {
        libc::mlock(ptr as *const _, len);
    }
}

#[cfg(unix)]
fn unlock_memory(ptr: *const u8, len: usize) {
    unsafe {
        libc::munlock(ptr as *const _, len);
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn lock_memory(_ptr: *const u8, _len: usize) {}

#[cfg(not(any(unix, target_os = "windows")))]
fn unlock_memory(_ptr: *const u8, _len: usize) {}

// ── Dump exclusion ──────────────────────────────────────────────

/// Keep a range out of core dumps.
///
/// Linux takes this per range through `madvise`, which insists on a
/// page-aligned start, so the request is widened down to the page boundary.
/// That can cover a few unrelated heap bytes in the same page, which costs
/// nothing: `MADV_DONTDUMP` only affects what a dump contains.
#[cfg(target_os = "linux")]
fn exclude_from_dumps(ptr: *const u8, len: usize) {
    // Safety: sysconf with a constant name, no pointers involved.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return;
    }
    let page_size = page_size as usize;

    let start = ptr as usize & !(page_size - 1);
    let end = ptr as usize + len;
    // Safety: the range covers a live allocation, widened only to the start of
    // the page it begins in. madvise is advisory and cannot invalidate it.
    unsafe {
        libc::madvise(start as *mut libc::c_void, end - start, libc::MADV_DONTDUMP);
    }
}

/// Every other platform disables dumps process-wide instead: macOS and Windows
/// have no per-range equivalent, and [`harden_process`] already clears
/// `RLIMIT_CORE` where there is one.
#[cfg(not(target_os = "linux"))]
fn exclude_from_dumps(_ptr: *const u8, _len: usize) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guarded_buffer_has_exactly_the_length_asked_for() {
        let buffer = GuardedBuffer::zeroed(32);
        assert_eq!(buffer.as_slice().len(), 32);
        assert_eq!(buffer.as_slice(), &[0u8; 32]);
    }

    #[test]
    fn from_slice_copies_the_bytes() {
        let buffer = GuardedBuffer::from_slice(b"a 32 byte-ish private scalar...");
        assert_eq!(buffer.as_slice(), b"a 32 byte-ish private scalar...");
    }

    #[test]
    fn take_vec_scrubs_the_source() {
        let mut source = vec![7u8; 48];
        let buffer = GuardedBuffer::take_vec(&mut source);

        assert_eq!(buffer.as_slice(), &[7u8; 48]);
        assert!(source.is_empty(), "the source Vec still holds key bytes");
    }

    #[test]
    fn an_empty_buffer_is_harmless() {
        let buffer = GuardedBuffer::zeroed(0);
        assert!(buffer.as_slice().is_empty());
        assert_eq!(buffer.as_slice(), b"");
    }

    #[test]
    fn a_mutable_buffer_can_be_filled_in_place() {
        let mut buffer = GuardedBuffer::zeroed(4);
        buffer.as_mut_slice().copy_from_slice(&[1, 2, 3, 4]);
        assert_eq!(buffer.as_slice(), &[1, 2, 3, 4]);
    }

    #[test]
    fn debug_never_prints_the_contents() {
        let buffer = GuardedBuffer::from_slice(b"super-secret");
        let rendered = format!("{buffer:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn hardening_the_process_does_not_panic() {
        // Running it twice is also what a restarted daemon effectively does.
        harden_process();
        harden_process();
    }
}
