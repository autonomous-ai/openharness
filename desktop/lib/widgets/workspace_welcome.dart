import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/harness_background.dart';
import 'swarm_wallpaper.dart';
import 'terminal_text_action.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../terminal/terminal_text.dart';

/// A quiet terminal welcome. Opening a command is always an explicit action.
class WorkspaceWelcome extends StatelessWidget {
  const WorkspaceWelcome({super.key, required this.onCommand});

  final ValueChanged<String> onCommand;

  static const _actions = [
    ('agent.new', 'Start an agent'),
    ('harnesses.list', 'Manage all your agents'),
    ('models.list', 'Deploy a local model'),
    ('machines.list', 'Manage all your machines'),
    ('app.store', 'Build beyond code'),
  ];

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([terminalFontStore, appearancePrefsStore]),
      builder: (context, _) => _buildWelcome(context),
    );
  }

  Widget _buildWelcome(BuildContext context) {
    grid.AppTheme.watch(context);
    final palette = grid.AppTheme.palette.value;
    final background = appearancePrefsStore.value.background;
    final hasArtwork = background != HarnessBackground.plain;
    final ink = hasArtwork
        ? const Color(0xffdededb)
        : palette.foreground.withValues(alpha: .75);
    // The welcome surface uses a dark workspace palette in both theme modes.
    const accent = Color(0xffa5d786);
    // The page stands where a terminal will, so it is set like one: the
    // terminal's face at the terminal's size, following ⌘+ and ⌘−.
    final style = terminalTextStyle(
      color: ink,
      fontWeight: FontWeight.w400,
      height: 1.5,
    );
    final keymap = KeymapTheme.of(context)?.current ?? harnessDefaultKeymap;
    final rows = [
      for (final (command, description) in _actions)
        (
          command: command,
          description: description,
          hint: keymap
              .bindingsFor(KeymapContext.workspace)
              .where((binding) => binding.command == command)
              .map(describeKeyBinding)
              .firstOrNull,
        ),
    ];
    double widthOf(String text) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      final width = painter.width;
      painter.dispose();
      return width;
    }

    final keyWidth = rows
        .map((row) => widthOf('${row.hint ?? ''}    '))
        .reduce((a, b) => a > b ? a : b);
    final descriptionWidth = rows
        .map((row) => widthOf(row.description))
        .reduce((a, b) => a > b ? a : b);
    final line = MediaQuery.textScalerOf(context).scale(style.fontSize!) * 1.5;
    final footerInset = line + 52;
    return Material(
      key: const ValueKey('workspace-welcome'),
      color: grid.AppPalette.swarmWelcome,
      child: Stack(
        fit: StackFit.expand,
        children: [
          RepaintBoundary(
            key: const ValueKey('welcome-wallpaper'),
            child: SwarmWallpaper(background: background),
          ),
          LayoutBuilder(
            // Keep the text centered when it fits, but let large text scroll
            // above the fixed Customize button rather than underneath it.
            builder: (context, constraints) => Padding(
              padding: EdgeInsets.only(bottom: footerInset),
              child: SingleChildScrollView(
                key: const ValueKey('welcome-scroll'),
                padding: EdgeInsets.fromLTRB(24, footerInset + 24, 24, 24),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: (constraints.maxHeight - footerInset * 2 - 48)
                        .clamp(0, double.infinity),
                  ),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: keyWidth + descriptionWidth,
                      ),
                      child: DefaultTextStyle(
                        style: style,
                        textAlign: TextAlign.center,
                        child: Column(
                          key: const ValueKey('workspace-welcome-text'),
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'Harness like a boss.',
                              key: const ValueKey('welcome-tagline'),
                            ),
                            SizedBox(height: line),
                            for (final row in rows)
                              TextButton(
                                key: ValueKey('welcome-${row.command}'),
                                onPressed: () => onCommand(row.command),
                                style: TextButton.styleFrom(
                                  foregroundColor: ink,
                                  textStyle: style,
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 2,
                                  ),
                                  minimumSize: Size.zero,
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                  shape: const RoundedRectangleBorder(),
                                ),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    SizedBox(
                                      width: keyWidth,
                                      child: Text(
                                        row.hint ?? '',
                                        style: TextStyle(color: accent),
                                        textAlign: TextAlign.left,
                                      ),
                                    ),
                                    Expanded(
                                      child: Text(
                                        row.description,
                                        textAlign: TextAlign.left,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            right: 20,
            bottom: 16,
            child: TerminalTextAction(
              key: const ValueKey('welcome-customize'),
              onPressed: () => onCommand('app.customize'),
              label: 'Customize Harness',
              overArtwork: hasArtwork,
            ),
          ),
        ],
      ),
    );
  }
}
