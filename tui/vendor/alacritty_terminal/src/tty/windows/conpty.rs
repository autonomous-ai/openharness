use log::{info, warn};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{Error, Result};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::IntoRawHandle;
use std::{mem, ptr};

use windows_sys::Win32::Foundation::{HANDLE, S_OK};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    LoadLibraryExW,
};
use windows_sys::core::{HRESULT, PWSTR};
use windows_sys::{s, w};

use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, EXTENDED_STARTUPINFO_PRESENT,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, UpdateProcThreadAttribute,
};
// hn: the child's Job Object (`Options::job`).
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::Threading::{CREATE_SUSPENDED, ResumeThread, TerminateProcess};

use crate::event::{OnResize, WindowSize};
use crate::tty::Options;
use crate::tty::windows::blocking::{UnblockedReader, UnblockedWriter};
use crate::tty::windows::child::ChildExitWatcher;
use crate::tty::windows::{Pty, cmdline, win32_string};

const PIPE_CAPACITY: usize = crate::event_loop::READ_BUFFER_SIZE;

/// Load the pseudoconsole API from conpty.dll if possible, otherwise use the
/// standard Windows API.
///
/// The conpty.dll from the Windows Terminal project
/// supports loading OpenConsole.exe, which offers many improvements and
/// bugfixes compared to the standard conpty that ships with Windows.
///
/// hn: conpty.dll is loaded only from the directory of the executable (or
/// System32), never through PATH or the current directory, where anyone who can
/// write a folder on PATH could plant one; upstream used `LoadLibraryW`.
/// conpty.dll finds OpenConsole.exe beside itself.
type CreatePseudoConsoleFn =
    unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> HRESULT;
type ResizePseudoConsoleFn = unsafe extern "system" fn(HPCON, COORD) -> HRESULT;
type ClosePseudoConsoleFn = unsafe extern "system" fn(HPCON);

struct ConptyApi {
    create: CreatePseudoConsoleFn,
    resize: ResizePseudoConsoleFn,
    close: ClosePseudoConsoleFn,
}

impl ConptyApi {
    fn new() -> Self {
        match Self::load_conpty() {
            Some(conpty) => {
                info!("Using conpty.dll for pseudoconsole");
                conpty
            },
            None => {
                // Cannot load conpty.dll - use the standard Windows API.
                info!("Using Windows API for pseudoconsole");
                Self {
                    create: CreatePseudoConsole,
                    resize: ResizePseudoConsole,
                    close: ClosePseudoConsole,
                }
            },
        }
    }

