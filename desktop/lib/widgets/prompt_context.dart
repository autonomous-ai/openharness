import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/rendering.dart' show OverflowBoxFit;
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/prompt_style.dart';
import '../terminal/terminal_text.dart';
import 'search_result_text.dart';

/// The same compact identity line in the picker, pane header and live preview.
/// Symbols use our bundled icon font; Powerline separators are drawn shapes.
/// Changing the terminal font therefore never requires a patched Nerd Font.
class PromptContextView extends StatefulWidget {
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
  double get size => grid.AppType.monoLabelSize;
  final Iterable<SearchFieldMatch> matches;

  @override
  State<PromptContextView> createState() => _PromptContextViewState();
}

class _PromptContextViewState extends State<PromptContextView> {
  PromptContext get contextData => widget.contextData;
  PromptPrefs? get prefs => widget.prefs;
  AppearancePrefsStore? get store => widget.store;
  Iterable<SearchFieldMatch> get matches => widget.matches;
  double get size => widget.size;

  Object? _lineKey;
  List<SearchFieldMatch> _lineMatches = const [];
  Widget? _lineWidget;

  Widget _cachedLine(PromptPrefs prefs, double width, TextScaler scaler) {
    final key = (
      contextData,
      prefs,
      width,
      scaler,
      _style(Colors.white),
      size,
      grid.AppPalette.swarmAccent,
      grid.AppPalette.teal,
      grid.AppPalette.online,
    );
    final nextMatches = matches.toList(growable: false);
    if (_lineKey == key && listEquals(_lineMatches, nextMatches)) {
      return _lineWidget!;
    }
    _lineKey = key;
    _lineMatches = nextMatches;
    // Most searches match the title. Keep the breadcrumb's render tree intact
    // while typing or moving its highlight, until its own content changes.
    return _lineWidget = _line(prefs, width, scaler);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        store ?? appearancePrefsStore,
        terminalFontStore,
      ]),
      builder: (context, _) => LayoutBuilder(
        builder: (context, constraints) => _cachedLine(
          prefs ?? (store ?? appearancePrefsStore).value.prompt,
          constraints.maxWidth,
          MediaQuery.textScalerOf(context),
        ),
      ),
    );
  }

  /// Breadcrumbs name places a person copies, so they are mono, one step
  /// under the terminal's own text.
  static TextStyle _style(Color tone) => grid.AppType.monoLabel(
    color: tone,
    fontWeight: FontWeight.w400,
    height: 1.35,
  );

  Widget _line(PromptPrefs prefs, double maxWidth, TextScaler scaler) {
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
    final widths = _fit(segments, prefs, maxWidth, scaler);
    return Semantics(
      label: segments
          .map(
            (part) =>
                '${part.label.isEmpty ? '' : '${part.label}: '}${part.value}',
          )
          .join(', '),
      child: ExcludeSemantics(
        child: _Clipped(
          clip: widths != null,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var index = 0; index < segments.length; index++) ...[
                if (index > 0 && !powerline) const SizedBox(width: 12),
                _Sized(
                  fixed: widths != null,
                  child: Builder(
                    builder: (context) {
                      final part = segments[index];
                      final tone = prefs.color ? part.color : Colors.white60;
                      final width = widths?[index];
                      final style = _style(tone);
                      // A folder cut short keeps both ends, the way editors
                      // shorten paths; a branch keeps its start.
                      final shown =
                          width != null &&
                              matches.isEmpty &&
                              _middle(part.label) &&
                              _measure(part.value, style, scaler) > width
                          ? _middleEllipsis(part.value, width, style, scaler)
                          : part.value;
                      final text = SearchResultText(
                        shown,
                        matches: matches,
                        style: style,
                      );
                      Widget segment = Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (part.ascii.isNotEmpty) ...[
                            if (prefs.style == PromptStyle.plain ||
                                part.icon == null)
                              Text(part.ascii, style: _style(tone))
                            else
                              Icon(part.icon, size: size, color: tone),
                            const SizedBox(width: 4),
                          ],
                          if (width != null)
                            SizedBox(width: width, child: text)
                          else
                            Flexible(child: text),
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
      ),
    );
  }

  /// Folders shorten in the middle; everything else at the end.
  static bool _middle(String label) => label == 'Project' || label.isEmpty;

  /// How much of the line each segment's text gets when it does not all fit:
  /// the project gives way first, then the machine, and the branch last, each keeping a few characters; narrower than that, all
  /// alike. Null when everything fits.
  List<double>? _fit(
    List<
      ({String label, String value, String ascii, IconData? icon, Color color})
    >
    segments,
    PromptPrefs prefs,
    double maxWidth,
    TextScaler scaler,
  ) {
    if (!maxWidth.isFinite) return null;
    final powerline = prefs.style == PromptStyle.powerline;
    final style = _style(Colors.white);
    final natural = [
      for (final part in segments) _measure(part.value, style, scaler) + 1,
    ];
    var chrome = 0.0;
    for (var index = 0; index < segments.length; index++) {
      final part = segments[index];
      if (part.ascii.isNotEmpty) {
        chrome +=
            (prefs.style == PromptStyle.plain || part.icon == null
                ? _measure(part.ascii, style, scaler)
                : size) +
            4;
      }
      chrome += powerline ? (index == 0 ? 6 : 12) + 12 : (index > 0 ? 12 : 0);
    }
    var excess = natural.fold(chrome, (sum, width) => sum + width) - maxWidth;
    if (excess <= 0) return null;
    final widths = [...natural];
    final floor = _measure('mmmmmm…', style, scaler);
    const order = ['', 'Project', 'Machine', 'Branch', 'Harness'];
    // To a few characters each, in that order.
    for (final label in order) {
      for (var index = 0; index < segments.length && excess > 0; index++) {
        if (segments[index].label != label) continue;
        final cut = (widths[index] - floor).clamp(0.0, excess);
        widths[index] -= cut;
        excess -= cut;
      }
    }
    // Narrower still, all of them alike.
    final text = widths.fold(0.0, (sum, width) => sum + width);
    final scale = excess <= 0 || text <= 0
        ? 1.0
        : ((text - excess) / text).clamp(0.0, 1.0);
    return [for (final width in widths) (width * scale).floorToDouble()];
  }

  static final _widths = <(String, TextStyle, TextScaler), double>{};
  static double _measure(String text, TextStyle style, TextScaler scaler) {
    final key = (text, style, scaler);
    final known = _widths[key];
    if (known != null) return known;
    if (_widths.length > 512) _widths.clear();
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
      textScaler: scaler,
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return _widths[key] = width;
  }

  /// `claude-2026-…-uYONBE`: as much of both ends as fits in [width].
  static String _middleEllipsis(
    String text,
    double width,
    TextStyle style,
    TextScaler scaler,
  ) {
    String cut(int keep) => keep >= text.length
        ? text
        : '${text.substring(0, (keep + 1) ~/ 2)}…'
              '${text.substring(text.length - keep ~/ 2)}';
    var low = 0, high = text.length;
    while (low < high) {
      final mid = (low + high + 1) ~/ 2;
      if (_measure(cut(mid), style, scaler) <= width) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return cut(low);
  }
}

/// A line narrower than even its icons: laid out whole and clipped, rather
/// than overflowing.
class _Clipped extends StatelessWidget {
  const _Clipped({required this.clip, required this.child});

  /// Only with every segment at a fixed width; a line that fits is laid out
  /// as it always was.
  final bool clip;
  final Widget child;
  @override
  Widget build(BuildContext context) => clip
      ? ClipRect(
          child: OverflowBox(
            fit: OverflowBoxFit.deferToChild,
            alignment: Alignment.centerLeft,
            minWidth: 0,
            maxWidth: double.infinity,
            child: child,
          ),
        )
      : child;
}

/// A segment at the width [PromptContextView._fit] gave it, or sharing the
/// line's width with the others when it did not give one.
class _Sized extends StatelessWidget {
  const _Sized({required this.fixed, required this.child});
  final bool fixed;
  final Widget child;
  @override
  Widget build(BuildContext context) => fixed ? child : Flexible(child: child);
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
