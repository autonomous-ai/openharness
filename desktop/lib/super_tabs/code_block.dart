import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// A fenced code block in a message, as Slack shows one: monospace, the
/// fence's name or language over it, and Copy beside that. It shows every
/// line, like the message it is in (anh Dee, 2026-11-09), and wraps one wider
/// than the column rather than scrolling inside the chat.
class SuperTabCodeBlock extends StatelessWidget {
  const SuperTabCodeBlock({super.key, required this.code, this.language});

  final String code;

  /// The fence's info string — `dart`, `main.dart` — or null without one.
  final String? language;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: code));
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('Code copied'), duration: Durations.long4),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.groupGap,
        grid.AppDesktop.menuInset,
        grid.AppDesktop.menuInset,
        grid.AppDesktop.groupGap,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  language ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(),
                ),
              ),
              DesktopPill(
                label: 'Copy',
                icon: AppIcons.copy,
                onPressed: () => unawaited(_copy(context)),
                quiet: true,
                compact: true,
                foregroundColor: DesktopChrome.accent,
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: grid.AppDesktop.controlGap),
            child: Text(
              code,
              softWrap: true,
              style: grid.AppType.mono(
                color: DesktopChrome.foreground,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
