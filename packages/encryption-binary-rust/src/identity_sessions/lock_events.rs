//! Platform event sources that end unlock sessions.
//!
//! A session's `lockOn` policy names events; something has to deliver them. On
//! macOS that is `NSWorkspace`. Here it is:
//!
//! | event        | Windows                                    | Linux                                          |
//! |--------------|--------------------------------------------|------------------------------------------------|
//! | `sleep`      | `PowerRegisterSuspendResumeNotification`   | logind `PrepareForSleep(true)`                 |
//! | `screenLock` | `WTSRegisterSessionNotification` (WTS lock) | logind session `Lock`                          |
//!
//! What is deliberately NOT wired, and why:
//!
//!   - **Linux screensaver locks.** GNOME (`org.gnome.ScreenSaver`), KDE, and
//!     the freedesktop `org.freedesktop.ScreenSaver` interface each announce a
//!     lock differently, and a session locked through the desktop's own
//!     shortcut does not always reach logind. logind's `Lock` covers
//!     `loginctl lock-session` and anything that routes through it. Adding a
//!     per-desktop source is a matter of another `receive_signal` call against
//!     the session bus: [`LockEventSources::wired`] reports what is actually
//!     live, so the gap is visible rather than assumed.
//!   - **Windows display sleep / screensaver.** `WM_WTSSESSION_CHANGE` reports
//!     the workstation locking, which is the event people mean. A screen that
//!     merely blanked has not locked anything.
//!   - **Resume.** Nothing subscribes to it. Sessions are erased on the way
//!     down; there is nothing to restore on the way back.
//!
//! Every source runs on its own thread and reports through the sink. A source
//! that cannot start says so on stderr and the daemon keeps running: losing an
//! event source shortens nothing, it only means a session lives to its TTL
//! instead of to a lock.

use std::sync::Arc;

use super::lock_policy::SessionLockEvent;

/// Where delivered events go. Called from a source's own thread.
pub type LockEventSink = Arc<dyn Fn(SessionLockEvent) + Send + Sync>;

/// The sources that actually started, and the handles that keep them alive.
pub struct LockEventSources {
    wired: Vec<&'static str>,
    #[cfg(target_os = "windows")]
    _windows: Option<windows_impl::WindowsSources>,
}

impl LockEventSources {
    /// Which triggers are live on this machine, for the daemon's ready line and
    /// for anyone wondering why a session outlived a screen lock.
    pub fn wired(&self) -> &[&'static str] {
        &self.wired
    }
}

/// Start every event source this platform has.
///
/// The returned value must be kept alive for as long as the daemon runs;
/// dropping it stops the sources that need explicit teardown.
pub fn start(sink: LockEventSink) -> LockEventSources {
    #[cfg(target_os = "linux")]
    {
        let wired = linux_impl::start(sink);
        LockEventSources { wired }
    }

    #[cfg(target_os = "windows")]
    {
        let (wired, handles) = windows_impl::start(sink);
        LockEventSources { wired, _windows: handles }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        // macOS runs the Swift daemon, which has its own `NSWorkspace` sources.
        // This build exists so the portable half can be developed and tested
        // here, so it wires nothing and says so.
        let _ = sink;
        LockEventSources { wired: Vec::new() }
    }
}

