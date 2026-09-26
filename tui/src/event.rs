//! Everything the app loop reacts to arrives as one of these, on one channel.

use serde_json::Value;

use crate::app::App;
use crate::daemon::RpcError;
use crate::proto;

pub enum MachineEvent {
    Connected,
    /// Never got as far as selected.
    Failed(RpcError),
    /// Was selected, then went away.
    Closed(RpcError),
    Frame { ty: String, payload: Value },
    Terminal(proto::Frame),
}

pub enum Event {
    Input(crossterm::event::Event),
    Machine { machine_id: String, generation: u64, event: MachineEvent },
    /// The result of background work, applied on the app loop.
    Apply(Box<dyn FnOnce(&mut App) + Send>),
    Tick,
}
