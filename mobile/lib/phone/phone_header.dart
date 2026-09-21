import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';

/// The top of a phone page, drawn below the status bar and the Dynamic Island rather than into
/// them — the desktop chrome only ever had traffic lights to clear.
///
/// [large] is the first page's big title, the iOS way. Every other page gets a back chevron and
/// a compact title that can carry a [leading] mark and a quieter [subtitle] line.
///
/// On a page that can pop, the whole left band — chevron, [leading] mark, title and [subtitle] —
/// is the back target, not just the 24px chevron box. A 30px glyph at the very edge of the screen
/// is the hardest thing on the page to hit one-handed, and everything beside it names the page you
/// are leaving rather than doing anything of its own. [trailing] stays outside the band: those are
/// real controls, and swallowing their taps would be the worse bug.
class PhoneHeader extends StatelessWidget {
  const PhoneHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing = const [],
    this.large = false,
  });

  final String title;
  final Widget? subtitle;
  final Widget? leading;
  final List<Widget> trailing;
  final bool large;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final canPop = !large && Navigator.of(context).canPop();
    return Padding(
      padding: EdgeInsets.fromLTRB(
        canPop ? 6 : 20,
        large ? 14 : 6,
        14,
        large ? 16 : 10,
      ),
      child: Row(
        children: [
          Expanded(
            child: _BackBand(
              // The band only pops on a page that has somewhere to go back to; the first page's
              // large title is not a control at all.
              onTap: canPop ? () => Navigator.of(context).maybePop() : null,
              child: Row(
                children: [
                  if (canPop) ...[
                    // Still drawn as a button — it is what the user aims at, and it keeps its own
                    // hover ink on a pointer device. The band around it only widens the target.
                    AppIconButton(
                      icon: LucideIcons.chevronLeft300,
                      size: 30,
                      tooltip: 'Back',
                      color: AppPalette.textPrimary,
                      onPressed: () => Navigator.of(context).maybePop(),
                    ),
                    const SizedBox(width: 2),
                  ],
                  if (leading != null) ...[leading!, const SizedBox(width: 10)],
                  Expanded(
                    // ⚠️ Nudged down beside the back chevron. The title's line box reserves room
                    // under the baseline for descenders, so a centred box puts the LETTERS above
                    // the chevron's middle — visibly riding high on every page with a back button.
                    // Painted offset rather than padding, so the header's height does not change.
                    child: Transform.translate(
                      // 3.5, measured: at 1.5 the capitals still sat ~2pt above the chevron's
                      // centre on a Pixel 8 Pro.
                      offset: Offset(0, canPop && subtitle == null ? 3.5 : 0),
                      child: _Titles(
                        title: title,
                        subtitle: subtitle,
                        large: large,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          ...trailing,
        ],
      ),
    );
  }
}

/// The left band of the header, tappable as a whole when there is a page to pop.
///
/// [HitTestBehavior.opaque] is what makes the *gaps* count — the padding around the chevron, the
/// space beside a title shorter than the row. Without it a tap between the glyphs falls through to
/// the header's background and nothing happens, which is the bug the widened target exists to fix.
class _BackBand extends StatelessWidget {
  const _BackBand({required this.onTap, required this.child});

  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (onTap == null) return child;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      // The band is chrome, not a row you point at: no hover fill and no cursor change, so the
      // chevron inside it stays the thing that looks pressable.
      child: child,
    );
  }
}

class _Titles extends StatelessWidget {
  const _Titles({
    required this.title,
    required this.subtitle,
    required this.large,
  });

  final String title;
  final Widget? subtitle;
  final bool large;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: AppPalette.textPrimary,
          fontSize: large ? 32 : 17,
          fontWeight: large ? FontWeight.w700 : FontWeight.w600,
          letterSpacing: large ? -0.6 : -0.2,
        ),
      ),
      if (subtitle != null)
        Padding(
          padding: EdgeInsets.only(top: large ? 4 : 2),
          child: subtitle,
        ),
    ],
  );
}
