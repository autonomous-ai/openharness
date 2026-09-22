import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import 'box_chrome.dart';
import 'welcome_project_example.dart';

/// A quiet, live keyboard map for an empty workspace. The drawing illustrates
/// tabs and panes. Only the full shortcuts link is interactive.
class WorkspaceStartGuide extends StatelessWidget {
  const WorkspaceStartGuide({super.key, required this.onShortcuts});

  final VoidCallback onShortcuts;

  String _hint(BuildContext context, String command) =>
      KeymapTheme.of(context)?.hint(command) ??
      (KeymapTheme.of(context) == null
          ? harnessDefaultKeymap
                .bindingsFor(KeymapContext.workspace)
                .where((binding) => binding.command == command)
                .map(describeKeyBinding)
                .firstOrNull
          : null) ??
      '';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ink = grid.AppTheme.palette.value.foreground;
    final faint = ink.withValues(alpha: .62);
    final accent = grid.AppPalette.swarmAccent;
    final stroke = faint.withValues(alpha: .30);
    return Material(
      color: grid.AppPalette.swarmWelcome,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final scale = terminalTextScaleOf(context);
          final compact = constraints.maxWidth < 680 * scale;
          final short = constraints.maxHeight < 420 * scale;
          Widget callout(String command, String label, String explanation) =>
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          if (_hint(context, command).isNotEmpty)
                            TextSpan(
                              text: '${_hint(context, command)}  ',
                              style: TextStyle(color: accent),
                            ),
                          TextSpan(text: label),
                        ],
                      ),
                      style: boxMonoStyle(color: ink),
                    ),
                    const SizedBox(height: 4),
                    Text(explanation, style: boxMonoStyle(color: faint)),
                  ],
                ),
              );
          final diagram = Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 40),
                child: Text(
                  'Follow your curiosity. Build across disciplines.',
                  textAlign: TextAlign.center,
                  style: boxMonoStyle(color: ink, weight: FontWeight.w600),
                ),
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: callout(
                      'swarm.new',
                      'New Tab',
                      'Group multiple harnesses in one tab.',
                    ),
                  ),
                  Flexible(
                    child: callout(
                      'app.store',
                      'Harness Store',
                      'Code, 3D design, circuits, video, and more.',
                    ),
                  ),
                ],
              ),
              SizedBox(
                height: 14,
                width: double.infinity,
                child: CustomPaint(painter: _GuideArrows(stroke, top: true)),
              ),
              ExcludeSemantics(
                child: Container(
                  decoration: BoxDecoration(border: Border.all(color: stroke)),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        decoration: BoxDecoration(
                          border: Border(bottom: BorderSide(color: stroke)),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Row(
                                children: [
                                  Flexible(
                                    child: Text(
                                      'robot arm',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: boxMonoStyle(color: faint),
                                    ),
                                  ),
                                  if (!compact) ...[
                                    const SizedBox(width: 32),
                                    Text(
                                      'launch video',
                                      style: boxMonoStyle(color: faint),
                                    ),
                                  ],
                                  const SizedBox(width: 20),
                                  Text('+', style: boxMonoStyle(color: faint)),
                                ],
                              ),
                            ),
                            Text(
                              compact ? 'Store' : 'Harness Store',
                              style: boxMonoStyle(color: faint),
                            ),
                          ],
                        ),
                      ),
                      SizedBox(
                        height: (constraints.maxHeight - 254 * scale).clamp(
                          (short ? 220 : 280) * scale,
                          340 * scale,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: _DrawnPane(
                                name: 'Claude Code',
                                example: WelcomeProjectExample.code,
                                task: 'Write the robot arm control code',
                                showLocation: !short,
                                ink: ink,
                                faint: faint,
                                accent: accent,
                              ),
                            ),
                            VerticalDivider(
                              width: 1,
                              thickness: 1,
                              color: stroke,
                            ),
                            Expanded(
                              child: Column(
                                children: [
                                  Expanded(
                                    child: _DrawnPane(
                                      name: 'Blender',
                                      example: WelcomeProjectExample.gripper,
                                      task: 'Design a printable robot gripper',
                                      showLocation: !short,
                                      ink: ink,
                                      faint: faint,
                                      accent: accent,
                                    ),
                                  ),
                                  Divider(
                                    height: 1,
                                    thickness: 1,
                                    color: stroke,
                                  ),
                                  Expanded(
                                    child: _DrawnPane(
                                      name: 'KiCad',
                                      example: WelcomeProjectExample.circuit,
                                      task: 'Design the motor controller board',
                                      showLocation: !short,
                                      ink: ink,
                                      faint: faint,
                                      accent: accent,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              SizedBox(
                height: 14,
                width: double.infinity,
                child: CustomPaint(painter: _GuideArrows(stroke)),
              ),
              Row(
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        key: const ValueKey('workspace-all-shortcuts'),
                        onPressed: onShortcuts,
                        style: TextButton.styleFrom(foregroundColor: faint),
                        child: Text(
                          '${_hint(context, 'keyboard.help')}  All Keyboard Shortcuts'
                              .trimLeft(),
                          style: boxMonoStyle(color: faint),
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Align(
                      alignment: Alignment.center,
                      child: callout(
                        'agent.open',
                        'New Pane',
                        'Add a harness beside your work.',
                      ),
                    ),
                  ),
                ],
              ),
            ],
          );
          final horizontalPadding = compact ? 16.0 : 24.0;
          return Padding(
            padding: EdgeInsets.symmetric(
              horizontal: horizontalPadding,
              vertical: 12,
            ),
            child: Center(
              // Scroll the reference without shrinking its text.
              child: SingleChildScrollView(
                child: SizedBox(
                  key: const ValueKey('workspace-welcome-diagram'),
                  width: (constraints.maxWidth - horizontalPadding * 2).clamp(
                    0.0,
                    1000.0,
                  ),
                  child: diagram,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _DrawnPane extends StatelessWidget {
  const _DrawnPane({
    required this.name,
    required this.example,
    required this.task,
    required this.ink,
    required this.faint,
    required this.accent,
    this.showLocation = true,
  });
  final String name, task;
  final WelcomeProjectExample example;
  final Color ink, faint, accent;
  final bool showLocation;
  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final copy = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: boxMonoStyle(color: ink),
        ),
        if (showLocation) ...[
          const SizedBox(height: 6),
          Text(
            'This Mac:~/work/robot-arm',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: boxMonoStyle(color: faint),
          ),
        ],
        const SizedBox(height: 10),
        Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: '› ',
                style: TextStyle(color: accent),
              ),
              TextSpan(text: '$task ▏'),
            ],
          ),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: boxMonoStyle(color: ink),
        ),
      ],
    );
    final output = WelcomeProjectOutput(
      example: example,
      ink: ink,
      faint: faint,
    );
    return Padding(
      padding: const EdgeInsets.all(12),
      child: example == WelcomeProjectExample.code
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                copy,
                const SizedBox(height: 16),
                Expanded(child: output),
              ],
            )
          : Row(
              children: [
                Expanded(flex: 3, child: copy),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: output),
              ],
            ),
    );
  }
}

class _GuideArrows extends CustomPainter {
  const _GuideArrows(this.color, {this.top = false});
  final Color color;
  final bool top;
  @override
  void paint(Canvas canvas, Size size) {
    final pen = Paint()
      ..color = color
      ..strokeWidth = 1;
    void arrow(double x, {required bool down}) {
      final tip = Offset(x, down ? size.height - 2 : 2);
      canvas.drawLine(Offset(x, down ? 0 : size.height), tip, pen);
      for (final side in [-1, 1]) {
        canvas.drawLine(tip, tip + Offset(4.0 * side, down ? -5 : 5), pen);
      }
    }

    if (top) {
      arrow(56, down: true);
      arrow(size.width - 56, down: true);
    } else {
      arrow(size.width * .75, down: false);
    }
  }

  @override
  bool shouldRepaint(_GuideArrows old) => old.color != color || old.top != top;
}
