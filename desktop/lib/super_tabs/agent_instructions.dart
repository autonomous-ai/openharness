import 'dart:io';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/swarm_layout.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// An agent's own instructions (Swarm v4, anh Dee 2026-11-08): the plain file `agents/<name>.md` in its repo, which the
/// agent writes when its person tells it a rule and reads at every start. Shown as it is, read-only, beside the chat.
class SwarmAgentInstructions extends StatelessWidget {
  const SwarmAgentInstructions({
    super.key,
    required this.agent,
    required this.app,
    required this.onClose,
    this.read = _readFile,
  });

  final SuperTabAgent agent;
  final AppNotifier? app;
  final VoidCallback onClose;

  /// Reads a file's text, or null when it is not there; tests pass their own.
  final Future<String?> Function(String path) read;

  static Future<String?> _readFile(String path) async {
    final file = File(path);
    return await file.exists() ? file.readAsString() : null;
  }

  /// The file's path, when the agent runs on this computer and its folder is known.
  String? get path {
    final machine = app?.stateOf(agent.machineId);
    if (machine == null || !machine.isLocalMachine) return null;
    final cwd = machine.agents
        .where((a) => a.id == agent.harnessId)
        .firstOrNull
        ?.project
        ?.cwd;
    return cwd == null ? null : '$cwd/agents/${agent.name}.md';
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final path = this.path;
    return ColoredBox(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(
              horizontal: SwarmLayout.barSide,
            ),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Text(
                  'agents/${agent.name}.md',
                  style: DesktopChrome.text(medium: true),
                ),
                const Spacer(),
                AppIconButton(
                  key: const ValueKey('swarm-instructions-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: onClose,
                ),
              ],
            ),
          ),
          Expanded(
            child: path == null
                ? _note('Open it on ${agent.name}\'s computer.')
                : FutureBuilder<String?>(
                    future: read(path),
                    builder: (context, file) => switch (file) {
                      AsyncSnapshot(hasData: true, :final data?) =>
                        SingleChildScrollView(
                          padding: const EdgeInsets.all(SwarmLayout.barSide),
                          child: SelectableText(
                            data,
                            key: const ValueKey('swarm-instructions-text'),
                            style: grid.AppType.mono(
                              color: DesktopChrome.foreground,
                            ),
                          ),
                        ),
                      AsyncSnapshot(connectionState: ConnectionState.done) =>
                        _note(
                          'No instructions yet. Tell ${agent.name} how you '
                          'want it to work, and it writes them here.',
                        ),
                      _ => const SizedBox.shrink(),
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _note(String text) => Padding(
    padding: const EdgeInsets.all(SwarmLayout.barSide),
    child: Text(text, style: DesktopChrome.metadata()),
  );
}
