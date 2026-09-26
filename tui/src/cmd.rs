//! tmux 3.5a's command layer, ported: its commands as cmd.c's table declares them (flags,
//! argument counts, usage, the kind of target -t and -s name), cmd_find's lookup by name, alias
//! or unique prefix, arguments.c's args_parse, and cmd-find.c's cmd_find_target — a target
//! string made a window and a pane, or tmux's error for it.

use crate::app::App;
use crate::layout::Toward;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Session, Window, Pane }

/// A command's -t or -s: what it names, and cmd-find's flags for it.
#[derive(Clone, Copy, Debug)]
pub struct Spec { pub kind: Kind, pub can_fail: bool, pub window_index: bool, pub default_marked: bool }

#[derive(Debug)]
pub struct Entry {
    pub name: &'static str,
    pub alias: &'static str,
    /// getopt's: a letter, `:` when it takes a value (`::` when the value may be left out).
    pub template: &'static str,
    pub lower: i32,
    pub upper: i32,
    pub usage: &'static str,
    pub target: Option<Spec>,
    pub source: Option<Spec>,
}

/// cmd.c's cmd_table, in its order (which decides what a prefix is ambiguous between).
pub static TABLE: [Entry; 90] = [
    Entry { name: "attach-session", alias: "attach", template: "c:dEf:rt:x", lower: 0, upper: 0, usage: "[-dErx] [-c working-directory] [-f flags] [-t target-session]", target: None, source: None },
    Entry { name: "bind-key", alias: "bind", template: "nrN:T:", lower: 1, upper: -1, usage: "[-nr] [-T key-table] [-N note] key [command [arguments]]", target: None, source: None },
    Entry { name: "break-pane", alias: "breakp", template: "abdPF:n:s:t:", lower: 0, upper: 0, usage: "[-abdP] [-F format] [-n window-name] [-s src-pane] [-t dst-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: true, default_marked: false }), source: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }) },
    Entry { name: "capture-pane", alias: "capturep", template: "ab:CeE:JNpPqS:Tt:", lower: 0, upper: 0, usage: "[-aCeJNpPqT] [-b buffer-name] [-E end-line] [-S start-line] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "choose-buffer", alias: "", template: "F:f:K:NO:rt:Z", lower: 0, upper: 1, usage: "[-NrZ] [-F format] [-f filter] [-K key-format] [-O sort-order] [-t target-pane] [template]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "choose-client", alias: "", template: "F:f:K:NO:rt:Z", lower: 0, upper: 1, usage: "[-NrZ] [-F format] [-f filter] [-K key-format] [-O sort-order] [-t target-pane] [template]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "choose-tree", alias: "", template: "F:f:GK:NO:rst:wZ", lower: 0, upper: 1, usage: "[-GNrswZ] [-F format] [-f filter] [-K key-format] [-O sort-order] [-t target-pane] [template]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "clear-history", alias: "clearhist", template: "Ht:", lower: 0, upper: 0, usage: "[-H] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "clear-prompt-history", alias: "clearphist", template: "T:", lower: 0, upper: 0, usage: "[-T type]", target: None, source: None },
    Entry { name: "clock-mode", alias: "", template: "t:", lower: 0, upper: 0, usage: "[-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "command-prompt", alias: "", template: "1bFkiI:Np:t:T:", lower: 0, upper: 1, usage: "[-1bFkiN] [-I inputs] [-p prompts] [-t target-client] [-T type] [template]", target: None, source: None },
    Entry { name: "confirm-before", alias: "confirm", template: "bc:p:t:y", lower: 1, upper: 1, usage: "[-by] [-c confirm_key] [-p prompt] [-t target-client] command", target: None, source: None },
    Entry { name: "copy-mode", alias: "", template: "deHMs:t:uq", lower: 0, upper: 0, usage: "[-deHMuq] [-s src-pane] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "customize-mode", alias: "", template: "F:f:Nt:Z", lower: 0, upper: 0, usage: "[-NZ] [-F format] [-f filter] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "delete-buffer", alias: "deleteb", template: "b:", lower: 0, upper: 0, usage: "[-b buffer-name]", target: None, source: None },
    Entry { name: "detach-client", alias: "detach", template: "aE:s:t:P", lower: 0, upper: 0, usage: "[-aP] [-E shell-command] [-s target-session] [-t target-client]", target: None, source: Some(Spec { kind: Kind::Session, can_fail: true, window_index: false, default_marked: false }) },
    Entry { name: "display-menu", alias: "menu", template: "b:c:C:H:s:S:MOt:T:x:y:", lower: 1, upper: -1, usage: "[-MO] [-b border-lines] [-c target-client] [-C starting-choice] [-H selected-style] [-s style] [-S border-style] [-t target-pane][-T title] [-x position] [-y position] name key command ...", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "display-message", alias: "display", template: "ac:d:lINpt:F:v", lower: 0, upper: 1, usage: "[-aIlNpv] [-c target-client] [-d delay] [-F format] [-t target-pane] [message]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "display-popup", alias: "popup", template: "Bb:Cc:d:e:Eh:s:S:t:T:w:x:y:", lower: 0, upper: -1, usage: "[-BCE] [-b border-lines] [-c target-client] [-d start-directory] [-e environment] [-h height] [-s style] [-S border-style] [-t target-pane][-T title] [-w width] [-x position] [-y position] [shell-command]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "display-panes", alias: "displayp", template: "bd:Nt:", lower: 0, upper: 1, usage: "[-bN] [-d duration] [-t target-client] [template]", target: None, source: None },
    Entry { name: "find-window", alias: "findw", template: "CiNrt:TZ", lower: 1, upper: 1, usage: "[-CiNrTZ] [-t target-pane] match-string", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "has-session", alias: "has", template: "t:", lower: 0, upper: 0, usage: "[-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "if-shell", alias: "if", template: "bFt:", lower: 2, upper: 3, usage: "[-bF] [-t target-pane] shell-command command [command]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "join-pane", alias: "joinp", template: "bdfhvp:l:s:t:", lower: 0, upper: 0, usage: "[-bdfhv] [-l size] [-s src-pane] [-t dst-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: true }) },
    Entry { name: "kill-pane", alias: "killp", template: "at:", lower: 0, upper: 0, usage: "[-a] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "kill-server", alias: "", template: "", lower: 0, upper: 0, usage: "", target: None, source: None },
    Entry { name: "kill-session", alias: "", template: "aCt:", lower: 0, upper: 0, usage: "[-aC] [-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "kill-window", alias: "killw", template: "at:", lower: 0, upper: 0, usage: "[-a] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "last-pane", alias: "lastp", template: "det:Z", lower: 0, upper: 0, usage: "[-deZ] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "last-window", alias: "last", template: "t:", lower: 0, upper: 0, usage: "[-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "link-window", alias: "linkw", template: "abdks:t:", lower: 0, upper: 0, usage: "[-abdk] [-s src-window] [-t dst-window]", target: None, source: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }) },
    Entry { name: "list-buffers", alias: "lsb", template: "F:f:", lower: 0, upper: 0, usage: "[-F format] [-f filter]", target: None, source: None },
    Entry { name: "list-clients", alias: "lsc", template: "F:f:t:", lower: 0, upper: 0, usage: "[-F format] [-f filter] [-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "list-commands", alias: "lscm", template: "F:", lower: 0, upper: 1, usage: "[-F format] [command]", target: None, source: None },
    Entry { name: "list-keys", alias: "lsk", template: "1aNP:T:", lower: 0, upper: 1, usage: "[-1aN] [-P prefix-string] [-T key-table] [key]", target: None, source: None },
    Entry { name: "list-panes", alias: "lsp", template: "asF:f:t:", lower: 0, upper: 0, usage: "[-as] [-F format] [-f filter] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "list-sessions", alias: "ls", template: "F:f:", lower: 0, upper: 0, usage: "[-F format] [-f filter]", target: None, source: None },
    Entry { name: "list-windows", alias: "lsw", template: "F:f:at:", lower: 0, upper: 0, usage: "[-a] [-F format] [-f filter] [-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "load-buffer", alias: "loadb", template: "b:t:w", lower: 1, upper: 1, usage: "[-b buffer-name] [-t target-client] path", target: None, source: None },
    Entry { name: "lock-client", alias: "lockc", template: "t:", lower: 0, upper: 0, usage: "[-t target-client]", target: None, source: None },
    Entry { name: "lock-server", alias: "lock", template: "", lower: 0, upper: 0, usage: "", target: None, source: None },
    Entry { name: "lock-session", alias: "locks", template: "t:", lower: 0, upper: 0, usage: "[-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "move-pane", alias: "movep", template: "bdfhvp:l:s:t:", lower: 0, upper: 0, usage: "[-bdfhv] [-l size] [-s src-pane] [-t dst-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: true }) },
    Entry { name: "move-window", alias: "movew", template: "abdkrs:t:", lower: 0, upper: 0, usage: "[-abdkr] [-s src-window] [-t dst-window]", target: None, source: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }) },
    Entry { name: "new-session", alias: "new", template: "Ac:dDe:EF:f:n:Ps:t:x:Xy:", lower: 0, upper: -1, usage: "[-AdDEPX] [-c start-directory] [-e environment] [-F format] [-f flags] [-n window-name] [-s session-name] [-t target-session] [-x width] [-y height] [shell-command]", target: Some(Spec { kind: Kind::Session, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "new-window", alias: "neww", template: "abc:de:F:kn:PSt:", lower: 0, upper: -1, usage: "[-abdkPS] [-c start-directory] [-e environment] [-F format] [-n window-name] [-t target-window] [shell-command]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: true, default_marked: false }), source: None },
    Entry { name: "next-layout", alias: "nextl", template: "t:", lower: 0, upper: 0, usage: "[-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "next-window", alias: "next", template: "at:", lower: 0, upper: 0, usage: "[-a] [-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "paste-buffer", alias: "pasteb", template: "db:prs:t:", lower: 0, upper: 0, usage: "[-dpr] [-s separator] [-b buffer-name] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "pipe-pane", alias: "pipep", template: "IOot:", lower: 0, upper: 1, usage: "[-IOo] [-t target-pane] [shell-command]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "previous-layout", alias: "prevl", template: "t:", lower: 0, upper: 0, usage: "[-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "previous-window", alias: "prev", template: "at:", lower: 0, upper: 0, usage: "[-a] [-t target-session]", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "refresh-client", alias: "refresh", template: "A:B:cC:Df:r:F:l::LRSt:U", lower: 0, upper: 1, usage: "[-cDlLRSU] [-A pane:state] [-B name:what:format] [-C XxY] [-f flags] [-r pane:report][-t target-client] [adjustment]", target: None, source: None },
    Entry { name: "rename-session", alias: "rename", template: "t:", lower: 1, upper: 1, usage: "[-t target-session] new-name", target: Some(Spec { kind: Kind::Session, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "rename-window", alias: "renamew", template: "t:", lower: 1, upper: 1, usage: "[-t target-window] new-name", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "resize-pane", alias: "resizep", template: "DLMRTt:Ux:y:Z", lower: 0, upper: 1, usage: "[-DLMRTUZ] [-x width] [-y height] [-t target-pane] [adjustment]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "resize-window", alias: "resizew", template: "aADLRt:Ux:y:", lower: 0, upper: 1, usage: "[-aADLRU] [-x width] [-y height] [-t target-window] [adjustment]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "respawn-pane", alias: "respawnp", template: "c:e:kt:", lower: 0, upper: -1, usage: "[-k] [-c start-directory] [-e environment] [-t target-pane] [shell-command]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "respawn-window", alias: "respawnw", template: "c:e:kt:", lower: 0, upper: -1, usage: "[-k] [-c start-directory] [-e environment] [-t target-window] [shell-command]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "rotate-window", alias: "rotatew", template: "Dt:UZ", lower: 0, upper: 0, usage: "[-DUZ] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "run-shell", alias: "run", template: "bd:Ct:c:", lower: 0, upper: 2, usage: "[-bC] [-c start-directory] [-d delay] [-t target-pane] [shell-command]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "save-buffer", alias: "saveb", template: "ab:", lower: 1, upper: 1, usage: "[-a] [-b buffer-name] path", target: None, source: None },
    Entry { name: "select-layout", alias: "selectl", template: "Enopt:", lower: 0, upper: 1, usage: "[-Enop] [-t target-pane] [layout-name]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "select-pane", alias: "selectp", template: "DdegLlMmP:RT:t:UZ", lower: 0, upper: 0, usage: "[-DdeLlMmRUZ] [-T title] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "select-window", alias: "selectw", template: "lnpTt:", lower: 0, upper: 0, usage: "[-lnpT] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "send-keys", alias: "send", template: "c:FHKlMN:Rt:X", lower: 0, upper: -1, usage: "[-FHKlMRX] [-c target-client] [-N repeat-count] [-t target-pane] key ...", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "send-prefix", alias: "", template: "2t:", lower: 0, upper: 0, usage: "[-2] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "server-access", alias: "", template: "adlrw", lower: 0, upper: 1, usage: "[-adlrw] [-t target-pane] [user]", target: None, source: None },
    Entry { name: "set-buffer", alias: "setb", template: "ab:t:n:w", lower: 0, upper: 1, usage: "[-aw] [-b buffer-name] [-n new-buffer-name] [-t target-client] data", target: None, source: None },
    Entry { name: "set-environment", alias: "setenv", template: "Fhgrt:u", lower: 1, upper: 2, usage: "[-Fhgru] [-t target-session] name [value]", target: Some(Spec { kind: Kind::Session, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "set-hook", alias: "", template: "agpRt:uw", lower: 1, upper: 2, usage: "[-agpRuw] [-t target-pane] hook [command]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "set-option", alias: "set", template: "aFgopqst:uUw", lower: 1, upper: 2, usage: "[-aFgopqsuUw] [-t target-pane] option [value]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "set-window-option", alias: "setw", template: "aFgoqt:u", lower: 1, upper: 2, usage: "[-aFgoqu] [-t target-window] option [value]", target: Some(Spec { kind: Kind::Window, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "show-buffer", alias: "showb", template: "b:", lower: 0, upper: 0, usage: "[-b buffer-name]", target: None, source: None },
    Entry { name: "show-environment", alias: "showenv", template: "hgst:", lower: 0, upper: 1, usage: "[-hgs] [-t target-session] [name]", target: Some(Spec { kind: Kind::Session, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "show-hooks", alias: "", template: "gpt:w", lower: 0, upper: 1, usage: "[-gpw] [-t target-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "show-messages", alias: "showmsgs", template: "JTt:", lower: 0, upper: 0, usage: "[-JT] [-t target-client]", target: None, source: None },
    Entry { name: "show-options", alias: "show", template: "AgHpqst:vw", lower: 0, upper: 1, usage: "[-AgHpqsvw] [-t target-pane] [option]", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "show-prompt-history", alias: "showphist", template: "T:", lower: 0, upper: 0, usage: "[-T type]", target: None, source: None },
    Entry { name: "show-window-options", alias: "showw", template: "gvt:", lower: 0, upper: 1, usage: "[-gv] [-t target-window] [option]", target: Some(Spec { kind: Kind::Window, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "source-file", alias: "source", template: "t:Fnqv", lower: 1, upper: -1, usage: "[-Fnqv] [-t target-pane] path ...", target: Some(Spec { kind: Kind::Pane, can_fail: true, window_index: false, default_marked: false }), source: None },
    Entry { name: "split-window", alias: "splitw", template: "bc:de:fF:hIl:p:Pt:vZ", lower: 0, upper: -1, usage: "[-bdefhIPvZ] [-c start-directory] [-e environment] [-F format] [-l size] [-t target-pane][shell-command]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "start-server", alias: "start", template: "", lower: 0, upper: 0, usage: "", target: None, source: None },
    Entry { name: "suspend-client", alias: "suspendc", template: "t:", lower: 0, upper: 0, usage: "[-t target-client]", target: None, source: None },
    Entry { name: "swap-pane", alias: "swapp", template: "dDs:t:UZ", lower: 0, upper: 0, usage: "[-dDUZ] [-s src-pane] [-t dst-pane]", target: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: false }), source: Some(Spec { kind: Kind::Pane, can_fail: false, window_index: false, default_marked: true }) },
    Entry { name: "swap-window", alias: "swapw", template: "ds:t:", lower: 0, upper: 0, usage: "[-d] [-s src-window] [-t dst-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: true }) },
    Entry { name: "switch-client", alias: "switchc", template: "lc:EFnpt:rT:Z", lower: 0, upper: 0, usage: "[-ElnprZ] [-c target-client] [-t target-session] [-T key-table]", target: None, source: None },
    Entry { name: "unbind-key", alias: "unbind", template: "anqT:", lower: 0, upper: 1, usage: "[-anq] [-T key-table] key", target: None, source: None },
    Entry { name: "unlink-window", alias: "unlinkw", template: "kt:", lower: 0, upper: 0, usage: "[-k] [-t target-window]", target: Some(Spec { kind: Kind::Window, can_fail: false, window_index: false, default_marked: false }), source: None },
    Entry { name: "wait-for", alias: "wait", template: "LSU", lower: 1, upper: 1, usage: "[-L|-S|-U] channel", target: None, source: None },
];

/// cmd_find: a command by alias, exact name, or the start of exactly one name.
pub fn find(name: &str) -> Result<&'static Entry, String> {
    let mut found: Option<&'static Entry> = None;
    let mut ambiguous = false;
    for e in TABLE.iter() {
        if !e.alias.is_empty() && e.alias == name { return Ok(e) }
        if !e.name.starts_with(name) { continue }
        if found.is_some() { ambiguous = true }
        found = Some(e);
        if e.name.len() == name.len() { ambiguous = false; break }
    }
    if ambiguous {
        let all: Vec<&str> = TABLE.iter().filter(|e| e.name.starts_with(name)).map(|e| e.name).collect();
        return Err(format!("ambiguous command: {name}, could be: {}", all.join(", ")));
    }
    found.ok_or_else(|| format!("unknown command: {name}"))
}

/// A command's flags and arguments, as args_parse leaves them.
#[derive(Default, Clone, Debug)]
pub struct Args { flags: Vec<(char, Option<String>)>, pub values: Vec<String> }

impl Args {
    /// How many times the flag was given (-vv is 2).
    pub fn has(&self, c: char) -> usize { self.flags.iter().filter(|(f, _)| *f == c).count() }
    /// The flag's value, the last one given.
    pub fn get(&self, c: char) -> Option<&str> { self.flags.iter().rev().find(|(f, v)| *f == c && v.is_some()).and_then(|(_, v)| v.as_deref()) }
    /// Every value the flag was given, in order (-e A=1 -e B=2).
    pub fn all(&self, c: char) -> Vec<&str> { self.flags.iter().filter(|(f, _)| *f == c).filter_map(|(_, v)| v.as_deref()).collect() }
}

/// Flags hn adds to a tmux command, over tmux's own (as Vim's additions sit over vi's):
/// choose-tree's -m machines, -a harnesses waiting on you, -i models, -S the Harness Store.
fn added(name: &str) -> &'static str {
    match name { "choose-tree" => "aimS", _ => "" }
}

/// args_parse: flags as getopt reads them (bundled, a value attached or the next word, `--` ends
/// them, the first word not a flag ends them), then the arguments, counted against the command's
/// bounds. The error is cmd_parse's: `command NAME: …`, or its usage for `-?`.
pub fn parse(e: &Entry, words: &[String]) -> Result<Args, String> {
    let mut args = Args::default();
    let fail = |cause: String| format!("command {}: {cause}", e.name);
    let mut i = 1;
    'words: while i < words.len() {
        let w = &words[i];
        let Some(rest) = w.strip_prefix('-') else { break };
        if rest.is_empty() { break }
        i += 1;
        if rest == "-" { break }
        let chars: Vec<char> = rest.chars().collect();
        let mut k = 0;
        while k < chars.len() {
            let c = chars[k];
            k += 1;
            if c == '?' { return Err(format!("usage: {} {}", e.name, e.usage)) }
            if !c.is_ascii_alphanumeric() { return Err(fail(format!("invalid flag -{c}"))) }
            let spec = match (e.template.find(c), added(e.name).find(c)) {
                (Some(at), _) => &e.template[at + 1..],
                (None, Some(_)) => "",
                (None, None) => return Err(fail(format!("unknown flag -{c}"))),
            };
            if !spec.starts_with(':') { args.flags.push((c, None)); continue }
            let optional = spec.starts_with("::");
            if k < chars.len() { args.flags.push((c, Some(chars[k..].iter().collect()))); continue 'words }
            match words.get(i) {
                Some(v) => { args.flags.push((c, Some(v.clone()))); i += 1 }
                None if optional => args.flags.push((c, None)),
                None => return Err(fail(format!("-{c} expects an argument"))),
            }
            continue 'words;
        }
    }
    args.values = words[i.min(words.len())..].to_vec();
    if e.lower >= 0 && args.values.len() < e.lower as usize { return Err(fail(format!("too few arguments (need at least {})", e.lower))) }
    if e.upper >= 0 && args.values.len() > e.upper as usize { return Err(fail(format!("too many arguments (need at most {})", e.upper))) }
    Ok(args)
}

/// What a target found: a window (by place in the tabs), the index asked for (new-window -t 5
/// before window 5 exists), and a pane.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Found { pub window: Option<usize>, pub idx: Option<usize>, pub pane: Option<u64> }

/// The windows by index, as a session's winlinks are kept.
fn by_index(app: &App) -> Vec<usize> {
    let mut w: Vec<usize> = (0..app.tabs.len()).collect();
    w.sort_by_key(|i| app.win_num(*i));
    w
}

/// fnmatch(3) as tmux uses it on names: `*`, `?`, `[…]`.
pub fn fnmatch(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|k| go(&p[1..], &t[k..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some('[') => {
                let Some(end) = p.iter().skip(1).position(|c| *c == ']').map(|e| e + 1) else { return !t.is_empty() && t[0] == '[' && go(&p[1..], &t[1..]) };
                let Some(&c) = t.first() else { return false };
                let set = &p[1..end];
                let (negate, set) = match set.first() { Some('!') | Some('^') => (true, &set[1..]), _ => (false, set) };
                let mut hit = false;
                let mut k = 0;
                while k < set.len() {
                    if k + 2 < set.len() && set[k + 1] == '-' { if set[k] <= c && c <= set[k + 2] { hit = true } k += 3 } else { if set[k] == c { hit = true } k += 1 }
                }
                hit != negate && go(&p[end + 1..], &t[1..])
            }
            Some('\\') if p.len() > 1 => !t.is_empty() && t[0] == p[1] && go(&p[2..], &t[1..]),
            Some(c) => !t.is_empty() && t[0] == *c && go(&p[1..], &t[1..]),
        }
    }
    go(&pattern.chars().collect::<Vec<_>>(), &text.chars().collect::<Vec<_>>())
}

/// cmd_find_get_session: this session by `$0`, its name, the start of it, or a pattern.
fn session_matches(app: &App, s: &str, exact: bool) -> bool {
    if let Some(id) = s.strip_prefix('$') { return id == "0" }
    let name = app.session_name();
    if s == name { return true }
    if exact { return false }
    name.starts_with(s) || fnmatch(s, &name)
}

/// cmd_find_get_window_with_session: a window of this session by id, offset, `! ^ $`, index,
/// exact name, the start of one name, or a pattern (more than one match fails).
fn window_in_session(app: &App, window: &str, exact: bool, index_ok: bool, f: &mut Found) -> bool {
    let order = by_index(app);
    if let Some(id) = window.strip_prefix('@') {
        let Some(w) = id.parse::<u64>().ok().and_then(|n| app.tabs.iter().position(|t| t.wid == n)) else { return false };
        f.window = Some(w); f.idx = Some(app.win_num(w));
        return true;
    }
    if !exact && (window.starts_with('+') || window.starts_with('-')) {
        let n: usize = if window.len() > 1 { match window[1..].parse() { Ok(n) if n >= 1 => n, _ => 0 } } else { 1 };
        let cur = app.win_num(app.active);
        if index_ok {
            let idx = if window.starts_with('+') { cur.checked_add(n) } else { cur.checked_sub(n) };
            let Some(idx) = idx else { return false };
            f.idx = Some(idx); f.window = app.tab_by_num(idx);
            return true;
        }
        if n > 0 && !order.is_empty() {
            let at = order.iter().position(|w| *w == app.active).unwrap_or(0) as i64;
            let step = if window.starts_with('+') { n as i64 } else { -(n as i64) };
            let w = order[(at + step).rem_euclid(order.len() as i64) as usize];
            f.window = Some(w); f.idx = Some(app.win_num(w));
            return true;
        }
    }
    if !exact {
        let pick = match window {
            "!" => app.last_tab().and_then(|id| app.tabs.iter().position(|t| &t.id == id)).map(Some),
            "^" => Some(order.first().copied()),
            "$" => Some(order.last().copied()),
            _ => None,
        };
        if let Some(pick) = pick {
            let Some(w) = pick else { return false };
            f.window = Some(w); f.idx = Some(app.win_num(w));
            return true;
        }
    }
    if !window.starts_with('+') && !window.starts_with('-') {
        if let Ok(idx) = window.parse::<usize>() {
            if let Some(w) = app.tab_by_num(idx) { f.window = Some(w); f.idx = Some(idx); return true }
            if index_ok { f.idx = Some(idx); return true }
        }
    }
    let unique = |test: &dyn Fn(&str) -> bool| -> Result<Option<usize>, ()> {
        let hits: Vec<usize> = order.iter().copied().filter(|w| test(&app.tabs[*w].name)).collect();
        match hits.len() { 0 => Ok(None), 1 => Ok(Some(hits[0])), _ => Err(()) }
    };
    let mut steps: Vec<Box<dyn Fn(&str) -> bool>> = vec![Box::new(|n: &str| n == window)];
    if !exact { steps.push(Box::new(|n: &str| n.starts_with(window))); steps.push(Box::new(|n: &str| fnmatch(window, n))); }
    for test in steps {
        match unique(&*test) {
            Ok(Some(w)) => { f.window = Some(w); f.idx = Some(app.win_num(w)); return true }
            Ok(None) => continue,
            Err(()) => return false,
        }
    }
    false
}

/// cmd_find_get_window: an `@id`, a window of this session, else a session (its current window).
fn window_anywhere(app: &App, window: &str, only: bool, exact: bool, index_ok: bool, f: &mut Found) -> bool {
    if window_in_session(app, window, exact, index_ok, f) { return true }
    if !only && session_matches(app, window, false) { f.window = Some(app.active); f.idx = Some(app.win_num(app.active)); return true }
    false
}

/// cmd_find_get_pane_with_window: a pane of the window by `%id`, `!`, `{up-of}`…, an offset
/// from its active pane, its index, or where it is (`top`, `bottom-left`…).
fn pane_in_window(app: &App, w: usize, pane: &str, f: &mut Found) -> bool {
    let Some(tab) = app.tabs.get(w) else { return false };
    let ids = tab.panes();
    if let Some(id) = pane.strip_prefix('%') {
        let Some(p) = crate::pane::from_tag(id).filter(|p| ids.contains(p)) else { return false };
        f.pane = Some(p);
        return true;
    }
    let active = tab.focus;
    let toward = match pane { "{up-of}" => Some(Toward::Up), "{down-of}" => Some(Toward::Down), "{left-of}" => Some(Toward::Left), "{right-of}" => Some(Toward::Right), _ => None };
    if pane == "!" { f.pane = tab.last_focus(); return f.pane.is_some() }
    if let Some(t) = toward { f.pane = active.and_then(|a| app.pane_toward(w, a, t)); return f.pane.is_some() }
    if (pane.starts_with('+') || pane.starts_with('-')) && !ids.is_empty() {
        let n: i64 = if pane.len() > 1 { pane[1..].parse().ok().filter(|n| *n >= 1).unwrap_or(0) } else { 1 };
        if let Some(at) = active.and_then(|a| ids.iter().position(|p| *p == a)) {
            let step = if pane.starts_with('+') { n } else { -n };
            f.pane = Some(ids[(at as i64 + step).rem_euclid(ids.len() as i64) as usize]);
            return true;
        }
    }
    if let Ok(idx) = pane.parse::<usize>() {
        if let Some(p) = idx.checked_sub(app.pane_base_index).and_then(|i| ids.get(i)) { f.pane = Some(*p); return true }
    }
    // window_find_string: the pane at that spot of the window.
    let body = app.body();
    let (sx, sy) = (body.width as u32, body.height as u32);
    let status = app.pane_status(tab);
    let (top, bottom) = match status { crate::layout::Status::Top => (1, sy.saturating_sub(1)), crate::layout::Status::Bottom => (0, sy.saturating_sub(2)), crate::layout::Status::Off => (0, sy.saturating_sub(1)) };
    let (x, y) = match pane.to_ascii_lowercase().as_str() {
        "top" => (sx / 2, top), "bottom" => (sx / 2, bottom), "left" => (0, sy / 2), "right" => (sx.saturating_sub(1), sy / 2),
        "top-left" => (0, top), "top-right" => (sx.saturating_sub(1), top), "bottom-left" => (0, bottom), "bottom-right" => (sx.saturating_sub(1), bottom),
        _ => return false,
    };
    let geoms = if tab.zoomed { tab.focus.map(|p| app.pane_geoms(w).into_iter().filter(|(id, _)| *id == p).collect()).unwrap_or_default() } else { app.pane_geoms(w) };
    f.pane = geoms.into_iter().find(|(_, g)| x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h).map(|(id, _)| id);
    f.pane.is_some()
}

/// cmd_find_target: a target string of a kind, as tmux resolves it, or tmux's error.
pub fn resolve(app: &App, target: Option<&str>, spec: Spec) -> Result<Found, String> {
    let marked = app.marked.and_then(|m| app.tabs.iter().position(|t| t.panes().contains(&m)).map(|w| (w, m)));
    // The current state: the marked pane for the commands that default to it; the pane under
    // the mouse while a mouse key's commands run (cmd_find_from_mouse); else the active pane.
    let current = match (spec.default_marked, marked, app.current()) {
        (true, Some((w, p)), _) => Found { window: Some(w), idx: Some(app.win_num(w)), pane: Some(p) },
        (_, _, Some((w, p))) => Found { window: Some(w), idx: Some(app.win_num(w)), pane: Some(p) },
        _ => Found { window: Some(app.active), idx: Some(app.win_num(app.active)), pane: app.tabs.get(app.active).and_then(|t| t.focus) },
    };
    let target = target.unwrap_or("");
    if target.is_empty() { return Ok(if spec.window_index { Found { idx: None, ..current } } else { current }) }
    if target == "~" || target == "{marked}" {
        return marked.map(|(w, p)| Found { window: Some(w), idx: Some(app.win_num(w)), pane: Some(p) }).ok_or_else(|| "no marked target".to_string());
    }
    // `=` or {mouse}: the pane under the mouse — for a window, the window it was for (a status
    // range's) at its active pane.
    if target == "=" || target == "{mouse}" {
        let m = app.mouse_ev.as_ref().filter(|m| m.valid);
        let pane = if spec.kind == Kind::Pane { m.and_then(|m| crate::mouse::mouse_pane(app, m)) } else { None };
        let found = pane.or_else(|| {
            let w = m.and_then(|m| crate::mouse::mouse_window(app, m))?;
            app.tabs[w].focus.map(|p| (w, p))
        });
        return found.map(|(w, p)| Found { window: Some(w), idx: Some(app.win_num(w)), pane: Some(p) }).ok_or_else(|| "no mouse target".to_string());
    }
    // session:window.pane, as far as each part is there.
    let (mut session, mut window, mut pane) = (None, None, None);
    let (mut window_only, mut pane_only) = (false, false);
    let (head, colon) = match target.split_once(':') { Some((a, b)) => (a, Some(b)), None => (target, None) };
    let split_period = |s: &str| -> (String, Option<String>) { match s.split_once('.') { Some((a, b)) => (a.to_string(), Some(b.to_string())), None => (s.to_string(), None) } };
    match colon {
        Some(rest) => {
            session = Some(head.to_string());
            let (w, p) = split_period(rest);
            window = Some(w); window_only = true;
            if let Some(p) = p { pane = Some(p); pane_only = true }
        }
        None => {
            let (w, p) = split_period(head);
            match p {
                Some(p) => { window = Some(w); pane = Some(p); pane_only = true }
                None => {
                    if w.starts_with('$') { session = Some(w) }
                    else if w.starts_with('@') { window = Some(w) }
                    else if w.starts_with('%') { pane = Some(w) }
                    else { match spec.kind { Kind::Session => session = Some(w), Kind::Window => window = Some(w), Kind::Pane => pane = Some(w) } }
                }
            }
        }
    }
    let exact_session = session.as_deref().map(|s| s.starts_with('=')).unwrap_or(false);
    let exact_window = window.as_deref().map(|s| s.starts_with('=')).unwrap_or(false);
    let session = session.map(|s| s.trim_start_matches('=').to_string()).filter(|s| !s.is_empty());
    let window = window.map(|s| s.trim_start_matches('=').to_string()).filter(|s| !s.is_empty()).map(|w| match w.as_str() {
        "{start}" => "^".into(), "{last}" => "!".into(), "{end}" => "$".into(), "{next}" => "+".into(), "{previous}" => "-".into(), _ => w,
    });
    let pane = pane.filter(|s| !s.is_empty()).map(|p| match p.as_str() {
        "{last}" => "!".into(), "{next}" => "+".into(), "{previous}" => "-".into(),
        "{top}" => "top".into(), "{bottom}" => "bottom".into(), "{left}" => "left".into(), "{right}" => "right".into(),
        "{top-left}" => "top-left".into(), "{top-right}" => "top-right".into(), "{bottom-left}" => "bottom-left".into(), "{bottom-right}" => "bottom-right".into(),
        _ => p,
    });
    if pane.is_some() && spec.window_index { return Err("can't specify pane here".into()) }
    let no_session = |s: &str| format!("can't find session: {s}");
    let no_window = |s: &str| format!("can't find window: {s}");
    let no_pane = |s: &str| format!("can't find pane: {s}");
    let mut f = Found::default();
    let active_of = |app: &App, w: Option<usize>| w.and_then(|w| app.tabs.get(w)).and_then(|t| t.focus);
    if let Some(s) = &session {
        if !session_matches(app, s, exact_session) { return Err(no_session(s)) }
        match (&window, &pane) {
            (None, None) => return Ok(Found { window: Some(app.active), idx: None, pane: active_of(app, Some(app.active)) }),
            (Some(w), None) => {
                if !window_in_session(app, w, exact_window, spec.window_index, &mut f) { return Err(no_window(w)) }
                f.pane = active_of(app, f.window);
                return Ok(f);
            }
            (None, Some(p)) => {
                if p.starts_with('%') { return pane_anywhere(app, p, false).ok_or_else(|| no_pane(p)) }
                f.window = Some(app.active); f.idx = Some(app.win_num(app.active));
                if !pane_in_window(app, app.active, p, &mut f) { return Err(no_pane(p)) }
                return Ok(f);
            }
            (Some(w), Some(p)) => {
                if !window_in_session(app, w, exact_window, spec.window_index, &mut f) { return Err(no_window(w)) }
                let Some(win) = f.window else { return Err(no_window(w)) };
                if !pane_in_window(app, win, p, &mut f) { return Err(no_pane(p)) }
                return Ok(f);
            }
        }
    }
    match (&window, &pane) {
        (Some(w), Some(p)) => {
            if !window_anywhere(app, w, window_only, exact_window, spec.window_index, &mut f) { return Err(no_window(w)) }
            let Some(win) = f.window else { return Err(no_window(w)) };
            if !pane_in_window(app, win, p, &mut f) { return Err(no_pane(p)) }
            Ok(f)
        }
        (Some(w), None) => {
            if !window_anywhere(app, w, window_only, exact_window, spec.window_index, &mut f) { return Err(no_window(w)) }
            f.pane = active_of(app, f.window);
            Ok(f)
        }
        (None, Some(p)) => pane_anywhere(app, p, pane_only).ok_or_else(|| no_pane(p)),
        (None, None) => Ok(if spec.window_index { Found { idx: None, ..current } } else { current }),
    }
}

/// cmd_find_get_pane: a `%id` in any window, a pane of the current window, else (not `.only`)
/// a window by that name, its active pane.
fn pane_anywhere(app: &App, pane: &str, only: bool) -> Option<Found> {
    if let Some(id) = pane.strip_prefix('%') {
        let p = crate::pane::from_tag(id)?;
        let w = app.tabs.iter().position(|t| t.panes().contains(&p))?;
        return Some(Found { window: Some(w), idx: Some(app.win_num(w)), pane: Some(p) });
    }
    let mut f = Found { window: Some(app.active), idx: Some(app.win_num(app.active)), pane: None };
    if pane_in_window(app, app.active, pane, &mut f) { return Some(f) }
    if only { return None }
    let mut g = Found::default();
    if window_anywhere(app, pane, false, false, false, &mut g) {
        g.pane = g.window.and_then(|w| app.tabs.get(w)).and_then(|t| t.focus);
        return Some(g);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn finds_commands_as_tmux_does() {
        assert_eq!(find("splitw").unwrap().name, "split-window");
        assert_eq!(find("new-w").unwrap().name, "new-window");
        assert_eq!(find("send").unwrap().name, "send-keys");
        assert_eq!(find("show-options").unwrap().name, "show-options");
        assert!(find("sel").unwrap_err().starts_with("ambiguous command: sel, could be: select-layout, select-pane, select-window"));
        assert_eq!(find("nosuch").unwrap_err(), "unknown command: nosuch");
    }

    #[test]
    fn parses_flags_as_args_parse_does() {
        let e = find("send-keys").unwrap();
        let a = parse(e, &w(&["send-keys", "-t", "%4", "-X", "cancel"])).unwrap();
        assert_eq!((a.get('t'), a.has('X'), a.values.clone()), (Some("%4"), 1, w(&["cancel"])));
        let a = parse(e, &w(&["send-keys", "ls", "-lah", "Enter"])).unwrap();
        assert_eq!((a.has('l'), a.values.clone()), (0, w(&["ls", "-lah", "Enter"])));
        let a = parse(e, &w(&["send-keys", "-N3", "x"])).unwrap();
        assert_eq!(a.get('N'), Some("3"));
        let a = parse(find("split-window").unwrap(), &w(&["splitw", "-hdl", "10", "--", "-x"])).unwrap();
        assert_eq!((a.has('h'), a.has('d'), a.get('l'), a.values.clone()), (1, 1, Some("10"), w(&["-x"])));
        assert_eq!(parse(e, &w(&["send-keys", "-j"])).unwrap_err(), "command send-keys: unknown flag -j");
        assert_eq!(parse(e, &w(&["send-keys", "-t"])).unwrap_err(), "command send-keys: -t expects an argument");
        assert_eq!(parse(find("if-shell").unwrap(), &w(&["if-shell"])).unwrap_err(), "command if-shell: too few arguments (need at least 2)");
        assert_eq!(parse(find("kill-pane").unwrap(), &w(&["kill-pane", "x"])).unwrap_err(), "command kill-pane: too many arguments (need at most 0)");
        assert!(parse(find("kill-pane").unwrap(), &w(&["kill-pane", "-?"])).unwrap_err().starts_with("usage: kill-pane [-a] [-t target-pane]"));
        // A repeated flag: the last value wins, every value is kept.
        let a = parse(find("split-window").unwrap(), &w(&["split-window", "-e", "A=1", "-e", "B=2"])).unwrap();
        assert_eq!((a.get('e'), a.all('e')), (Some("B=2"), vec!["A=1", "B=2"]));
    }

    /// Every command hn binds by default reads as tmux reads it (hn's added flags aside).
    #[test]
    fn default_bindings_parse() {
        let km = crate::keys::Keymap::tmux_defaults();
        let mut lines: Vec<String> = km.tables().into_iter().flat_map(|(_, l)| l.into_iter().map(|b| b.command)).collect();
        lines.push(crate::keys::WINDOW_MENU.into());
        lines.push(crate::keys::PANE_MENU.into());
        for line in lines {
            for words in crate::tmuxconf::split_marked(&line) {
                for cmd in words.split(|w| w == ";").filter(|p| !p.is_empty()) {
                    let Ok(e) = find(&cmd[0]) else { continue };
                    let list = if e.name == "bind-key" { cmd.to_vec() } else { crate::tmuxconf::unblock(cmd) };
                    if let Err(err) = parse(e, &list) { panic!("{line}: {err}") }
                }
            }
        }
    }

    #[test]
    fn fnmatch_as_tmux_uses_it() {
        assert!(fnmatch("bet*", "beta"));
        assert!(fnmatch("b?ta", "beta"));
        assert!(fnmatch("[ab]eta", "beta"));
        assert!(!fnmatch("[!b]eta", "beta"));
        assert!(!fnmatch("bet", "beta"));
    }
}