    /// Try loading ConptyApi from conpty.dll library.
    fn load_conpty() -> Option<Self> {
        type LoadedFn = unsafe extern "system" fn() -> isize;
        unsafe {
            // hn: no PATH search (see above).
            let hmodule = LoadLibraryExW(
                w!("conpty.dll"),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if hmodule.is_null() {
                return None;
            }
            let create_fn = GetProcAddress(hmodule, s!("CreatePseudoConsole"))?;
            let resize_fn = GetProcAddress(hmodule, s!("ResizePseudoConsole"))?;
            let close_fn = GetProcAddress(hmodule, s!("ClosePseudoConsole"))?;

            Some(Self {
                create: mem::transmute::<LoadedFn, CreatePseudoConsoleFn>(create_fn),
                resize: mem::transmute::<LoadedFn, ResizePseudoConsoleFn>(resize_fn),
                close: mem::transmute::<LoadedFn, ClosePseudoConsoleFn>(close_fn),
            })
        }
    }
}

/// RAII Pseudoconsole.
pub struct Conpty {
    pub handle: HPCON,
    api: ConptyApi,
}

impl Drop for Conpty {
    fn drop(&mut self) {
        // hn: this may block until the conout pipe is drained or broken. `Pty` drops its
        // `conout` first (the deliberate field order in windows/mod.rs), which breaks the pipe,
        // so the close never waits for a drain.
        //
        // See https://docs.microsoft.com/en-us/windows/console/closepseudoconsole.
        unsafe { (self.api.close)(self.handle) }
    }
}

// The ConPTY handle can be sent between threads.
unsafe impl Send for Conpty {}

pub fn new(config: &Options, window_size: WindowSize) -> Result<Pty> {
    let api = ConptyApi::new();
    let mut pty_handle: HPCON = 0;

    // Passing 0 as the size parameter allows the "system default" buffer
    // size to be used. There may be small performance and memory advantages
    // to be gained by tuning this in the future, but it's likely a reasonable
    // start point.
    let (conout, conout_pty_handle) = miow::pipe::anonymous(0)?;
    let (conin_pty_handle, conin) = miow::pipe::anonymous(0)?;

    // Create the Pseudo Console, using the pipes.
    let result = unsafe {
        (api.create)(
            window_size.into(),
            conin_pty_handle.into_raw_handle() as HANDLE,
            conout_pty_handle.into_raw_handle() as HANDLE,
            0,
            &mut pty_handle as *mut _,
        )
    };

    assert_eq!(result, S_OK);

    // hn: every failure from here to the running child closes the pseudoconsole (after the pipes,
    // so the close cannot wait for a drain). Left open, its console process (OpenConsole.exe)
    // outlives a failed spawn: a host that is asked for a missing program would leak one per try.
    let spawned = (|| -> Result<PROCESS_INFORMATION> {
    let mut success;

    // Prepare child process startup info.

    let mut size: usize = 0;

    let mut startup_info_ex: STARTUPINFOEXW = unsafe { mem::zeroed() };

    startup_info_ex.StartupInfo.lpTitle = std::ptr::null_mut() as PWSTR;

    startup_info_ex.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;

    // Setting this flag but leaving all the handles as default (null) ensures the
    // PTY process does not inherit any handles from this Alacritty process.
    startup_info_ex.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;

    // Create the appropriately sized thread attribute list.
    unsafe {
        let failure =
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size as *mut usize) > 0;

        // This call was expected to return false.
        if failure {
            return Err(Error::last_os_error());
        }
    }

    let mut attr_list: Box<[u8]> = vec![0; size].into_boxed_slice();

    // Set startup info's attribute list & initialize it
    //
    // Lint failure is spurious; it's because winapi's definition of PROC_THREAD_ATTRIBUTE_LIST
    // implies it is one pointer in size (32 or 64 bits) but really this is just a dummy value.
    // Casting a *mut u8 (pointer to 8 bit type) might therefore not be aligned correctly in
    // the compiler's eyes.
    #[allow(clippy::cast_ptr_alignment)]
    {
        startup_info_ex.lpAttributeList = attr_list.as_mut_ptr() as _;
    }

    unsafe {
        success = InitializeProcThreadAttributeList(
            startup_info_ex.lpAttributeList,
            1,
            0,
            &mut size as *mut usize,
        ) > 0;

        if !success {
            return Err(Error::last_os_error());
        }
    }

    // Set thread attribute list's Pseudo Console to the specified ConPTY.
    unsafe {
        success = UpdateProcThreadAttribute(
            startup_info_ex.lpAttributeList,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            pty_handle as *mut std::ffi::c_void,
            mem::size_of::<HPCON>(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) > 0;

        if !success {
            return Err(Error::last_os_error());
        }
    }

    // Prepare child process creation arguments.
    let cmdline = win32_string(&cmdline(config));
    let cwd = config.working_directory.as_ref().map(win32_string);
    let mut creation_flags = EXTENDED_STARTUPINFO_PRESENT;
    let custom_env_block = convert_custom_env(&config.env, &config.env_remove);
    let custom_env_block_pointer = match &custom_env_block {
        Some(custom_env_block) => {
            creation_flags |= CREATE_UNICODE_ENVIRONMENT;
            custom_env_block.as_ptr() as *mut std::ffi::c_void
        },
        None => ptr::null_mut(),
    };

    // hn: a child for a Job Object starts suspended, so it is in the job before it can start
    // anything.
    if config.job.is_some() {
        creation_flags |= CREATE_SUSPENDED;
    }

    let mut proc_info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    unsafe {
        success = CreateProcessW(
            ptr::null(),
            cmdline.as_ptr() as PWSTR,
            ptr::null_mut(),
            ptr::null_mut(),
            false as i32,
            creation_flags,
            custom_env_block_pointer,
            cwd.as_ref().map_or_else(ptr::null, |s| s.as_ptr()),
            &mut startup_info_ex.StartupInfo as *mut STARTUPINFOW,
            &mut proc_info as *mut PROCESS_INFORMATION,
        ) > 0;

        if !success {
            return Err(Error::last_os_error());
        }
    }

    // hn: put the suspended child in the job, then let it run. A child that cannot join the job
    // never runs: it is terminated, and the pseudoconsole closed (after its output pipe, so the
    // close cannot wait for a drain).
    if let Some(job) = config.job {
        unsafe {
            if AssignProcessToJobObject(job as HANDLE, proc_info.hProcess) == 0
                || ResumeThread(proc_info.hThread) == u32::MAX
            {
                let err = Error::last_os_error();
                TerminateProcess(proc_info.hProcess, 1);
                CloseHandle(proc_info.hThread);
                CloseHandle(proc_info.hProcess);
                return Err(err);
            }
            CloseHandle(proc_info.hThread);
        }
    }
    Ok(proc_info)
    })();
    let proc_info = match spawned {
        Ok(info) => info,
        Err(err) => {
            drop(conout);
            drop(conin);
            unsafe { (api.close)(pty_handle) };
            return Err(err);
        },
    };

    let conin = UnblockedWriter::new(conin, PIPE_CAPACITY);
    let conout = UnblockedReader::new(conout, PIPE_CAPACITY);

    let child_watcher = ChildExitWatcher::new(proc_info.hProcess)?;
    let conpty = Conpty { handle: pty_handle as HPCON, api };

    Ok(Pty::new(conpty, conout, conin, child_watcher))
}

// Windows environment variables are case-insensitive, and the caller is responsible for
// deduplicating environment variables, so do that here while converting.
//
// https://learn.microsoft.com/en-us/previous-versions/troubleshoot/windows/win32/createprocess-cannot-eliminate-duplicate-variables#environment-variables
//
// hn: `remove` names inherited variables the child must not get (`Options::env_remove`): they are
// taken as already present, so the inherited pass below skips them, whatever their case.
fn convert_custom_env(
    custom_env: &HashMap<String, String>,
    remove: &[String],
) -> Option<Vec<u16>> {
    // Windows inherits parent's env when no `lpEnvironment` parameter is specified.
    if custom_env.is_empty() && remove.is_empty() {
        return None;
    }

    let mut converted_block = Vec::new();
    let mut all_env_keys = HashSet::new();
    for (custom_key, custom_value) in custom_env {
        let custom_key_os = OsStr::new(custom_key);
        if all_env_keys.insert(custom_key_os.to_ascii_uppercase()) {
            add_windows_env_key_value_to_block(
                &mut converted_block,
                custom_key_os,
                OsStr::new(&custom_value),
            );
        } else {
            warn!(
                "Omitting environment variable pair with duplicate key: \
                 '{custom_key}={custom_value}'"
            );
        }
    }

    for name in remove {
        all_env_keys.insert(OsStr::new(name).to_ascii_uppercase());
    }

    // Pull the current process environment after, to avoid overwriting the user provided one.
    for (inherited_key, inherited_value) in std::env::vars_os() {
        if all_env_keys.insert(inherited_key.to_ascii_uppercase()) {
            add_windows_env_key_value_to_block(
                &mut converted_block,
                &inherited_key,
                &inherited_value,
            );
        }
    }

    converted_block.push(0);
    Some(converted_block)
}

// According to the `lpEnvironment` parameter description:
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa#parameters
//
// > An environment block consists of a null-terminated block of null-terminated strings. Each
// string is in the following form:
// >
// > name=value\0
fn add_windows_env_key_value_to_block(block: &mut Vec<u16>, key: &OsStr, value: &OsStr) {
    block.extend(key.encode_wide());
    block.push('=' as u16);
    block.extend(value.encode_wide());
    block.push(0);
}

impl OnResize for Conpty {
    fn on_resize(&mut self, window_size: WindowSize) {
        let result = unsafe { (self.api.resize)(self.handle, window_size.into()) };
        assert_eq!(result, S_OK);
    }
}

impl From<WindowSize> for COORD {
    fn from(window_size: WindowSize) -> Self {
        let lines = window_size.num_lines;
        let columns = window_size.num_cols;
        COORD { X: columns as i16, Y: lines as i16 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables(block: &[u16]) -> Vec<String> {
        String::from_utf16(block)
            .unwrap()
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect()
    }

    // hn: `Options::env_remove` takes names out of what is inherited, whatever their case; what the
    // caller sets is still set.
    #[test]
    fn env_remove_leaves_out_inherited_names_in_any_case() {
        // SAFETY: a name of this test's own, set before any thread it starts reads the environment.
        unsafe { std::env::set_var("HN_REMOVED_SECRET", "secret") };
        assert!(convert_custom_env(&HashMap::new(), &[]).is_none());
        let custom = HashMap::from([("HN_SET".to_owned(), "set".to_owned())]);
        let block = convert_custom_env(&custom, &["hn_removed_secret".to_owned(), "HN_SET".to_owned()]).unwrap();
        let vars = variables(&block);
        assert!(vars.iter().all(|v| !v.to_ascii_uppercase().starts_with("HN_REMOVED_SECRET=")), "{vars:?}");
        assert!(vars.contains(&"HN_SET=set".to_owned()));
        assert!(vars.iter().any(|v| v.to_ascii_uppercase().starts_with("PATH=")));
        // Removal alone still builds a block, without the name.
        let block = convert_custom_env(&HashMap::new(), &["HN_REMOVED_SECRET".to_owned()]).unwrap();
        assert!(variables(&block).iter().all(|v| !v.starts_with("HN_REMOVED_SECRET=")));
        unsafe { std::env::remove_var("HN_REMOVED_SECRET") };
    }
}
