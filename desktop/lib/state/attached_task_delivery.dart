import 'dart:async';

import 'package:xterm/xterm.dart';

import '../logging/app_log.dart';
import '../terminal/terminal_session.dart';
import 'app_state.dart';
import 'harness_attachments.dart';

/// How long a new harness has to open its terminal and start its engine.
/// An observed Codex update waits for completion or pane closure instead: the
/// person may leave its confirmation open for longer than this deadline.
const kAttachedTaskOpenTimeout = Duration(minutes: 2);

/// A beat after the engine reports ready, for its input to be drawn.
const kAttachedTaskSettle = Duration(milliseconds: 800);

/// Codex can be alive in its updater before it opens a conversation. An empty
/// chat may not have a session ID yet either. Read only the visible terminal,
/// looking for its composer and footer together, not a menu's selected row or
/// an old prompt in scrollback.
enum _CodexStartup { waiting, updating, ready }

_CodexStartup _codexStartup(Terminal terminal) {
  final buffer = terminal.buffer;
  final lines = [
    for (var row = buffer.scrollBack; row < buffer.height; row++)
      buffer.lines[row].getText(),
  ];
  final prompt = lines.lastIndexWhere(
    (line) => RegExp(r'^\s*›').hasMatch(line),
  );
  if (prompt >= 0 &&
      lines
          .skip(prompt + 1)
          .any(
            (line) =>
                RegExp(r'\? for shortcuts|\d+% context left').hasMatch(line),
          )) {
    return _CodexStartup.ready;
  }
  if (RegExp(
    r'Update available!|Updating Codex via|Update ran successfully! Please restart Codex\.',
  ).hasMatch(lines.join('\n'))) {
    return _CodexStartup.updating;
  }
  return _CodexStartup.waiting;
}

/// Can [machineId] take files into a harness's prompt? Both halves are the
/// daemon's: a file written there and its path pasted, then a space pasted.
bool canAttachFiles(AppNotifier app, String machineId) {
  final machine = app.stateOf(machineId);
  return machine != null &&
      machine.terminalPasteFileAvailable &&
      machine.terminalPasteRawAvailable;
}

/// Hands a new harness its files, then its first message.
///
/// A first message given at creation reaches the engine as a launch argument,
/// before any file could: files only travel into a live terminal, which writes
/// each on the harness's machine and pastes its path into the prompt. So a task
/// with files is created without one, and sent here once the prompt holds the
/// paths — as a composer message, which the machine submits and retries Enter
/// for. Returns what went wrong, or null.
Future<String?> deliverAttachedTask(
  AppNotifier app, {
  required String machineId,
  required String agentId,
  required List<HarnessAttachment> files,
  required String task,
}) async {
  appLog.info('attach', 'waiting on $agentId for ${files.length} file(s)');
  final session = await _readySession(app, machineId, agentId);
  if (session == null) {
    appLog.warn('attach', '$agentId never took input');
    return 'The harness did not open in time. Attach the files in its pane.';
  }
  for (final file in files) {
    if (!await session.pasteFile(file.name, file.bytes) ||
        !await session.pasteText(' ')) {
      appLog.warn('attach', '${file.name} did not reach $agentId');
      return 'Could not attach ${file.name}. Attach it in the pane.';
    }
  }
  appLog.info('attach', '${files.length} file(s) in $agentId; sending task');
  if (task.trim().isEmpty) return null;
  return await session.sendComposerText(task)
      ? null
      : 'The files are attached, but the task was not sent.';
}

/// The harness's terminal once its engine is up and the pane takes input.
Future<TerminalSession?> _readySession(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  var claimed = false;
  TerminalSession? watchedSession;
  Terminal? watchedTerminal;
  Timer? timeout;
  late void Function() check;
  TerminalSession? ready() {
    final agent = app
        .stateOf(machineId)
        ?.agents
        .where((agent) => agent.id == agentId)
        .firstOrNull;
    if (agent?.launchState != 'ready') return null;
    final session = app
        .panesFor(machineId)
        .where((pane) => pane.agentId == agentId)
        .map((pane) => pane.session)
        .nonNulls
        .firstOrNull;
    if (session == null) return null;
    // Output and replacement keyframes need not change the agent inventory.
    // Watch both so the queued task wakes up when the new composer is drawn.
    if (!identical(watchedSession, session)) {
      watchedSession?.removeListener(check);
      watchedSession = session..addListener(check);
    }
    if (!identical(watchedTerminal, session.terminal)) {
      watchedTerminal?.removeListener(check);
      watchedTerminal = session.terminal..addListener(check);
    }
    if (session.acceptsInput) {
      if (agent?.engine == 'codex') {
        final startup = _codexStartup(session.terminal);
        if (startup == _CodexStartup.updating) timeout?.cancel();
        if (startup != _CodexStartup.ready) return null;
      }
      return session;
    }
    // A pane that arrives over the desk opens as a watcher, and another window
    // on the account (the Mac's own app) may hold the terminal. Pressing New
    // Harness with files is this person asking to type here: take it, once,
    // as the band's "Take control" does.
    if (!claimed &&
        session.streamId != null &&
        (session.watching ||
            session.status == TerminalSessionStatus.takenOver)) {
      claimed = true;
      appLog.info('attach', 'taking control of $agentId to hand it its files');
      // A local takeover can notify synchronously. Check again after reopen
      // returns so that notification cannot be cancelled by this call's null.
      unawaited(session.reopen(force: true).then((_) => check()));
    }
    return null;
  }

  final found = Completer<TerminalSession?>();
  TerminalSession? candidate;
  Timer? settle;
  check = () {
    if (found.isCompleted) return;
    if (watchedSession != null &&
        !app.panesFor(machineId).any((pane) => pane.agentId == agentId)) {
      found.complete(null);
      return;
    }
    final session = ready();
    if (identical(candidate, session)) return;
    settle?.cancel();
    candidate = session;
    if (session == null) return;
    settle = Timer(kAttachedTaskSettle, () {
      if (found.isCompleted) return;
      if (identical(ready(), session)) {
        found.complete(session);
      } else {
        candidate = null;
        check();
      }
    });
  };

  timeout = Timer(kAttachedTaskOpenTimeout, () {
    if (!found.isCompleted) found.complete(null);
  });
  app.addListener(check);
  check();
  try {
    return await found.future;
  } finally {
    timeout.cancel();
    settle?.cancel();
    watchedSession?.removeListener(check);
    watchedTerminal?.removeListener(check);
    app.removeListener(check);
  }
}

/// Sends [task] into an existing harness through its pane, as a person typing it would: once its engine
/// takes input, as a composer message the machine submits and retries Enter for. ⌘B's router decides
/// where (docs/design/2026-10-09-auto-router.md); this is the app's own door, the same on every machine.
/// Returns what went wrong, or null. [stillWanted], when given, is asked once the pane takes input, the
/// moment before the words are typed: the wait for it can be seconds, and a send the person walked away
/// from in that time must not land.
Future<String?> deliverTask(
  AppNotifier app, {
  required String machineId,
  required String agentId,
  required String task,
  bool Function()? stillWanted,
}) async {
  final session = await _readySession(app, machineId, agentId);
  if (session == null) {
    appLog.warn('route', '$agentId never took input');
    return 'The harness did not open in time. Nothing was sent.';
  }
  if (stillWanted != null && !stillWanted()) return 'Nothing was sent.';
  return await session.sendComposerText(task)
      ? null
      : 'The task did not reach the harness. Send it from its pane.';
}
