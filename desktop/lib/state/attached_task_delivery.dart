import 'dart:async';

import '../logging/app_log.dart';
import '../terminal/terminal_session.dart';
import 'app_state.dart';
import 'harness_attachments.dart';

/// How long a new harness has to open its terminal and start its engine.
const kAttachedTaskOpenTimeout = Duration(minutes: 2);

/// A beat after the engine reports ready, for its input to be drawn.
const kAttachedTaskSettle = Duration(milliseconds: 800);

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
    if (session.acceptsInput) return session;
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
      unawaited(session.reopen(force: true));
    }
    return null;
  }

  final found = Completer<TerminalSession?>();
  void check() {
    if (found.isCompleted) return;
    if (ready() case final session?) found.complete(session);
  }

  final timeout = Timer(kAttachedTaskOpenTimeout, () {
    if (!found.isCompleted) found.complete(null);
  });
  app.addListener(check);
  check();
  try {
    final session = await found.future;
    if (session == null) return null;
    await Future<void>.delayed(kAttachedTaskSettle);
    return session.acceptsInput ? session : null;
  } finally {
    timeout.cancel();
    app.removeListener(check);
  }
}
