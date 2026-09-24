import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/harness_background.dart';
import 'swarm_wallpaper.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../state/workspace_onboarding.dart';
import '../terminal/terminal_text.dart';

/// A quiet terminal welcome. Opening a command is always an explicit action.
class WorkspaceWelcome extends StatefulWidget {
  const WorkspaceWelcome({super.key, required this.onCommand, this.onboarding});

  final ValueChanged<String> onCommand;
  final WorkspaceOnboarding? onboarding;

  @override
  State<WorkspaceWelcome> createState() => _WorkspaceWelcomeState();
}

class _WorkspaceWelcomeState extends State<WorkspaceWelcome> {
  // Keep the last check visible for this visit. A new tab gets a new widget
  // key and chooses its everyday shortcuts after all milestones are complete.
  bool? _showOnboarding;
  String? _scope;

  static const _onboardingActions = [
    (
      'agent.new',
      'New Harness',
      'to start your first harness',
      OnboardingStep.harnesses,
    ),
    (
      'machines.list',
      'Machines',
      'to manage it from anywhere',
      OnboardingStep.machines,
    ),
    (
      'models.list',
      'Models',
      'to power it with a local model',
      OnboardingStep.models,
    ),
  ];
  static const _everydayActions = [
    ('agent.new', 'New Harness', 'to start a new harness', null),
    ('agent.open', 'Open Harness', 'to open a harness', null),
    ('app.store', 'Harness Store', 'to browse the harness store', null),
  ];

  @override
  void didUpdateWidget(WorkspaceWelcome oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.onboarding != widget.onboarding) _showOnboarding = null;
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        terminalFontStore,
        appearancePrefsStore,
        widget.onboarding,
      ]),
      builder: (context, _) => _buildWelcome(context),
    );
  }

  Widget _buildWelcome(BuildContext context) {
    grid.AppTheme.watch(context);
    final onboarding = widget.onboarding;
    if (_scope != onboarding?.scope) {
      _scope = onboarding?.scope;
      _showOnboarding = null;
    }
    if (onboarding?.loaded == true) {
      _showOnboarding ??= !onboarding!.complete;
    }
    final showOnboarding = onboarding != null && (_showOnboarding ?? true);
    final palette = grid.AppTheme.palette.value;
    final background = appearancePrefsStore.value.background;
    final hasArtwork = background != HarnessBackground.plain;
    final ink = hasArtwork
        ? const Color(0xffdededb)
        : palette.foreground.withValues(alpha: .75);
    final accent = hasArtwork || Theme.of(context).brightness == Brightness.dark
        ? const Color(0xffa5d786)
        : const Color(0xff356522);
    // The page stands where a terminal will, so it is set like one: the
    // terminal's face at the terminal's size, following ⌘+ and ⌘−.
    final style = terminalTextStyle(
      color: ink,
      fontWeight: FontWeight.w400,
      height: 1.5,
    );
    final keymap = KeymapTheme.of(context)?.current ?? harnessDefaultKeymap;
    final rows = [
      for (final (command, label, description, step)
          in showOnboarding ? _onboardingActions : _everydayActions)
        (
          command: command,
          label: label,
          description: description,
          step: step,
          completed: step != null && onboarding?.completed(step) == true,
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

    final progressWidth = showOnboarding ? widthOf('✓  ') : 0.0;
    final prefixWidth = widthOf('press  ');
    final keyWidth = rows
        .map((row) => widthOf('${row.hint ?? row.label}    '))
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
                        maxWidth:
                            progressWidth +
                            prefixWidth +
                            keyWidth +
                            descriptionWidth,
                      ),
                      child: DefaultTextStyle(
                        style: style,
                        textAlign: TextAlign.center,
                        child: Column(
                          key: const ValueKey('workspace-welcome-text'),
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              showOnboarding
                                  ? 'Harness like a boss.'
                                  : 'Follow your curiosity.',
                              key: const ValueKey('welcome-tagline'),
                            ),
                            SizedBox(height: line),
                            for (final row in rows)
                              TextButton(
                                key: ValueKey('welcome-${row.command}'),
                                onPressed: () => widget.onCommand(row.command),
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
                                    if (row.step != null)
                                      SizedBox(
                                        width: progressWidth,
                                        child: Text(
                                          row.completed ? '✓' : '○',
                                          key: ValueKey(
                                            'welcome-progress-${row.step!.name}',
                                          ),
                                          semanticsLabel: row.completed
                                              ? 'Completed'
                                              : 'Not completed',
                                          textAlign: TextAlign.left,
                                          style: TextStyle(
                                            color: row.completed ? accent : ink,
                                          ),
                                        ),
                                      ),
                                    SizedBox(
                                      width: prefixWidth,
                                      child: Text(
                                        row.hint == null ? 'click' : 'press',
                                      ),
                                    ),
                                    SizedBox(
                                      width: keyWidth,
                                      child: Text(
                                        row.hint ?? row.label,
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
            child: TextButton.icon(
              key: const ValueKey('welcome-customize'),
              onPressed: () => widget.onCommand('app.customize'),
              icon: const Icon(Icons.edit_outlined, size: 18),
              label: const Text('Customize Harness'),
              style: TextButton.styleFrom(
                foregroundColor: ink,
                backgroundColor: hasArtwork
                    ? const Color(0xcc242424)
                    : grid.AppPalette.swarmTabBar,
                textStyle: terminalTextStyle(),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                shape: const StadiumBorder(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
