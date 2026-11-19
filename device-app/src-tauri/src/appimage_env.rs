//! Linux: what the app starts gets the environment the person started the app with, not the one its AppImage gave it.
//! The AppImage's runtime, its AppRun and linuxdeploy's GTK hook set some twenty variables for the app alone and keep
//! no copy of what they replaced. Handed on, PYTHONHOME kills xdg-open's Python, and LD_LIBRARY_PATH and the GTK paths
//! load the AppImage's libraries into a browser built for another distribution.

use std::collections::BTreeMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Command;

type Vars = BTreeMap<OsString, OsString>;

/// What the AppImage sets that names no path in it, each over whatever the person had: the runtime's APPIMAGE, ARGV0
/// and OWD, AppRun's PYTHONDONTWRITEBYTECODE and the GTK hook's GTK_THEME.
const SET_BY_APPIMAGE: [&str; 5] = ["APPIMAGE", "ARGV0", "OWD", "PYTHONDONTWRITEBYTECODE", "GTK_THEME"];

/// Gives `command` the environment it would start with, the app's and its own, without what the AppImage added.
/// Outside an AppImage it is left as it is.
pub fn remove(command: &mut Command) {
    let mut vars: Vars = env::vars_os().collect();
    for (name, value) in command.get_envs() {
        match value {
            Some(value) => vars.insert(name.into(), value.into()),
            None => vars.remove(name),
        };
    }
    if let Some(vars) = without_appimage(vars) {
        command.env_clear().envs(vars);
    }
}

/// `vars` without what the AppImage mounted at their APPDIR added, None when they name no APPDIR (Tauri, too, takes
/// APPDIR for the AppImage's; its runtime sets it over any the person had). Every variable loses its entries under
/// APPDIR (`outside`), and SET_BY_APPIMAGE go. The rest is the person's: the GTK hook's `/usr/share` after its own in
/// XDG_DATA_DIRS stays too, a folder the system lists anyway.
fn without_appimage(vars: Vars) -> Option<Vars> {
    let appdir = PathBuf::from(vars.get(OsStr::new("APPDIR"))?);
    if !appdir.is_absolute() {
        return None;
    }
    let not_set_by_appimage = |(name, _): &(OsString, OsString)| !SET_BY_APPIMAGE.iter().any(|set| name == set);
    let kept = vars.into_iter().filter(not_set_by_appimage);
    Some(kept.filter_map(|(name, value)| Some((name, outside(value, &appdir)?))).collect())
}

