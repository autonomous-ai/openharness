import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// How a phone status line is coloured. The widgets turn this into a palette colour, so the
/// rules below stay testable without a theme.
enum PhoneTone { good, busy, attention, bad, quiet }

/// A status line: what it says, and how it is coloured.
typedef PhoneSummary = ({String label, PhoneTone tone});

/// What a machine's row says, and so where a tap on it goes.
enum PhoneMachineStatus {
  /// Reachable, but this device holds no link to it yet. A tap asks for THAT machine's remote
  /// password — every machine sets its own.
  needsPassword,

  /// Harness is not running there, so none of its agents can be reached until it is.
  offline,

  /// The socket is still coming up, or its agent list has not answered yet.
  connecting,

  /// Linked and answering: a tap lists its agents.
  ready,
}

PhoneMachineStatus phoneMachineStatusOf(MachineState machine) {
  // ⚠️ Offline FIRST. A machine that is switched off is almost always also unlinked from here — the
  // relay refuses the dial before the other computer is ever reached — so asking about the link
  // first called a powered-down machine "Needs its password" and offered a form that could only
  // fail. The password is worth asking for once there is something to give it to, which is what the
  // desktop's "Offline · Link required" already says.
  if (machine.nodeOnline == false) return PhoneMachineStatus.offline;
  if (machine.needsLink) return PhoneMachineStatus.needsPassword;
  final answering =
      machine.connectionStatus == ConnectionStatus.connected &&
      machine.agentLoadStatus != AgentLoadStatus.loading;
  return answering ? PhoneMachineStatus.ready : PhoneMachineStatus.connecting;
}

/// Whether [machine]'s agents belong on the agent screens: it is answering, or it answered and its
/// socket is only dialling again.
///
/// ⚠️ **The second half is what keeps a terminal on screen through a dropped socket.** Backgrounding
/// the app drops it every time, and a machine counted only while [PhoneMachineStatus.ready] took its
/// agents out of the list for the length of the redial — the pager, whose pages ARE that list, was
/// thrown away and the screen fell back to "Connecting to your machine…" on every return to the app.
/// A first connect has no list yet, so it still waits like one.
/// ⚠️ **Agents restored from the last run count too, and that is the whole
/// point of restoring them.** A warm-started machine is `connecting` (its socket
/// is genuinely still coming up) and `loading` (it genuinely still owes a list),
/// so the `loaded` test below hid exactly the agents the cache exists to show —
/// the phone read nine of them off disk at 520ms and still sat on "Connecting to
/// your machine…" until the handshake finished two seconds later.
///
/// Showing them is safe for the same reason showing a RECONNECTING machine's
/// agents is safe, which is what the paragraph above describes: the names are
/// last known good, the real list replaces them the moment it lands, and
/// `_replaceAgents` retires anything that has gone. The difference is only how
/// long ago "last known" was.
bool phoneMachineListsAgents(MachineState machine) =>
    switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.ready => true,
      PhoneMachineStatus.connecting =>
        machine.agentLoadStatus == AgentLoadStatus.loaded ||
            machine.agentsFromCache,
      PhoneMachineStatus.needsPassword || PhoneMachineStatus.offline => false,
    };

PhoneSummary phoneMachineSummary(MachineState machine) =>
    switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.needsPassword => (
        label: 'Needs its password',
        tone: PhoneTone.attention,
      ),
      PhoneMachineStatus.offline => (label: 'Offline', tone: PhoneTone.bad),
      PhoneMachineStatus.connecting => (
        label: 'Connecting…',
        tone: PhoneTone.busy,
      ),
      PhoneMachineStatus.ready => (
        label: _agentCount(machine.agents.length),
        tone: PhoneTone.good,
      ),
    };

String _agentCount(int count) => switch (count) {
  0 => 'No harnesses yet',
  1 => '1 harness',
  _ => '$count harnesses',
};

/// What an agent is doing, as its row says it. Waiting on the person outranks working, which
/// outranks everything else: it is the one state somebody has to act on.
PhoneSummary phoneAgentSummary(MachineState machine, Agent agent) {
  if (machine.blockedAgents.containsKey(agent.id)) {
    return (label: 'Waiting for you', tone: PhoneTone.attention);
  }
  if (machine.processingAgentIds.contains(agent.id)) {
    return (label: 'Working…', tone: PhoneTone.busy);
  }
  if (!agent.terminalAvailable) {
    return (
      label: agent.terminalUnavailableReason ?? 'No terminal',
      tone: PhoneTone.quiet,
    );
  }
  return (
    label: agent.engineDisplayName ?? agent.engine ?? 'Agent',
    tone: PhoneTone.quiet,
  );
}

