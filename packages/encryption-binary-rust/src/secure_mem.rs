//! Secure memory utilities for protecting sensitive key material.
//!
//! - Locks memory pages to prevent swapping to disk (VirtualLock / mlock)
//! - Zeroizes memory on drop to prevent lingering secrets

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
            lock_memory(data.as_ptr(), data.len());
        }
        Self { inner: data }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.inner
    }
}

impl Drop for SecureBytes {
    fn drop(&mut self) {
        let ptr = self.inner.as_ptr();
        let len = self.inner.len();

        // Zeroize the contents
        self.inner.zeroize();

        // Unlock the memory region
        if len > 0 {
            unlock_memory(ptr, len);
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
