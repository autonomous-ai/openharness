//! The Start Menu shortcut, `<FOLDERID_Programs>\Harness.lnk`, through the shell's COM objects: `IShellLinkW` for
//! the target, `IPropertyStore` for `System.AppUserModel.ID` (`PKEY_AppUserModel_ID`), and `IPersistFile` to save
//! it. An unpackaged app's toasts need that AUMID on a Start Menu shortcut (desktop spec section 2.1), and the app
//! sets the same one on its process, so its windows group under the shortcut a person pinned.
//!
//! windows-sys has the functions and the `ShellLink` CLSID but no COM interfaces, so the three interfaces' virtual
//! tables are declared here, in the order ShObjIdl_core.h, ObjIdl.h and PropSys.h give them. Only the slots called
//! have a type; the others are placeholders of the same size.

pub const LINK_NAME: &str = "Harness.lnk";

#[cfg(windows)]
mod com {
    use std::ffi::{OsStr, OsString, c_void};
    use std::io;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use std::ptr::null_mut;

    use windows_sys::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::ShellLink;
    use windows_sys::core::{GUID, HRESULT, PCWSTR, PWSTR};

    const IID_ISHELLLINKW: GUID = GUID::from_u128(0x000214f9_0000_0000_c000_000000000046);
    const IID_IPERSISTFILE: GUID = GUID::from_u128(0x0000010b_0000_0000_c000_000000000046);
    const IID_IPROPERTYSTORE: GUID = GUID::from_u128(0x886d8eeb_8cf2_4446_8d02_cdba1dbdcf99);
    /// PKEY_AppUserModel_ID: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5.
    const PKEY_APPUSERMODEL_ID: PropertyKey = PropertyKey {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };
    const VT_LPWSTR: u16 = 31;
    const STGM_READ: u32 = 0;
    /// IShellLinkW::GetPath: the path as stored, environment strings not expanded.
    const SLGP_RAWPATH: u32 = 4;

    #[repr(C)]
    struct PropertyKey {
        fmtid: GUID,
        pid: u32,
    }

    /// A PROPVARIANT holding one pointer (VT_LPWSTR): 24 bytes on a 64-bit Windows, as the real one.
    #[repr(C)]
    struct PropVariant {
        vt: u16,
        reserved: [u16; 3],
        pointer: *mut u16,
        rest: usize,
    }

    type Slot = usize;

    #[repr(C)]
    struct Unknown {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
    }

    #[repr(C)]
    struct ShellLinkW {
        unknown: Unknown,
        get_path: unsafe extern "system" fn(*mut c_void, PWSTR, i32, *mut c_void, u32) -> HRESULT,
        get_id_list: Slot,
        set_id_list: Slot,
        get_description: Slot,
        set_description: unsafe extern "system" fn(*mut c_void, PCWSTR) -> HRESULT,
        get_working_directory: unsafe extern "system" fn(*mut c_void, PWSTR, i32) -> HRESULT,
        set_working_directory: unsafe extern "system" fn(*mut c_void, PCWSTR) -> HRESULT,
        get_arguments: Slot,
        set_arguments: Slot,
        get_hotkey: Slot,
        set_hotkey: Slot,
        get_show_cmd: Slot,
        set_show_cmd: Slot,
        get_icon_location: unsafe extern "system" fn(*mut c_void, PWSTR, i32, *mut i32) -> HRESULT,
        set_icon_location: unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT,
        set_relative_path: Slot,
        resolve: Slot,
        set_path: unsafe extern "system" fn(*mut c_void, PCWSTR) -> HRESULT,
    }

    #[repr(C)]
    struct PersistFile {
        unknown: Unknown,
        get_class_id: Slot,
        is_dirty: Slot,
        load: unsafe extern "system" fn(*mut c_void, PCWSTR, u32) -> HRESULT,
        save: unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT,
        save_completed: Slot,
        get_cur_file: Slot,
    }

    #[repr(C)]
    struct PropertyStore {
        unknown: Unknown,
        get_count: Slot,
        get_at: Slot,
        get_value:
            unsafe extern "system" fn(*mut c_void, *const PropertyKey, *mut PropVariant) -> HRESULT,
        set_value: unsafe extern "system" fn(
            *mut c_void,
            *const PropertyKey,
            *const PropVariant,
        ) -> HRESULT,
        commit: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    }

