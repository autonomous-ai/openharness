import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/prompt_style.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
import 'search_result_text.dart';

/// The same compact identity line in the picker, pane header and live preview.
/// Symbols use our bundled icon font; Powerline separators are drawn shapes.
/// Changing the terminal font therefore never requires a patched Nerd Font.
class PromptContextView extends StatelessWidget {
  const PromptContextView({
    super.key,
    required this.contextData,
    this.prefs,
    this.store,
    this.matches = const [],
  });

  final PromptContext contextData;
  final PromptPrefs? prefs;
  final AppearancePrefsStore? store;
  double get size => terminalFontStore.size;
  final Iterable<SearchFieldMatch> matches;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        store ?? appearancePrefsStore,
        terminalFontStore,
      ]),
      builder: (context, _) =>
          _line(prefs ?? (store ?? appearancePrefsStore).value.prompt),
    );
  }

  Widget _line(PromptPrefs prefs) {
    final data = contextData;
    final segments =
        <
          ({
            String label,
            String value,
            String ascii,
            IconData? icon,
            Color color,
          })
        >[
          if (data.harness?.isNotEmpty == true)
            (
              label: 'Harness',
              value: data.harness!,
              ascii: kHarnessPromptMarker,
              icon: null,
              color: Colors.white60,
            ),
          if (data.leading?.isNotEmpty == true)
            (
              label: '',
              value: data.leading!,
              ascii: '',
              icon: null,
              color: Colors.white60,
            ),
          if (prefs.machine && data.machine?.isNotEmpty == true)
            (
              label: 'Machine',
              value: data.machine!,
              ascii: '@',
              icon: LucideIcons.monitor300,
              color: grid.AppPalette.swarmAccent,
            ),
          if (prefs.project && data.project?.isNotEmpty == true)
            (
              label: 'Project',
              value: data.project!,
              ascii: '/',
              icon: LucideIcons.folder300,
              color: grid.AppPalette.teal,
            ),
          if (prefs.branch && data.branch?.isNotEmpty == true)
            (
              label: 'Branch',
              value: data.branch!,
              ascii: 'git:',
              icon: LucideIcons.gitBranch300,
              color: grid.AppPalette.online,
            ),
        ];
    if (segments.isEmpty) return const SizedBox.shrink();
    final powerline = prefs.style == PromptStyle.powerline;
    return Semantics(
      label: segments
          .map(
            (part) =>
                '${part.label.isEmpty ? '' : '${part.label}: '}${part.value}',
          )
          .join(', '),
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var index = 0; index < segments.length; index++) ...[
              if (index > 0 && !powerline) const SizedBox(width: 12),
              Flexible(
                child: Builder(
                  builder: (context) {
                    final part = segments[index];
                    final tone = prefs.color ? part.color : Colors.white60;
                    Widget segment = Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (part.ascii.isNotEmpty) ...[
                          if (prefs.style == PromptStyle.plain ||
                              part.icon == null)
                            Text(part.ascii, style: boxMonoStyle(color: tone))
                          else
                            Icon(part.icon, size: size, color: tone),
                          const SizedBox(width: 4),
                        ],
                        Flexible(
                          child: SearchResultText(
                            part.value,
                            matches: matches,
                            style: boxMonoStyle(color: tone),
                          ),
                        ),
                      ],
                    );
                    if (powerline) {
                      segment = ClipPath(
                        clipper: _PromptChevron(first: index == 0),
                        child: ColoredBox(
                          color: tone.withValues(alpha: .14),
                          child: Padding(
                            padding: EdgeInsets.fromLTRB(
                              index == 0 ? 6 : 12,
                              2,
                              12,
                              2,
                            ),
                            child: segment,
                          ),
                        ),
                      );
                    }
                    return segment;
                  },
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PromptChevron extends CustomClipper<Path> {
  const _PromptChevron({required this.first});
  final bool first;

  @override
  Path getClip(Size size) => Path()
    ..moveTo(0, 0)
    ..lineTo(size.width - 8, 0)
    ..lineTo(size.width, size.height / 2)
    ..lineTo(size.width - 8, size.height)
    ..lineTo(0, size.height)
    ..lineTo(first ? 0 : 8, size.height / 2)
    ..close();

  @override
  bool shouldReclip(_PromptChevron oldClipper) => first != oldClipper.first;
}
