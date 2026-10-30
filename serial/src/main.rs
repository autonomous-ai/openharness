//! harness-serial: the Harness dial's serial port on Windows, for the CLI's cable/serial.ts
//! (docs/superpowers/specs/2026-10-19-windows-dial-design.md §1). `watch` lists the dials, `open` moves one dial's
//! bytes between the port and stdin/stdout, `probe` says whether another program holds a port.

mod model;
#[cfg(windows)]
mod windows;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match model::parse(&args) {
        Ok(command) => command,
        Err(usage) => {
            eprintln!("{usage}");
            std::process::exit(model::EXIT_FAILED);
        }
    };
    if command == model::Command::Version {
        println!("{}", model::version_line());
        return;
    }
    #[cfg(windows)]
    std::process::exit(windows::run(command));
    #[cfg(not(windows))]
    {
        eprintln!("error: harness-serial runs on Windows only");
        std::process::exit(model::EXIT_FAILED);
    }
}
