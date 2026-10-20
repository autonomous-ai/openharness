//! The Windows half of harness-serial: SetupAPI and CfgMgr32 find the dial, an overlapped COM handle moves its
//! bytes. Every long-running command ends at end of stdin, which is how it ends with the daemon that started it,
//! however that daemon ends (a crash, TerminateProcess, an update handoff).

use std::ffi::c_void;
use std::io::{Read, Write};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use windows_sys::Win32::Devices::Communication::{
    COMMTIMEOUTS, DCB, GetCommState, NOPARITY, ONESTOPBIT, SetCommState, SetCommTimeouts,
};
use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_PropertyW, CM_Get_Device_IDW, CM_Get_Parent, CM_NOTIFY_ACTION,
    CM_NOTIFY_EVENT_DATA, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
    CM_Register_Notification, CM_Unregister_Notification, CR_SUCCESS, DICS_FLAG_GLOBAL,
    DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, DIREG_DEV, HCMNOTIFICATION, HDEVINFO, SP_DEVINFO_DATA,
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiOpenDevRegKey,
};
use windows_sys::Win32::Devices::Properties::{
    DEVPKEY_Device_LastArrivalDate, DEVPROP_TYPE_FILETIME, DEVPROPTYPE,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Ioctl::GUID_DEVINTERFACE_COMPORT;
use windows_sys::Win32::System::Registry::{KEY_READ, REG_SZ, RegCloseKey, RegQueryValueExW};
use windows_sys::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSGetActiveConsoleSessionId,
};
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcessId};

use crate::model::{self, Command, OpenFailure, Port, State};

pub fn run(command: Command) -> i32 {
    match command {
        Command::Watch => watch(),
        Command::Open(name) => open(&name),
        Command::Probe(name) => probe(&name),
        Command::Version => 0,
    }
}

// ---- finding the dial ---------------------------------------------------------------------------------------

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn describe(code: u32) -> String {
    std::io::Error::from_raw_os_error(code as i32).to_string()
}

struct DeviceInfo(HDEVINFO);

impl Drop for DeviceInfo {
    fn drop(&mut self) {
        unsafe { SetupDiDestroyDeviceInfoList(self.0) };
    }
}

/// Every present COM port that is the dial's serial interface, with its serial number and attachment.
fn dial_ports() -> Result<Vec<Port>, String> {
    let set: HDEVINFO = unsafe {
        SetupDiGetClassDevsW(
            &GUID_DEVINTERFACE_COMPORT,
            std::ptr::null(),
            std::ptr::null_mut(),
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        )
    };
    if set == -1 {
        return Err(format!(
            "SetupDiGetClassDevsW: {}",
            describe(unsafe { GetLastError() })
        ));
    }
    let set = DeviceInfo(set);
    let mut ports = Vec::new();
    let mut index = 0;
    loop {
        let mut info: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_ITEMS {
                break;
            }
            return Err(format!("SetupDiEnumDeviceInfo: {}", describe(code)));
        }
        index += 1;
        let mut id = [0u16; 512];
        if unsafe {
            SetupDiGetDeviceInstanceIdW(
                set.0,
                &info,
                id.as_mut_ptr(),
                id.len() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            continue;
        }
        if !model::is_dial_interface(&from_wide(&id)) {
            continue;
        }
        // An arrival can be reported before usbser writes PortName; `watch` looks again 500 ms later.
        let Some(path) = port_name(set.0, &info) else {
            continue;
        };
        let mut parent = 0u32;
        let (serial_number, session) =
            if unsafe { CM_Get_Parent(&mut parent, info.DevInst, 0) } == CR_SUCCESS {
                (
                    device_id(parent).and_then(|id| model::serial_from_parent(&id)),
                    last_arrival(parent),
                )
            } else {
                (None, None)
            };
        ports.push(Port {
            path,
            serial_number,
            session,
        });
    }
    Ok(ports)
}

