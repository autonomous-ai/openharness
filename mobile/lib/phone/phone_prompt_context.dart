import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import 'search_result_text.dart';

/// What goes in front of the harness on the identity line. The desktop's
/// `kHarnessPromptMarker`.
const kHarnessPromptMarker = '>_';

/// The terminal's own typeface, for the text that names a terminal.
///
/// The desktop's `boxMonoStyle`. The picker's rows are set in it there, and that
/// is not decoration: an agent's name is as often an id as a sentence
/// (`codex-2026-09-21-16-49`), and a proportional face makes two of those hard
/// to tell apart at a glance. Reads off [terminalFontStore], so changing the
/// terminal font changes these rows with it.
TextStyle phoneBoxMonoStyle({
  double size = 13,
  Color? color,
  FontWeight? weight,
}) => TextStyle(
  fontFamily: terminalFontStore.value.fontFamily,
  fontFamilyFallback: terminalFontStore.value.fontFamilyFallback,
  fontSize: size,
  height: 1.35,
  color: color ?? AppPalette.textPrimary,
  fontWeight: weight ?? FontWeight.w400,
);

/// Identity supplied by the catalog, never inferred by parsing display text.
@immutable
class PhonePromptContext {
  const PhonePromptContext({
    this.harness,
    this.machine,
    this.project,
    this.branch,
    this.leading,
  });

  final String? harness, machine, project, branch, leading;
}

/// The compact identity line under a result's name: what engine, on what
/// machine, in what folder, on what branch.
///
/// A port of the desktop's `PromptContextView`, which is what its picker
/// actually draws — and the reason the two lists did not look alike even once
/// they held the same words. The desktop does not write
/// `Codex · work · harness-remote-box`; it draws four segments, each with its
/// own glyph and its own colour, so the eye can find "which machine" without
/// reading the line.
///
/// ⚠️ **The symbols are icons, not glyphs from a patched font.** The desktop's
/// comment on this is worth keeping: drawing them means changing the terminal
/// font never requires a Nerd Font.
///
/// What is dropped in the port: the desktop's `PromptPrefs`, which let somebody
/// turn the machine, project or branch off and pick plain/powerline. The phone
/// has no screen to set that on, so all three are always drawn, always with
/// their glyph.
class PhonePromptContextView extends StatelessWidget {
  const PhonePromptContextView({
    super.key,
    required this.contextData,
    this.size = 12,
    this.matches = const [],
  });

  final PhonePromptContext contextData;
  final double size;
  final Iterable<PhoneFieldMatch> matches;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => _line(context),
    );
  }

  Widget _line(BuildContext context) {
    final data = contextData;
    final faint = AppPalette.textSecondary;
    final segments =
        <({String label, String value, String ascii, IconData? icon, Color color})>[
          if (data.harness?.isNotEmpty == true)
            (
              label: 'Harness',
              value: data.harness!,
              ascii: kHarnessPromptMarker,
              icon: null,
              color: faint,
            ),
          if (data.leading?.isNotEmpty == true)
            (
              label: '',
              value: data.leading!,
              ascii: '',
              icon: null,
              color: faint,
            ),
          if (data.machine?.isNotEmpty == true)
            (
              label: 'Machine',
              value: data.machine!,
              ascii: '@',
              icon: LucideIcons.monitor300,
              color: AppPalette.swarmAccent,
            ),
          if (data.project?.isNotEmpty == true)
            (
              label: 'Project',
              value: data.project!,
              ascii: '/',
              icon: LucideIcons.folder300,
              color: AppPalette.teal,
            ),
          if (data.branch?.isNotEmpty == true)
            (
              label: 'Branch',
              value: data.branch!,
              ascii: 'git:',
              icon: LucideIcons.gitBranch300,
              color: AppPalette.online,
            ),
        ];
    if (segments.isEmpty) return const SizedBox.shrink();
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
              if (index > 0) const SizedBox(width: 10),
              // Each segment truncates inside its own share rather than the
              // line ellipsing from the right — otherwise the machine, which is
              // last and is the whole reason the line exists on a list that
              // mixes machines, is the one part that always disappears.
              Flexible(child: _Segment(part: segments[index], size: size, matches: matches)),
            ],
          ],
        ),
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  const _Segment({
    required this.part,
    required this.size,
    required this.matches,
  });

  final ({String label, String value, String ascii, IconData? icon, Color color})
  part;
  final double size;
  final Iterable<PhoneFieldMatch> matches;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (part.ascii.isNotEmpty) ...[
        if (part.icon == null)
          Text(
            part.ascii,
            style: phoneBoxMonoStyle(size: size, color: part.color),
          )
        else
          Icon(part.icon, size: size, color: part.color),
        const SizedBox(width: 4),
      ],
      Flexible(
        child: SearchResultText(
          part.value,
          matches: matches,
          style: phoneBoxMonoStyle(size: size, color: part.color),
        ),
      ),
    ],
  );
}