// ── Linux ────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::{LockEventSink, SessionLockEvent};

    const LOGIND_SERVICE: &str = "org.freedesktop.login1";
    const LOGIND_MANAGER_PATH: &str = "/org/freedesktop/login1";
    const LOGIND_MANAGER_INTERFACE: &str = "org.freedesktop.login1.Manager";
    const LOGIND_SESSION_INTERFACE: &str = "org.freedesktop.login1.Session";

    pub fn start(sink: LockEventSink) -> Vec<&'static str> {
        let mut wired = Vec::new();

        match start_prepare_for_sleep(sink.clone()) {
            Ok(()) => wired.push("logind:PrepareForSleep"),
            Err(err) => eprintln!(
                "varlock: not watching for sleep ({err}); sessions will run to their TTL instead"
            ),
        }

        match start_session_lock(sink) {
            Ok(()) => wired.push("logind:Session.Lock"),
            Err(err) => eprintln!(
                "varlock: not watching for screen lock ({err}); sessions set to lock on screenLock will not"
            ),
        }

        wired
    }

    /// logind announces an imminent suspend with `PrepareForSleep(true)`, and
    /// the resume with `PrepareForSleep(false)`. Only the way down matters here.
    fn start_prepare_for_sleep(sink: LockEventSink) -> Result<(), String> {
        let connection = zbus::blocking::Connection::system()
            .map_err(|e| format!("no system bus: {e}"))?;
        let proxy = zbus::blocking::Proxy::new(
            &connection,
            LOGIND_SERVICE,
            LOGIND_MANAGER_PATH,
            LOGIND_MANAGER_INTERFACE,
        )
        .map_err(|e| format!("no logind manager: {e}"))?;

        let signals = proxy
            .receive_signal("PrepareForSleep")
            .map_err(|e| format!("could not subscribe to PrepareForSleep: {e}"))?;

        std::thread::Builder::new()
            .name("varlock-sleep-watch".into())
            .spawn(move || {
                // The connection and proxy are moved in so the subscription
                // outlives this function.
                let _connection = connection;
                for message in signals {
                    match message.body().deserialize::<bool>() {
                        Ok(true) => sink(SessionLockEvent::Sleep),
                        Ok(false) => {}
                        Err(e) => eprintln!("varlock: unreadable PrepareForSleep signal: {e}"),
                    }
                }
            })
            .map_err(|e| format!("could not start the sleep watcher: {e}"))?;
        Ok(())
    }

    /// The `Lock` signal on this login session's own object. Emitted by
    /// `loginctl lock-session` and by anything that asks logind to lock.
    fn start_session_lock(sink: LockEventSink) -> Result<(), String> {
        let connection = zbus::blocking::Connection::system()
            .map_err(|e| format!("no system bus: {e}"))?;
        let session_path = current_session_path(&connection)?;

        let proxy = zbus::blocking::Proxy::new(
            &connection,
            LOGIND_SERVICE,
            session_path.clone(),
            LOGIND_SESSION_INTERFACE,
        )
        .map_err(|e| format!("no logind session at {session_path}: {e}"))?;

        let signals = proxy
            .receive_signal("Lock")
            .map_err(|e| format!("could not subscribe to Session.Lock: {e}"))?;

        std::thread::Builder::new()
            .name("varlock-lock-watch".into())
            .spawn(move || {
                let _connection = connection;
                for _message in signals {
                    sink(SessionLockEvent::ScreenLock);
                }
            })
            .map_err(|e| format!("could not start the lock watcher: {e}"))?;
        Ok(())
    }

    /// The logind object path for the session this daemon runs in.
    ///
    /// Asked for by PID rather than read from `XDG_SESSION_ID`, because a daemon
    /// started by a service manager may not have inherited that variable, and
    /// the answer has to describe where the daemon actually is.
    fn current_session_path(
        connection: &zbus::blocking::Connection,
    ) -> Result<String, String> {
        let proxy = zbus::blocking::Proxy::new(
            connection,
            LOGIND_SERVICE,
            LOGIND_MANAGER_PATH,
            LOGIND_MANAGER_INTERFACE,
        )
        .map_err(|e| format!("no logind manager: {e}"))?;

        let path: zbus::zvariant::OwnedObjectPath = proxy
            .call("GetSessionByPID", &(std::process::id(),))
            .map_err(|e| format!("this process is not in a login session: {e}"))?;
        Ok(path.as_str().to_string())
    }
}