/// `Device Parameters\PortName`, as usbser wrote it: `COM3`.
fn port_name(set: HDEVINFO, info: &SP_DEVINFO_DATA) -> Option<String> {
    let key = unsafe { SetupDiOpenDevRegKey(set, info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ) };
    if key as isize == -1 || key.is_null() {
        return None;
    }
    let name = wide("PortName");
    let mut buffer = [0u16; 32];
    let mut size = (buffer.len() * 2) as u32;
    let mut kind = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buffer.as_mut_ptr() as *mut u8,
            &mut size,
        )
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS || kind != REG_SZ {
        return None;
    }
    let port = from_wide(&buffer).to_ascii_uppercase();
    model::is_com_name(&port).then_some(port)
}

fn device_id(devinst: u32) -> Option<String> {
    let mut buffer = [0u16; 512];
    (unsafe { CM_Get_Device_IDW(devinst, buffer.as_mut_ptr(), buffer.len() as u32, 0) }
        == CR_SUCCESS)
        .then(|| from_wide(&buffer))
}

/// The composite device's DEVPKEY_Device_LastArrivalDate: when it was last plugged in.
fn last_arrival(devinst: u32) -> Option<String> {
    let mut kind: DEVPROPTYPE = 0;
    let mut value = 0u64;
    let mut size = 8u32;
    let status = unsafe {
        CM_Get_DevNode_PropertyW(
            devinst,
            &DEVPKEY_Device_LastArrivalDate,
            &mut kind,
            &mut value as *mut u64 as *mut u8,
            &mut size,
            0,
        )
    };
    (status == CR_SUCCESS && kind == DEVPROP_TYPE_FILETIME && size == 8).then(|| value.to_string())
}

/// Whether this process's session is the one at the screen. A Remote Desktop session is not; a user switched
/// away from is not. That user's daemon releases the dial (cable/cableFleet.ts, canUseUsb).
fn at_console() -> bool {
    let mut mine = 0u32;
    unsafe {
        ProcessIdToSessionId(GetCurrentProcessId(), &mut mine) != 0
            && WTSGetActiveConsoleSessionId() == mine
    }
}

// ---- watch --------------------------------------------------------------------------------------------------

/// The CLI scans every 2 s; reading the console that often costs one call into the kernel.
const CONSOLE_EVERY: Duration = Duration::from_secs(2);
/// An arrival can come before usbser writes PortName.
const LOOK_AGAIN_AFTER: Duration = Duration::from_millis(500);
/// A missed notification is caught within this, as macOS's DIAL_RESCAN_MS.
const SAFETY_NET: Duration = Duration::from_secs(300);

struct Notification(HCMNOTIFICATION);

impl Drop for Notification {
    fn drop(&mut self) {
        unsafe { CM_Unregister_Notification(self.0) };
    }
}

unsafe extern "system" fn on_change(
    _notification: HCMNOTIFICATION,
    context: *const c_void,
    _action: CM_NOTIFY_ACTION,
    _data: *const CM_NOTIFY_EVENT_DATA,
    _size: u32,
) -> u32 {
    // The context is the leaked Sender below; it lives for the whole process.
    let sender = unsafe { &*(context as *const mpsc::Sender<()>) };
    let _ = sender.send(());
    ERROR_SUCCESS
}

/// Arrivals and removals of any COM port interface. Called back on a system thread.
fn notify_changes(sender: mpsc::Sender<()>) -> Result<Notification, String> {
    let context: &'static mpsc::Sender<()> = Box::leak(Box::new(sender));
    let mut filter: CM_NOTIFY_FILTER = unsafe { std::mem::zeroed() };
    filter.cbSize = std::mem::size_of::<CM_NOTIFY_FILTER>() as u32;
    filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
    filter.u.DeviceInterface.ClassGuid = GUID_DEVINTERFACE_COMPORT;
    let mut handle: HCMNOTIFICATION = std::ptr::null_mut();
    let status = unsafe {
        CM_Register_Notification(
            &filter,
            context as *const mpsc::Sender<()> as *const c_void,
            Some(on_change),
            &mut handle,
        )
    };
    if status != CR_SUCCESS {
        return Err(format!("CM_Register_Notification failed ({status})"));
    }
    Ok(Notification(handle))
}

