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
