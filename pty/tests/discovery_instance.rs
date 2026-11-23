mod common;

use common::host_command;
use harness_pty::protocol::PROTOCOL;

#[test]
fn discovery_uses_the_host_process_instance_tag() {
    use harness_pty::instance::{INSTANCE_TAG_VAR, instance_name, run_file};

    let base = instance_name(PROTOCOL, harness_pty::cli::VERSION);
    let tag = "gu0123456789ab";
    let tagged = format!("{base}-{tag}");
    let too_long = "x".repeat(17);
    for (value, expected) in [
        (None, base.as_str()),
        (Some(tag), tagged.as_str()),
        (Some("bad tag"), base.as_str()),
        (Some("gu_0123456789ab"), base.as_str()),
        (Some(""), base.as_str()),
        (Some(too_long.as_str()), base.as_str()),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut command = host_command(home.path());
        // Keep the child under the fixture's ownership on Windows too.
        #[cfg(windows)]
        command.arg("--no-reexec");
        // Setting the tag only in the child keeps parallel discovery tests independent.
        match value {
            Some(value) => command.env(INSTANCE_TAG_VAR, value),
            None => command.env_remove(INSTANCE_TAG_VAR),
        };
        let child = command.spawn().unwrap();
        let host = common::Host {
            pid: child.id(),
            child,
            home,
        };
        let file = run_file(&host.home.path().join("run"), expected, "json");
        let discovery = common::wait_discovery_file(&file);
        assert_eq!(discovery["instance"], expected, "tag {value:?}");
        assert_eq!(discovery["pid"], host.child.id());
    }
}
