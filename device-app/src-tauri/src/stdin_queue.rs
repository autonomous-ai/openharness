//! Lines for a Windows child's stdin, queued for its writer thread and bounded, so a stuck child never blocks the app.

use crate::cli::Unwritten;
use std::io::Write;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread;

/// Lines waiting for the writer, as many as a run's lines wait to be read (cli.rs LINES_QUEUED).
pub(crate) const STDIN_QUEUED: usize = 16;

/// A pipe written by a thread of its own, a line at a time, so `line` never waits: a line past STDIN_QUEUED waiting is
/// `Unwritten::Full`, as a full non-blocking pipe is on unix. Dropped, it closes the pipe once the lines queued are
/// written.
pub(crate) struct Queue(SyncSender<String>);

impl Queue {
    pub(crate) fn new(mut pipe: impl Write + Send + 'static) -> Queue {
        let (send, lines) = mpsc::sync_channel::<String>(STDIN_QUEUED);
        thread::spawn(move || {
            // The queue closes as the loop ends, before the pipe does: once the pipe has closed, `line` says Closed.
            for line in lines {
                if pipe.write_all(line.as_bytes()).is_err() {
                    break;
                }
            }
        });
        Queue(send)
    }

    /// The text and a newline.
    pub(crate) fn line(&self, text: &str) -> Result<(), Unwritten> {
        self.0.try_send(format!("{text}\n")).map_err(|error| match error {
            TrySendError::Full(_) => Unwritten::Full,
            TrySendError::Disconnected(_) => Unwritten::Closed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::thread;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);

    /// A pipe a test drives: it sends each write's bytes as the write starts, then waits for a `go`, and fails once
    /// none is left to come. `writes` ends when it is dropped.
    struct Pipe {
        writes: mpsc::Sender<Vec<u8>>,
        go: mpsc::Receiver<()>,
    }

    impl Write for Pipe {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let _ = self.writes.send(bytes.to_vec());
            self.go.recv().map_err(|_| io::ErrorKind::BrokenPipe)?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A queue on a Pipe, what the Pipe is written, and its `go`.
    fn queue() -> (Queue, mpsc::Receiver<Vec<u8>>, mpsc::Sender<()>) {
        let (writes, written) = mpsc::channel();
        let (go, wait) = mpsc::channel();
        (Queue::new(Pipe { writes, go: wait }), written, go)
    }

    /// Every write from now until the pipe is dropped, WAIT at most for each.
    fn until_dropped(written: &mpsc::Receiver<Vec<u8>>) -> Vec<Vec<u8>> {
        let mut all = Vec::new();
        loop {
            match written.recv_timeout(WAIT) {
                Ok(bytes) => all.push(bytes),
                Err(RecvTimeoutError::Disconnected) => return all,
                Err(RecvTimeoutError::Timeout) => panic!("the pipe is still open; written {all:?}"),
            }
        }
    }

    #[test]
    fn a_full_queue_answers_full_and_never_waits() {
        let (queue, written, go) = queue();
        assert_eq!(queue.line("first"), Ok(()));
        // The writer has it, and waits in the pipe.
        assert_eq!(written.recv_timeout(WAIT), Ok(b"first\n".to_vec()));
        // On a thread, so a call that waits fails the test instead of hanging it.
        let (send, answers) = mpsc::channel();
        thread::spawn(move || {
            let _ = send.send((0..=STDIN_QUEUED).map(|n| queue.line(&n.to_string())).collect::<Vec<_>>());
        });
        let queued = (0..STDIN_QUEUED).map(|_| Ok(())).chain([Err(Unwritten::Full)]).collect::<Vec<_>>();
        assert_eq!(answers.recv_timeout(WAIT), Ok(queued));
        drop(go);
    }

    #[test]
    fn lines_arrive_in_order_each_with_a_newline() {
        let (queue, written, go) = queue();
        for line in ["a", "b", "c"] {
            assert_eq!(queue.line(line), Ok(()));
            go.send(()).unwrap();
        }
        let lines = (0..3).map(|_| written.recv_timeout(WAIT).unwrap()).collect::<Vec<_>>();
        assert_eq!(lines, [b"a\n", b"b\n", b"c\n"].map(|line| line.to_vec()));
    }

    #[test]
    fn a_failed_write_closes_it() {
        let (queue, written, go) = queue();
        // No `go` to come: the first write fails.
        drop(go);
        assert_eq!(queue.line("a"), Ok(()));
        assert_eq!(until_dropped(&written), [b"a\n".to_vec()]);
        assert_eq!(queue.line("b"), Err(Unwritten::Closed));
        assert_eq!(queue.line("c"), Err(Unwritten::Closed));
    }

    #[test]
    fn dropping_it_closes_the_pipe() {
        let (queue, written, go) = queue();
        assert_eq!(queue.line("a"), Ok(()));
        assert_eq!(written.recv_timeout(WAIT), Ok(b"a\n".to_vec()));
        assert_eq!(queue.line("b"), Ok(()));
        // Dropped while a write is under way and a line waits: the pipe closes once both are written, as a closed pipe
        // on unix still hands on what was in it.
        drop(queue);
        go.send(()).unwrap();
        go.send(()).unwrap();
        assert_eq!(until_dropped(&written), [b"b\n".to_vec()]);
    }
}
