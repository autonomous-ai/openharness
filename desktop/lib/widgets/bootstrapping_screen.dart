import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';
import 'terminal_progress.dart';

/// The bridge between opening Harness and reaching the workspace.
///
/// Printed as a session, not as a screen: a prompt line, then each thing the
/// app does as its own line, the way `harness start` would say it in a shell.
/// The lines behind the current one stay on screen and dim, because that is
/// what a terminal does with what it has already said — and it is the whole
/// difference between "something is happening" and a spinner (owner,
/// 2026-09-23). Everything is the terminal's face at the terminal's size.
///
/// Bootstrap cannot count what it is doing, so the bar carries a travelling
/// block and prints no figure rather than inventing one.
class BootstrappingScreen extends StatefulWidget {
  const BootstrappingScreen({super.key, this.statusMessage});

  final String? statusMessage;

  static const double _boxWidth = 470;
  static const String _fallbackStatus = 'Opening Harness…';

  @override
  State<BootstrappingScreen> createState() => _BootstrappingScreenState();
}

class _BootstrappingScreenState extends State<BootstrappingScreen> {
  /// Every status this screen has shown, oldest first. Bounded because a
  /// bootstrap that keeps talking must not grow the box past the window.
  final List<String> _printed = [];
  static const _keep = 4;

  @override
  void initState() {
    super.initState();
    _print(widget.statusMessage ?? BootstrappingScreen._fallbackStatus);
  }

  @override
  void didUpdateWidget(BootstrappingScreen old) {
    super.didUpdateWidget(old);
    _print(widget.statusMessage ?? BootstrappingScreen._fallbackStatus);
  }

  void _print(String line) {
    if (_printed.isNotEmpty && _printed.last == line) return;
    _printed.add(line);
    if (_printed.length > _keep) _printed.removeAt(0);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final status = widget.statusMessage ?? BootstrappingScreen._fallbackStatus;
    final earlier = _printed.length > 1
        ? _printed.sublist(0, _printed.length - 1)
        : const <String>[];

    return Scaffold(
      backgroundColor: grid.AppPalette.swarmField,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: BootstrappingScreen._boxWidth,
            ),
            child: TerminalBox(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '$kBootPrompt harness start',
                      style: boxMonoStyle(weight: FontWeight.w600),
                    ),
                    const SizedBox(height: 8),
                    for (final line in earlier) ...[
                      Text(line, style: boxMonoStyle(color: kBoxFaint)),
                      const SizedBox(height: 1),
                    ],
                    const SizedBox(height: 1),
                    const TerminalProgressLine(),
                    const SizedBox(height: 8),
                    Semantics(
                      key: const Key('boot-status'),
                      container: true,
                      liveRegion: true,
                      label: 'Harness startup status',
                      value: status,
                      child: ExcludeSemantics(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Flexible(
                              child: Text(
                                status,
                                key: ValueKey(status),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: boxMonoStyle(),
                              ),
                            ),
                            const SizedBox(width: 6),
                            const TerminalCursor(),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
