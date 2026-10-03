import 'package:flutter/foundation.dart' show immutable;

/// A Claude Code or Codex conversation Harness did not start, on one machine: run in a terminal or
/// in the engine's own app, found on disk by that machine's daemon
/// (cli/src/lib/sessionSearch/external.ts). Find shows one when a search matches it, and opens it
/// as a new harness resuming it — the desktop Cmd-P's `ExternalSessionRef`, unchanged.
@immutable
class ExternalSessionRef {
  const ExternalSessionRef({
    required this.sessionId,
    required this.engine,
    required this.cwd,
    required this.origin,
    this.title = '',
    this.open = false,
  });

  final String sessionId, engine, cwd, title;

  /// `terminal`, `claude-app`, `codex-app` or `editor`.
  final String origin;

  /// Open in a running process elsewhere: opening it here too would have two processes writing one
  /// conversation.
  final bool open;

  /// Where it ran, as a person says it.
  String get originLabel => switch (origin) {
    'claude-app' => 'Claude app',
    'codex-app' => 'Codex app',
    'editor' => 'editor',
    _ => 'terminal',
  };

  /// The engine as a person says it.
  String get engineLabel => switch (engine) {
    'claude' => 'Claude Code',
    'codex' => 'Codex',
    final other => other,
  };

  /// The folder it ran in, by its own name.
  String get folderName =>
      cwd.split('/').where((part) => part.isNotEmpty).lastOrNull ?? cwd;
}

/// A row id for a conversation Harness did not start — the desktop's `externalDestinationId`.
String externalDestinationId(String machineId, String sessionId) =>
    'external:$machineId:$sessionId';