/// End the process at end of stdin: the daemon closed the pipe, or the daemon is gone.
fn exit_at_end_of_stdin() {
    std::thread::spawn(|| {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut sink) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(_) => {}
            }
        }
    });
}

fn print_line(line: &str) -> bool {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
}

fn watch() -> i32 {
    exit_at_end_of_stdin();
    let (sender, changes) = mpsc::channel();
    let _notification = match notify_changes(sender) {
        Ok(notification) => notification,
        Err(why) => {
            eprintln!("error: {why}");
            return model::EXIT_FAILED;
        }
    };
    let mut ports = match dial_ports() {
        Ok(ports) => ports,
        Err(why) => {
            eprintln!("error: {why}");
            return model::EXIT_FAILED;
        }
    };
    let mut looked = Instant::now();
    let mut again: Option<Instant> = None;
    let mut printed: Option<String> = None;
    loop {
        let line = State {
            console: at_console(),
            ports: ports.clone(),
        }
        .line();
        if printed.as_deref() != Some(line.as_str()) {
            if !print_line(&line) {
                return 0; // nobody is reading
            }
            printed = Some(line);
        }
        let wait = again.map_or(CONSOLE_EVERY, |at| {
            at.saturating_duration_since(Instant::now())
                .min(CONSOLE_EVERY)
        });
        let changed = match changes.recv_timeout(wait) {
            Ok(()) => {
                while changes.try_recv().is_ok() {}
                again = Some(Instant::now() + LOOK_AGAIN_AFTER);
                true
            }
            Err(mpsc::RecvTimeoutError::Timeout) => false,
            Err(mpsc::RecvTimeoutError::Disconnected) => return 0,
        };
        let due = again.is_some_and(|at| Instant::now() >= at);
        if due {
            again = None;
        }
        if changed || due || looked.elapsed() >= SAFETY_NET {
            match dial_ports() {
                Ok(next) => {
                    ports = next;
                    looked = Instant::now();
                }
                Err(why) => {
                    eprintln!("error: {why}");
                    return model::EXIT_FAILED;
                }
            }
        }
    }
}

// ---- open and probe -----------------------------------------------------------------------------------------

struct ComPort(HANDLE);

// The handle is used from the reader thread and the writer thread at once, which overlapped I/O allows.
unsafe impl Send for ComPort {}
unsafe impl Sync for ComPort {}

impl Drop for ComPort {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Share mode 0: a COM port is exclusive, and asking for that makes another program's open the error we see.
fn create(name: &str) -> Result<ComPort, u32> {
    let path = wide(&model::device_path(name));
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(unsafe { GetLastError() })
    } else {
        Ok(ComPort(handle))
    }
}

fn refuse(code: u32) -> i32 {
    match model::open_failure(code) {
        OpenFailure::Busy => {
            eprintln!("busy");
            model::EXIT_BUSY
        }
        OpenFailure::Gone => {
            eprintln!("gone");
            model::EXIT_GONE
        }
        OpenFailure::Other => {
            eprintln!("error: {}", describe(code));
            model::EXIT_CLOSED
        }
    }
}

/// Raw, with DTR/RTS set together in this one call (model::DCB_RAW says why). Reads return as soon as any
/// byte is there, or after 1 s with none, so the reader wakes once a second at most while the dial is quiet.
fn configure(port: &ComPort) -> Result<(), String> {
    let mut dcb: DCB = unsafe { std::mem::zeroed() };
    dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
    if unsafe { GetCommState(port.0, &mut dcb) } == 0 {
        return Err(format!(
            "GetCommState: {}",
            describe(unsafe { GetLastError() })
        ));
    }
    dcb.BaudRate = 115_200; // USB-Serial/JTAG ignores it; a driver that checks it gets a real one
    dcb._bitfield = model::DCB_RAW;
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    if unsafe { SetCommState(port.0, &dcb) } == 0 {
        return Err(format!(
            "SetCommState: {}",
            describe(unsafe { GetLastError() })
        ));
    }
    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: u32::MAX,
        ReadTotalTimeoutConstant: 1000,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 0,
    };
    if unsafe { SetCommTimeouts(port.0, &timeouts) } == 0 {
        return Err(format!(
            "SetCommTimeouts: {}",
            describe(unsafe { GetLastError() })
        ));
    }
    Ok(())
}

