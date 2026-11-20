//! The ChatGPT follow on Windows: a win-event hook, for ChatGPT's process only, hears the foreground and name
//! changes, and the window's title is its native text (`GetWindowTextW`). The app is installed when its package
//! family is registered for the person (`GetPackagesByPackageFamily`).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::follow::{AxTrust, FollowSwitch};
    use std::sync::{Arc, Mutex};

    /// The ChatGPT app's Store package folder, as the VM has it (docs/plans/2026-11-19-dial-windows-vm-notes.md).
    const PACKAGE: &str = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1117.3838.0_arm64__2p2nqsd0c76g0";

    #[test]
    fn the_chatgpt_image_is_the_store_packages_program_in_any_case() {
        let program = format!(r"{PACKAGE}\app\ChatGPT.exe");
        for image in [program.clone(), program.to_lowercase(), program.to_uppercase()] {
            assert!(is_chatgpt_image(&image), "{image}");
        }
        for image in [
            // The beta is another package.
            r"C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.1117.3838.0_arm64__2p2nqsd0c76g0\app\ChatGPT.exe",
            // Another program of the package: Codex's own.
            &format!(r"{PACKAGE}\app\Codex.exe"),
            &format!(r"{PACKAGE}\app\resources\codex.exe"),
            &format!(r"{PACKAGE}\app\NotChatGPT.exe"),
            &format!(r"{PACKAGE}\app\ChatGPT.exe.old"),
            // A ChatGPT.exe outside the Store's folder.
            r"C:\Users\someone\Downloads\OpenAI.Codex_1\ChatGPT.exe",
            r"C:\Program Files\ChatGPT\ChatGPT.exe",
            "ChatGPT.exe",
            "",
        ] {
            assert!(!is_chatgpt_image(image), "{image}");
        }
    }

    #[test]
    fn a_family_is_found_only_when_windows_asks_room_for_its_packages() {
        // ERROR_INSUFFICIENT_BUFFER, with the packages counted.
        assert!(family_found(122, 1));
        assert!(family_found(122, 2));
        // Success with none counted: no package of that family.
        assert!(!family_found(0, 0));
        assert!(!family_found(122, 0));
        // ERROR_INVALID_PARAMETER, APPMODEL_ERROR_NO_PACKAGE.
        assert!(!family_found(87, 1));
        assert!(!family_found(15700, 1));
    }

    #[test]
    fn the_title_is_read_at_a_foreground_change_and_the_front_windows_own_name_change() {
        const FOREGROUND: u32 = 0x0003;
        const NAME_CHANGE: u32 = 0x800C;
        let (front, other) = (0x70, 0x90);
        // A ChatGPT window came to the front: the hook hears only ChatGPT's process.
        assert!(reads_title(FOREGROUND, front, 0, 0, front));
        assert!(reads_title(FOREGROUND, other, 0, 0, front));
        // The window in front's own name.
        assert!(reads_title(NAME_CHANGE, front, 0, 0, front));
        // A ChatGPT window behind.
        assert!(!reads_title(NAME_CHANGE, other, 0, 0, front));
        // Another object of the window in front: its caret, its menu, its client area.
        for object in [-8, -3, -4] {
            assert!(!reads_title(NAME_CHANGE, front, object, 0, front), "{object}");
        }
        // One of its children.
        assert!(!reads_title(NAME_CHANGE, front, 0, 3, front));
        // Another event: EVENT_OBJECT_CREATE.
        assert!(!reads_title(0x8000, front, 0, 0, front));
    }

    #[test]
    fn the_door_answers_the_permission_with_the_persons_switch() {
        assert!(!WindowsFollow::new(FollowSwitch::new(false)).trusted());
        let switch = FollowSwitch::new(true);
        let door = WindowsFollow::new(switch.clone());
        assert!(door.trusted());
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        door.start(Box::new(move || *count.lock().unwrap() += 1));
        // The menu's click.
        door.switch(false);
        assert!(!switch.on());
        assert!(!door.trusted());
        assert_eq!(*told.lock().unwrap(), 1);
        // Nothing to ask on Windows.
        door.prompt();
        assert!(!switch.on());
        assert_eq!(*told.lock().unwrap(), 1);
        door.switch(true);
        assert!(door.trusted());
        assert_eq!(*told.lock().unwrap(), 2);
    }
}