/// `value`, a `:` list or a single path, without its entries under `appdir` (APPDIR itself among them); kept byte for
/// byte when it has none. None when only empty entries are left: the `:` the AppImage put before a value the person
/// did not have.
fn outside(value: OsString, appdir: &Path) -> Option<OsString> {
    let inside = |entry: &&[u8]| Path::new(OsStr::from_bytes(entry)).starts_with(appdir);
    let entries: Vec<&[u8]> = value.as_bytes().split(|&byte| byte == b':').collect();
    if !entries.iter().any(inside) {
        return Some(value);
    }
    let left: Vec<&[u8]> = entries.into_iter().filter(|entry| !inside(entry)).collect();
    (!left.iter().all(|entry| entry.is_empty())).then(|| OsString::from_vec(left.join(&b':')))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Where the AppImage is mounted.
    pub(crate) const APPDIR: &str = "/tmp/.mount_HarnesAbC123";
    /// The person's PATH, which the app was started with.
    pub(crate) const PERSON_PATH: &str = "/usr/bin:/bin";
    /// What the end-to-end run started the app with: no list of its own but PATH.
    const LAUNCHED: [(&str, &str); 4] =
        [("HOME", "/home/p"), ("LANG", "C.UTF-8"), ("PATH", PERSON_PATH), ("DISPLAY", ":1")];

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs.iter().map(|&(name, value)| (name.into(), value.into())).collect()
    }

    fn set(env: &mut Vars, name: &str, value: String) {
        env.insert(name.into(), value.into());
    }

    /// `added`, a `:`, then what `name` held, nothing when unset: AppRun's and the GTK hook's `X=added:$X`.
    fn prepend(env: &mut Vars, name: &str, added: String) {
        let mut value = OsString::from(format!("{added}:"));
        value.push(env.get(OsStr::new(name)).map_or(OsStr::new(""), OsString::as_os_str));
        env.insert(name.into(), value);
    }

    /// The folders under APPDIR, as one list.
    fn inside(folders: &[impl AsRef<str>]) -> String {
        folders.iter().map(|folder| format!("{APPDIR}/{}", folder.as_ref())).collect::<Vec<_>>().join(":")
    }

    /// What Tauri's AppImage, mounted at APPDIR, hands the app over the `person`'s environment, each part as it sets it:
    /// the runtime, then linuxdeploy's GTK hook, then AppRun, which prepends to what the hook left.
    pub(crate) fn from_an_appimage(person: &[(&str, &str)]) -> Vars {
        let mut env = vars(person);
        set(&mut env, "APPIMAGE", "/home/p/Applications/Harness_Device.AppImage".into());
        set(&mut env, "ARGV0", "./Harness_Device.AppImage".into());
        set(&mut env, "APPDIR", APPDIR.into());
        set(&mut env, "OWD", "/home/p".into());

        set(&mut env, "GTK_DATA_PREFIX", APPDIR.into());
        set(&mut env, "GTK_THEME", "Adwaita:light".into());
        prepend(&mut env, "XDG_DATA_DIRS", format!("{APPDIR}/usr/share:/usr/share"));
        set(&mut env, "GSETTINGS_SCHEMA_DIR", format!("{APPDIR}//usr/share/glib-2.0/schemas"));
        set(&mut env, "GI_TYPELIB_PATH", format!("{APPDIR}//usr/lib/girepository-1.0"));
        set(&mut env, "GIO_MODULE_DIR", format!("{APPDIR}//usr/lib/gio/modules"));
        set(&mut env, "GTK_EXE_PREFIX", format!("{APPDIR}//usr"));
        set(&mut env, "GTK_PATH", format!("{APPDIR}//usr/lib/gtk-3.0"));
        set(&mut env, "GTK_IM_MODULE_FILE", format!("{APPDIR}//usr/lib/gtk-3.0/3.0.0/immodules.cache"));
        set(&mut env, "GDK_PIXBUF_MODULE_FILE", format!("{APPDIR}//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"));

        set(&mut env, "PYTHONHOME", format!("{APPDIR}/usr/"));
        prepend(&mut env, "PATH", inside(&["usr/bin/", "usr/sbin/", "usr/games/", "bin/", "sbin/"]));
        let libraries =
            ["usr/lib/", "usr/lib/i386-linux-gnu/", "usr/lib/x86_64-linux-gnu/", "usr/lib32/", "usr/lib64/"];
        let usr_then_root = format!("{}:{}", inside(&libraries), inside(&libraries.map(|lib| &lib["usr/".len()..])));
        prepend(&mut env, "LD_LIBRARY_PATH", usr_then_root);
        prepend(&mut env, "PYTHONPATH", inside(&["usr/share/pyshared/"]));
        prepend(&mut env, "XDG_DATA_DIRS", inside(&["usr/share/"]));
        prepend(&mut env, "PERLLIB", inside(&["usr/share/perl5/", "usr/lib/perl5/"]));
        prepend(&mut env, "GSETTINGS_SCHEMA_DIR", inside(&["usr/share/glib-2.0/schemas/"]));
        let qt = |version: &str| inside(&libraries.map(|lib| format!("{lib}{version}/plugins/")));
        prepend(&mut env, "QT_PLUGIN_PATH", format!("{}:{}", qt("qt4"), qt("qt5")));
        set(&mut env, "PYTHONDONTWRITEBYTECODE", "1".into());
        prepend(&mut env, "GST_PLUGIN_SYSTEM_PATH", inside(&["usr/lib/gstreamer"]));
        prepend(&mut env, "GST_PLUGIN_SYSTEM_PATH_1_0", inside(&["usr/lib/gstreamer-1.0"]));
        env
    }

    /// Checks what `env` printed in a child started over `from_an_appimage(&[("PATH", PERSON_PATH)])`: nothing the
    /// AppImage set, the person's PATH, and the app's own variables.
    pub(crate) fn assert_outside(printed: &str) {
        let child: Vars =
            printed.lines().filter_map(|line| line.split_once('=')).map(|(n, v)| (n.into(), v.into())).collect();
        for name in from_an_appimage(&[]).keys().filter(|name| *name != "PATH" && *name != "XDG_DATA_DIRS") {
            assert!(!child.contains_key(name), "{name:?} reached the child:\n{printed}");
        }
        assert_eq!(child.get(OsStr::new("PATH")), Some(&PERSON_PATH.into()), "{printed}");
        assert_eq!(child.get(OsStr::new("XDG_DATA_DIRS")), Some(&"/usr/share:".into()), "{printed}");
        assert_eq!(child.get(OsStr::new("HOME")), env::var_os("HOME").as_ref(), "{printed}");
    }

    #[test]
    fn the_appimages_variables_go_and_the_persons_stay() {
        let mut person = vars(&LAUNCHED);
        // The GTK hook's own `/usr/share`, after its folder in the AppImage, stays: a folder every system lists.
        person.insert("XDG_DATA_DIRS".into(), "/usr/share:".into());
        assert_eq!(without_appimage(from_an_appimage(&LAUNCHED)), Some(person));
    }

    #[test]
    fn a_list_keeps_the_persons_own_entries() {
        let lists = [
            ("PATH", "/home/p/.local/bin:/usr/bin:/bin"),
            ("LD_LIBRARY_PATH", "/opt/lib"),
            ("PYTHONPATH", "/home/p/py"),
            ("QT_PLUGIN_PATH", "/opt/qt/plugins"),
            ("XDG_DATA_DIRS", "/usr/local/share/:/usr/share/"),
        ];
        let mut person = vars(&lists);
        person.insert("XDG_DATA_DIRS".into(), "/usr/share:/usr/local/share/:/usr/share/".into());
        assert_eq!(without_appimage(from_an_appimage(&lists)), Some(person));
    }

    #[test]
    fn what_the_appimage_set_over_the_persons_own_goes() {
        // The runtime and the GTK hook set these over the person's and keep no copy: there is nothing to give back.
        let own = [("GTK_THEME", "Yaru-dark"), ("GSETTINGS_SCHEMA_DIR", "/home/p/schemas"), ("OWD", "/srv")];
        let kept = without_appimage(from_an_appimage(&own)).unwrap();
        for (name, _) in own {
            assert!(!kept.contains_key(OsStr::new(name)), "{name}");
        }
    }

    #[test]
    fn only_what_lies_inside_appdir_goes() {
        let not_utf8 = OsString::from_vec(b"/opt/\xff:/usr/bin".to_vec());
        let mut env = vars(&[
            ("APPDIR", APPDIR),
            // A folder whose name only starts like APPDIR's.
            ("SIBLING", "/tmp/.mount_HarnesAbC1234/bin:/usr/bin"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            // An empty entry of the person's own.
            ("PATH", &format!("{APPDIR}/usr/bin/:/usr/bin::/bin")),
        ]);
        env.insert("BYTES".into(), not_utf8.clone());
        let mut kept = vars(&[
            ("SIBLING", "/tmp/.mount_HarnesAbC1234/bin:/usr/bin"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("PATH", "/usr/bin::/bin"),
        ]);
        kept.insert("BYTES".into(), not_utf8);
        assert_eq!(without_appimage(env), Some(kept));
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        // The person's own, which an AppImage would have set too.
        let own = [("GTK_THEME", "Yaru-dark"), ("PYTHONHOME", "/usr"), ("OWD", "/srv"), ("PATH", PERSON_PATH)];
        assert_eq!(without_appimage(vars(&own)), None);
        // An APPDIR that names no folder.
        for appdir in ["", "squashfs-root"] {
            let mut env = vars(&own);
            env.insert("APPDIR".into(), appdir.into());
            assert_eq!(without_appimage(env), None, "{appdir:?}");
        }
    }
}
