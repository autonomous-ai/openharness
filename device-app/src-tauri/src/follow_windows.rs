//! The ChatGPT follow on Windows: a win-event hook, for ChatGPT's process only, hears the foreground and name
//! changes, and the window's title is its native text (`GetWindowTextW`). The app is installed when its package
//! family is registered for the person (`GetPackagesByPackageFamily`).