/// Whether the streams [machine] lost are on their way back without anybody asking: its socket is
/// dialling, or waiting out a backoff to dial again, or it is up and still fetching what the
/// reattach waits on — once that lands, `_attachPendingPanes` reopens every stream the drop left
/// dead.
///
/// For the terminal header, which reads a dead stream as "Reconnecting…" rather than as a dead end
/// while this holds — see [phoneSessionSummary]. A phone loses its socket every time it goes to the
/// background, so this is the ordinary way back into a terminal, and a Reconnect button over it
/// only ever meant "wait": the press is declined while the socket is down.
///
/// ⚠️ **`disconnected` is not on its way back.** It is a socket this app closed on purpose — signed
/// out, refused by the relay, shut — and nothing redials it; `connecting` and `reconnecting` are the
/// two with a dial behind them (`WsConn._scheduleReconnect`). An offline machine and one that needs
/// its password are out for the same reason: no dial fixes either.
bool phoneMachineRedialling(MachineState machine) {
  if (machine.nodeOnline == false || machine.needsLink) return false;
  return switch (machine.connectionStatus) {
    ConnectionStatus.connecting || ConnectionStatus.reconnecting => true,
    // ⚠️ **Up is not back yet.** The reattach waits for the agent list and the terminal
    // capabilities — `_attachPendingPanes` runs when the later of the two answers — and a refresh
    // over a list already held reports `agentsRefreshing` rather than `loading`. Counting only the
    // socket put "Disconnected" and its button back on screen for the stretch between the socket
    // answering and the stream reopening.
    ConnectionStatus.connected =>
      machine.agentLoadStatus == AgentLoadStatus.loading ||
          machine.agentsRefreshing ||
          machine.terminalCapabilityLoadInFlight != null,
    ConnectionStatus.disconnected => false,
  };
}

/// The terminal's own state, for the header over it. No session yet reads as attaching: the
/// page opens before the pane has one.
/// [takerName]: who took the terminal, when known ([phoneTakerName]) — the
/// dot's tooltip then says "Taken over by Mac mini" rather than just that it was.
/// [reconnecting]: a dead stream is already on its way back — its machine is redialling
/// ([phoneMachineRedialling]), or the person has just pressed Reconnect. Disconnected and Closed
/// then read as "Reconnecting…", busy like Attaching: there is nothing to press, and the header
/// draws the wait rather than a dead end.
PhoneSummary phoneSessionSummary(
  TerminalSession? session, {
  String? takerName,
  bool reconnecting = false,
}) {
  // ⚠️ Checked BEFORE the status, because a watcher's status is `controlling` — it holds a live
  // stream and renders every byte; what it does not hold is the terminal. "Live" would promise a
  // prompt that ignores typing. See [TerminalSession.watching].
  if (session != null && session.watching) {
    return (label: 'Watching', tone: PhoneTone.attention);
  }
  return switch (session?.status) {
    null || TerminalSessionStatus.opening => (
      label: 'Attaching…',
      tone: PhoneTone.busy,
    ),
    TerminalSessionStatus.resyncing => (
      label: 'Resyncing…',
      tone: PhoneTone.busy,
    ),
    TerminalSessionStatus.controlling => (label: 'Live', tone: PhoneTone.good),
    TerminalSessionStatus.takenOver => (
      label: takerName == null ? 'Taken over' : 'Taken over by $takerName',
      tone: PhoneTone.attention,
    ),
    TerminalSessionStatus.error || TerminalSessionStatus.closed
        when reconnecting =>
      (label: 'Reconnecting…', tone: PhoneTone.busy),
    TerminalSessionStatus.error => (label: 'Disconnected', tone: PhoneTone.bad),
    TerminalSessionStatus.closed => (label: 'Closed', tone: PhoneTone.quiet),
  };
}

/// Who took this session's terminal, by the fleet's current name for their
/// machine when this phone knows it, else the name they declared; null while
/// nobody has, or when the daemon did not say (an older one, or a taker that
/// did not introduce itself).
String? phoneTakerName(
  TerminalSession? session,
  String? Function(String machineId) resolveMachine,
) => session?.status == TerminalSessionStatus.takenOver
    ? session?.takenOverBy?.label(resolveMachine)
    : null;

/// The one line under the header while another client drives this terminal —
/// the desktop's banner, at phone size. Null in every other state.
String? phoneTakeoverNotice(TerminalSession? session, String? takerName) =>
    session?.status == TerminalSessionStatus.takenOver
    ? '${takerName ?? 'Another app'} took control of this terminal'
    : null;

/// The way back into a session this device is not driving, or is no longer
/// driving — and what the button offers to do about it.
///
/// `null` while the session is fine, or still coming up: there is nothing to
/// reclaim from "Attaching…", and a button that only ever means "wait" is one
/// the person learns to ignore.
///
/// The desktop puts the same two words on the same two states, in the tile
/// header it draws (`widgets/terminal_panel.dart`); a phone hides that header
/// and draws its own, which is how the way out went missing here.
///
/// [reconnecting]: as for [phoneSessionSummary] — a dead stream already on its
/// way back offers no Reconnect, for the reason above: while the socket is down
/// the press is declined, so the button would only ever mean "wait".
PhoneSummary? phoneReclaimAction(
  TerminalSession? session, {
  bool reconnecting = false,
}) {
  // A watcher is the ordinary way onto an agent another app is driving: output is already on
  // screen, and this is the button that asks for the keyboard. See [TerminalSession.watching].
  if (session != null && session.watching) {
    return (label: 'Take control', tone: PhoneTone.attention);
  }
  return switch (session?.status) {
    TerminalSessionStatus.takenOver => (
      label: 'Take control',
      tone: PhoneTone.attention,
    ),
    TerminalSessionStatus.error ||
    TerminalSessionStatus.closed when reconnecting => null,
    TerminalSessionStatus.error ||
    TerminalSessionStatus.closed => (label: 'Reconnect', tone: PhoneTone.bad),
    _ => null,
  };
}
