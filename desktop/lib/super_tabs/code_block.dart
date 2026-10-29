import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// A fenced code block in a message, as Slack shows one: monospace, the
/// fence's name or language over it, Copy beside that, and a long one folded
/// to its first [foldedLines] lines behind Show more.
class SuperTabCodeBlock extends StatefulWidget {
  const SuperTabCodeBlock({super.key, required this.code, this.language});

  static const foldedLines = 12;

  final String code;

  /// The fence's info string — `dart`, `main.dart` — or null without one.
  final String? language;

  @override
  State<SuperTabCodeBlock> createState() => _SuperTabCodeBlockState();
}

class _SuperTabCodeBlockState extends State<SuperTabCodeBlock> {
  bool _unfolded = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('Code copied'), duration: Durations.long4),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final lines = widget.code.split('\n');
    final long = lines.length > SuperTabCodeBlock.foldedLines;
    final shown = long && !_unfolded
        ? lines.take(SuperTabCodeBlock.foldedLines).join('\n')
        : widget.code;
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
                  widget.language ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(),
                ),
              ),
              _quiet(label: 'Copy', icon: AppIcons.copy, onPressed: _copy),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: grid.AppDesktop.controlGap),
            child: Text(
              shown,
              softWrap: true,
              style: grid.AppType.mono(
                color: DesktopChrome.foreground,
                height: 1.5,
              ),
            ),
          ),
          if (long)
            _quiet(
              label: _unfolded ? 'Show less' : 'Show more',
              onPressed: () => setState(() => _unfolded = !_unfolded),
            ),
        ],
      ),
    );
  }
}

/// A quiet control in the block, in the accent: no fill or rim at rest.
Widget _quiet({
  required String label,
  required VoidCallback onPressed,
  IconData? icon,
}) => DesktopPill(
  label: label,
  icon: icon,
  onPressed: onPressed,
  quiet: true,
  compact: true,
  foregroundColor: DesktopChrome.accent,
);
