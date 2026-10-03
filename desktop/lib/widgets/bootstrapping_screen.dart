import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// The bridge between opening Harness and reaching the workspace.
///
/// Current and recent messages come from bootstrap itself. Startup has no
/// measurable total, so its activity indicator never invents a percentage.
class BootstrappingScreen extends StatefulWidget {
  const BootstrappingScreen({super.key, this.statusMessage});

  final String? statusMessage;

  static const double _contentWidth = 470;
  static const String _fallbackStatus = 'Opening Harness…';

  @override
  State<BootstrappingScreen> createState() => _BootstrappingScreenState();
}

class _BootstrappingScreenState extends State<BootstrappingScreen> {
  /// Every status this screen has shown, oldest first. Keep recent context
  /// without letting a chatty bootstrap turn into an unbounded history.
  final List<String> _history = [];
  static const _keep = 4;

  @override
  void initState() {
    super.initState();
    _rememberStatus(
      widget.statusMessage ?? BootstrappingScreen._fallbackStatus,
    );
  }

  @override
  void didUpdateWidget(BootstrappingScreen old) {
    super.didUpdateWidget(old);
    _rememberStatus(
      widget.statusMessage ?? BootstrappingScreen._fallbackStatus,
    );
  }

  void _rememberStatus(String message) {
    if (_history.isNotEmpty && _history.last == message) return;
    _history.add(message);
    if (_history.length > _keep) _history.removeAt(0);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final status = widget.statusMessage ?? BootstrappingScreen._fallbackStatus;
    final earlier = _history.length > 1
        ? _history.sublist(0, _history.length - 1)
        : const <String>[];
    final indicatorSize = MediaQuery.textScalerOf(context).scale(20);

    return DesktopChrome(
      child: Scaffold(
        backgroundColor: grid.AppPalette.windowBg,
        body: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(DesktopChrome.panelPadding),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                maxWidth: BootstrappingScreen._contentWidth,
              ),
              // Centred line by line: the block is up to 470 wide, and its lines are
              // mostly shorter, so a start-aligned column read as sitting left of centre.
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      'Opening your workspace',
                      style: grid.AppType.title(
                        color: DesktopChrome.foreground,
                        height: 1.3,
                      ),
                    ),
                  ),
                  const SizedBox(height: DesktopChrome.panelPadding),
                  Semantics(
                    key: const Key('boot-status'),
                    container: true,
                    liveRegion: true,
                    label: 'Harness startup status',
                    value: status,
                    child: ExcludeSemantics(
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox.square(
                            dimension: indicatorSize,
                            child: MediaQuery.disableAnimationsOf(context)
                                ? Icon(
                                    AppIcons.hourglass,
                                    size: indicatorSize,
                                    color: DesktopChrome.muted,
                                  )
                                : CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: DesktopChrome.accent,
                                  ),
                          ),
                          const SizedBox(width: 12),
                          Flexible(
                            child: Text(
                              status,
                              key: ValueKey(status),
                              style: DesktopChrome.text(),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (earlier.isNotEmpty) ...[
                    const SizedBox(height: DesktopChrome.panelPadding),
                    Divider(height: 1, color: DesktopChrome.rim),
                    const SizedBox(height: DesktopChrome.groupGap),
                    Text(
                      'Recent activity',
                      style: DesktopChrome.control(medium: true),
                    ),
                    for (final line in earlier) ...[
                      const SizedBox(height: DesktopChrome.controlGap),
                      Text(
                        line,
                        textAlign: TextAlign.center,
                        style: DesktopChrome.metadata(),
                      ),
                    ],
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
