//! Unix process facts tmux shows for a pane: its tty and its foreground command.

use std::os::fd::RawFd;

/// The device name of the pty whose master is `master` (`/dev/pts/3`, `/dev/ttys004`).
#[cfg(target_os = "linux")]
pub fn tty_name(master: RawFd) -> Option<String> {
    let mut buf = [0 as libc::c_char; 128];
    if unsafe { libc::ptsname_r(master, buf.as_mut_ptr(), buf.len()) } != 0 {
        return None;
    }
    c_string(&buf)
}

#[cfg(target_os = "macos")]
pub fn tty_name(master: RawFd) -> Option<String> {
    let mut buf = [0 as libc::c_char; 128];
    if unsafe { libc::ioctl(master, libc::TIOCPTYGNAME as _, buf.as_mut_ptr()) } != 0 {
        return None;
    }
    c_string(&buf)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn tty_name(_master: RawFd) -> Option<String> {
    None
}

/// The name of the foreground process of `root`'s terminal, as tmux's `pane_current_command`.
#[cfg(target_os = "linux")]
pub fn foreground_name(root: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{root}/stat")).ok()?;
    // pid (comm) state ppid pgrp session tty_nr tpgid …: the fields after the last `)`.
    let tpgid: i32 = stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(5)?
        .parse()
        .ok()?;
    if tpgid <= 0 {
        return None;
    }
    let comm = std::fs::read_to_string(format!("/proc/{tpgid}/comm")).ok()?;
    Some(comm.trim_end_matches('\n').to_owned()).filter(|c| !c.is_empty())
}

#[cfg(target_os = "macos")]
pub fn foreground_name(root: u32) -> Option<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe {
        libc::proc_pidinfo(
            root as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if got != size || info.e_tpgid == 0 {
        return None;
    }
    let mut buf = [0 as libc::c_char; 256];
    let len = unsafe {
        libc::proc_name(
            info.e_tpgid as libc::c_int,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
        )
    };
    if len <= 0 {
        return None;
    }
    c_string(&buf)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn foreground_name(_root: u32) -> Option<String> {
    None
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn c_string(buf: &[libc::c_char]) -> Option<String> {
    let bytes: Vec<u8> = buf
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}