struct Event(HANDLE);

impl Event {
    fn new() -> Event {
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            closed(unsafe { GetLastError() });
        }
        Event(handle)
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// One overlapped ReadFile or WriteFile, waited for. Ok(bytes) or Err(the Windows error).
fn overlapped(
    port: &ComPort,
    event: &Event,
    start: impl FnOnce(*mut OVERLAPPED) -> i32,
) -> Result<u32, u32> {
    let mut request: OVERLAPPED = unsafe { std::mem::zeroed() };
    request.hEvent = event.0;
    if start(&mut request) == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_IO_PENDING {
            return Err(code);
        }
    }
    let mut done = 0u32;
    if unsafe { GetOverlappedResult(port.0, &request, &mut done, 1) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    Ok(done)
}

fn closed(code: u32) -> ! {
    eprintln!("closed: {}", describe(code));
    std::process::exit(model::EXIT_CLOSED)
}

/// Port to stdout until the port fails (an unplug: the process ends, exit 5).
fn pump_out(port: &ComPort) {
    let event = Event::new();
    let mut buffer = vec![0u8; 16 * 1024];
    let mut stdout = std::io::stdout().lock();
    loop {
        let into = buffer.as_mut_ptr();
        let size = buffer.len() as u32;
        match overlapped(port, &event, |request| unsafe {
            ReadFile(port.0, into, size, std::ptr::null_mut(), request)
        }) {
            Ok(0) => {} // a quiet second
            Ok(read) => {
                if stdout
                    .write_all(&buffer[..read as usize])
                    .and_then(|_| stdout.flush())
                    .is_err()
                {
                    std::process::exit(0); // nobody is reading
                }
            }
            Err(code) => closed(code),
        }
    }
}

/// Read stdin independently of a possibly stalled COM write: EOF must release the port even then.
/// As for watch, process exit closes all handles and outstanding I/O without a cancellation race.
fn stdin_chunks() -> mpsc::Receiver<Vec<u8>> {
    let (sender, incoming) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(read) => {
                    if sender.send(buffer[..read].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
    });
    incoming
}

/// Write each stdin chunk whole before the next; EOF closes the process independently of writer progress.
fn pump_in(port: &ComPort, incoming: mpsc::Receiver<Vec<u8>>) {
    let event = Event::new();
    for buffer in incoming {
        let read = buffer.len();
        let mut sent = 0;
        while sent < read {
            let chunk = &buffer[sent..read];
            match overlapped(port, &event, |request| unsafe {
                WriteFile(
                    port.0,
                    chunk.as_ptr(),
                    chunk.len() as u32,
                    std::ptr::null_mut(),
                    request,
                )
            }) {
                Ok(0) => closed(1167), // nothing taken: the device is not there
                Ok(written) => sent += written as usize,
                Err(code) => closed(code),
            }
        }
    }
}

fn open(name: &str) -> i32 {
    let port = match create(name) {
        Ok(port) => port,
        Err(code) => return refuse(code),
    };
    if let Err(why) = configure(&port) {
        eprintln!("error: {why}");
        return model::EXIT_CLOSED;
    }
    eprintln!("open");
    let port = Arc::new(port);
    {
        let port = port.clone();
        std::thread::spawn(move || pump_out(&port));
    }
    pump_in(&port, stdin_chunks());
    0
}

/// Whether another program holds the port: configure it exactly as open does, then close without moving bytes.
fn probe(name: &str) -> i32 {
    match create(name) {
        Ok(port) => {
            if let Err(why) = configure(&port) {
                eprintln!("error: {why}");
                return model::EXIT_CLOSED;
            }
            0
        }
        Err(code) => match model::open_failure(code) {
            OpenFailure::Busy => model::EXIT_BUSY,
            OpenFailure::Gone => model::EXIT_GONE,
            OpenFailure::Other => {
                eprintln!("error: {}", describe(code));
                model::EXIT_CLOSED
            }
        },
    }
}