    fn check(hr: HRESULT) -> io::Result<()> {
        if hr < 0 {
            Err(io::Error::from_raw_os_error(hr))
        } else {
            Ok(())
        }
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// COM on this thread for as long as it lives.
    struct Apartment(bool);
    impl Apartment {
        fn enter() -> io::Result<Apartment> {
            // S_FALSE (already entered) is a success to undo as well; RPC_E_CHANGED_MODE is a usable apartment.
            let hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
            if hr == 0x80010106u32 as i32 {
                return Ok(Apartment(false));
            }
            check(hr)?;
            Ok(Apartment(true))
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// One interface pointer, released when dropped.
    struct Object(*mut c_void);
    impl Object {
        fn table<T>(&self) -> &T {
            unsafe { &**(self.0 as *mut *const T) }
        }
        fn query(&self, iid: &GUID) -> io::Result<Object> {
            let mut out = null_mut();
            check(unsafe { (self.table::<Unknown>().query_interface)(self.0, iid, &mut out) })?;
            Ok(Object(out))
        }
    }
    impl Drop for Object {
        fn drop(&mut self) {
            unsafe { (self.table::<Unknown>().release)(self.0) };
        }
    }

    fn shell_link() -> io::Result<Object> {
        let mut out = null_mut();
        check(unsafe {
            CoCreateInstance(
                &ShellLink,
                null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_ISHELLLINKW,
                &mut out,
            )
        })?;
        Ok(Object(out))
    }

    pub fn create(
        link: &Path,
        target: &Path,
        icon: &Path,
        dir: &Path,
        aumid: &str,
    ) -> io::Result<()> {
        let _apartment = Apartment::enter()?;
        let object = shell_link()?;
        let table = object.table::<ShellLinkW>();
        unsafe {
            check((table.set_path)(
                object.0,
                wide(target.as_os_str()).as_ptr(),
            ))?;
            check((table.set_working_directory)(
                object.0,
                wide(dir.as_os_str()).as_ptr(),
            ))?;
            check((table.set_description)(
                object.0,
                wide(OsStr::new(super::super::DISPLAY_NAME)).as_ptr(),
            ))?;
            check((table.set_icon_location)(
                object.0,
                wide(icon.as_os_str()).as_ptr(),
                0,
            ))?;
        }
        let store = object.query(&IID_IPROPERTYSTORE)?;
        let id = wide(OsStr::new(aumid));
        let value = PropVariant {
            vt: VT_LPWSTR,
            reserved: [0; 3],
            pointer: id.as_ptr() as *mut u16,
            rest: 0,
        };
        unsafe {
            check((store.table::<PropertyStore>().set_value)(
                store.0,
                &PKEY_APPUSERMODEL_ID,
                &value,
            ))?;
            check((store.table::<PropertyStore>().commit)(store.0))?;
        }
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = object.query(&IID_IPERSISTFILE)?;
        check(unsafe {
            (file.table::<PersistFile>().save)(file.0, wide(link.as_os_str()).as_ptr(), 1)
        })
    }

    /// The target and the AUMID a shortcut holds (the tests', and a check after an install).
    pub fn read(link: &Path) -> io::Result<(PathBuf, String)> {
        let _apartment = Apartment::enter()?;
        let object = shell_link()?;
        let file = object.query(&IID_IPERSISTFILE)?;
        check(unsafe {
            (file.table::<PersistFile>().load)(file.0, wide(link.as_os_str()).as_ptr(), STGM_READ)
        })?;
        let mut buffer = vec![0u16; 32_768];
        check(unsafe {
            (object.table::<ShellLinkW>().get_path)(
                object.0,
                buffer.as_mut_ptr(),
                buffer.len() as i32,
                null_mut(),
                SLGP_RAWPATH,
            )
        })?;
        let length = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        let target = PathBuf::from(OsString::from_wide(&buffer[..length]));
        let store = object.query(&IID_IPROPERTYSTORE)?;
        let mut value = PropVariant {
            vt: 0,
            reserved: [0; 3],
            pointer: null_mut(),
            rest: 0,
        };
        check(unsafe {
            (store.table::<PropertyStore>().get_value)(store.0, &PKEY_APPUSERMODEL_ID, &mut value)
        })?;
        let mut aumid = String::new();
        if value.vt == VT_LPWSTR && !value.pointer.is_null() {
            let length = (0..)
                .take_while(|&i| unsafe { *value.pointer.add(i) } != 0)
                .count();
            aumid = String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(value.pointer, length)
            });
            unsafe { CoTaskMemFree(value.pointer as *const c_void) };
        }
        Ok((target, aumid))
    }

    #[test]
    fn shortcut_readback_keeps_target_icon_working_directory_and_aumid() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("Nguyễn Văn A' & 100% !x");
        std::fs::create_dir_all(&install).unwrap();
        let target = install.join("Harness.exe");
        let icon = install.join("Harness.ico");
        std::fs::write(&target, b"fixture").unwrap();
        std::fs::write(&icon, b"fixture").unwrap();
        let link = dir.path().join("programs/Harness.lnk");
        create(&link, &target, &icon, &install, "Autonomous.Harness").unwrap();
        let (got, id) = read(&link).unwrap();
        assert!(super::super::same_folder(got.parent().unwrap(), &install));
        assert_eq!(got.file_name().unwrap(), "Harness.exe");
        assert_eq!(id, "Autonomous.Harness");
        let _apartment = Apartment::enter().unwrap();
        let object = shell_link().unwrap();
        let file = object.query(&IID_IPERSISTFILE).unwrap();
        check(unsafe {
            (file.table::<PersistFile>().load)(file.0, wide(link.as_os_str()).as_ptr(), STGM_READ)
        })
        .unwrap();
        let mut buffer = vec![0u16; 32_768];
        check(unsafe {
            (object.table::<ShellLinkW>().get_working_directory)(
                object.0,
                buffer.as_mut_ptr(),
                buffer.len() as i32,
            )
        })
        .unwrap();
        let end = buffer.iter().position(|&c| c == 0).unwrap();
        assert!(super::super::same_folder(
            Path::new(&OsString::from_wide(&buffer[..end])),
            &install
        ));
        buffer.fill(0);
        let mut index = -1;
        check(unsafe {
            (object.table::<ShellLinkW>().get_icon_location)(
                object.0,
                buffer.as_mut_ptr(),
                buffer.len() as i32,
                &mut index,
            )
        })
        .unwrap();
        let end = buffer.iter().position(|&c| c == 0).unwrap();
        let got_icon = PathBuf::from(OsString::from_wide(&buffer[..end]));
        assert!(super::super::same_folder(
            got_icon.parent().unwrap(),
            &install
        ));
        assert_eq!(got_icon.file_name().unwrap(), "Harness.ico");
        assert_eq!(index, 0);
    }

    #[test]
    fn the_variant_is_the_size_windows_reads() {
        assert_eq!(
            std::mem::size_of::<PropVariant>(),
            if cfg!(target_pointer_width = "64") {
                24
            } else {
                16
            }
        );
    }
}

#[cfg(windows)]
pub use com::{create, read};
