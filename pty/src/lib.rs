pub mod breakaway;
pub mod cli;
pub mod command;
pub mod desktop;
pub mod discovery;
mod files;
pub mod host_lock;
pub mod instance;
#[cfg(windows)]
pub mod job;
pub mod launcher;
pub mod logfile;
pub mod pane;
pub mod pane_ids;
pub mod panes;
pub mod protocol;
pub mod ps;
pub mod server;
pub mod stream;
pub mod transport;
#[cfg(unix)]
mod unix_proc;