// ── Windows ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{LockEventSink, SessionLockEvent};
    use std::sync::OnceLock;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, DEVICE_NOTIFY_CALLBACK, HMENU, HWND_MESSAGE, MSG, PBT_APMSUSPEND,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
    };

    /// The sink both callbacks reach for.
    ///
    /// A static rather than a boxed pointer smuggled through the window's user
    /// data: the power notification callback is a bare `extern "system"` function
    /// with only an opaque context pointer, and one process only ever has one
    /// session manager, so a `OnceLock` is honest about that and avoids a raw
    /// pointer with no lifetime.
    static SINK: OnceLock<LockEventSink> = OnceLock::new();

    fn deliver(event: SessionLockEvent) {
        if let Some(sink) = SINK.get() {
            sink(event);
        }
    }

    /// Kept alive for the daemon's life; dropping it would unregister the
    /// notifications.
    pub struct WindowsSources {
        _power: PowerRegistration,
    }

    struct PowerRegistration(*mut std::ffi::c_void);
    // The handle is only ever unregistered on drop, from whichever thread owns
    // the struct. Windows makes no thread-affinity demand on it.
    unsafe impl Send for PowerRegistration {}
    unsafe impl Sync for PowerRegistration {}

    impl Drop for PowerRegistration {
        fn drop(&mut self) {
            use windows::Win32::System::Power::PowerUnregisterSuspendResumeNotification;
            // Safety: the handle came from a successful registration and is
            // unregistered exactly once.
            unsafe {
                let _ = PowerUnregisterSuspendResumeNotification(HPOWERNOTIFY(self.0 as isize));
            }
        }
    }

    pub fn start(sink: LockEventSink) -> (Vec<&'static str>, Option<WindowsSources>) {
        let mut wired = Vec::new();
        if SINK.set(sink).is_err() {
            // Only reachable if the daemon were started twice in one process.
            eprintln!("varlock: lock event sources were already started");
            return (wired, None);
        }

        let power = match register_suspend_notification() {
            Ok(handle) => {
                wired.push("windows:SuspendResume");
                Some(handle)
            }
            Err(err) => {
                eprintln!(
                    "varlock: not watching for sleep ({err}); sessions will run to their TTL instead"
                );
                None
            }
        };

        match start_session_notification_window() {
            Ok(()) => wired.push("windows:WTSSessionLock"),
            Err(err) => eprintln!(
                "varlock: not watching for workstation lock ({err}); sessions set to lock on screenLock will not"
            ),
        }

        (wired, power.map(|handle| WindowsSources { _power: handle }))
    }

    /// Suspend notifications go to a plain callback, so no window is involved.
    fn register_suspend_notification() -> Result<PowerRegistration, String> {
        let parameters = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: std::ptr::null_mut(),
        });
        // Leaked on purpose: Windows keeps the pointer for as long as the
        // registration lives, which is the daemon's whole life.
        let parameters = Box::into_raw(parameters);

        let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
        // Safety: `parameters` points at a live, correctly shaped struct that is
        // never freed, and `handle` is a valid output pointer.
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(parameters as *mut _),
                &mut handle,
            )
        };
        if status.is_err() {
            return Err(format!("PowerRegisterSuspendResumeNotification failed: {status:?}"));
        }
        Ok(PowerRegistration(handle))
    }

    /// PBT_APMSUSPEND is the machine going down. Resume events are ignored:
    /// sessions are erased on the way down and there is nothing to restore.
    unsafe extern "system" fn on_power_event(
        _context: *const std::ffi::c_void,
        event_type: u32,
        _setting: *const std::ffi::c_void,
    ) -> u32 {
        if event_type == PBT_APMSUSPEND {
            deliver(SessionLockEvent::Sleep);
        }
        0 // ERROR_SUCCESS
    }

    /// Workstation lock notifications need a window to be delivered to, so the
    /// daemon keeps a message-only one on its own thread. It is never shown and
    /// never appears in the taskbar; it exists to receive one message.
    fn start_session_notification_window() -> Result<(), String> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        std::thread::Builder::new()
            .name("varlock-session-watch".into())
            .spawn(move || {
                let result = create_message_window();
                let window = match result {
                    Ok(window) => {
                        let _ = ready_tx.send(Ok(()));
                        window
                    }
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };

                // A message-only window still needs a pump, and the pump has to
                // run on the thread that created the window.
                let mut message = MSG::default();
                // Safety: standard message loop over a window this thread owns.
                unsafe {
                    while GetMessageW(&mut message, window, 0, 0).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            })
            .map_err(|e| format!("could not start the session watcher: {e}"))?;

        ready_rx
            .recv()
            .map_err(|_| "the session watcher thread stopped before reporting".to_string())?
    }

    fn create_message_window() -> Result<HWND, String> {
        let class_name = windows::core::w!("VarlockSessionNotifyWindow");

        // Safety: GetModuleHandleW(None) returns this executable's handle.
        let instance = unsafe { GetModuleHandleW(None) }
            .map_err(|e| format!("GetModuleHandleW failed: {e}"))?;

        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        // Safety: `class` is fully initialized and outlives the call.
        // A zero return means the class could not be registered; registering the
        // same class twice in one process is the only benign failure and cannot
        // happen here, since the daemon starts this once.
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err("RegisterClassW failed".into());
        }

        // Safety: HWND_MESSAGE creates a message-only window with no UI.
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(class_name.as_ptr()),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                HMENU::default(),
                windows::Win32::Foundation::HINSTANCE::from(instance),
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW failed: {e}"))?;

        // Safety: the window was just created on this thread.
        unsafe {
            WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)
                .map_err(|e| format!("WTSRegisterSessionNotification failed: {e}"))?;
        }

        Ok(window)
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_WTSSESSION_CHANGE && wparam.0 as u32 == WTS_SESSION_LOCK {
            deliver(SessionLockEvent::ScreenLock);
            return LRESULT(0);
        }
        DefWindowProcW(window, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn starting_reports_which_triggers_are_live() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let sources = start(Arc::new(move |_event| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));

        // On a machine with no event sources (macOS development, a container
        // with no logind) this is empty, which is the honest answer rather than
        // a failure. What matters is that starting up never panics and never
        // invents an event.
        assert_eq!(count.load(Ordering::SeqCst), 0);
        for name in sources.wired() {
            assert!(!name.is_empty());
        }
    }
}
