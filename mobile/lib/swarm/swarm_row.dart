import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_style.dart';
import 'swarm_unread.dart';

/// One row of a Swarm card ([SwarmGroup]), as the approved prototype draws
/// it: maybe a mark at its left (an avatar, a project's tile, a need's
/// glyph), its title — after a work number in the terminal's face — and a
/// line under it, then at its right what it holds or a chevron. Never under
/// 56 points. Something new in it ([news]) sets its title in bold, with no
/// dot, and the tags waiting in it as `@N` before its right edge (desktop
/// design system: Unread, Mentions).
class SwarmRow extends StatelessWidget {
  const SwarmRow({
    super.key,
    this.leading,
    required this.title,
    this.number,
    this.detail,
    this.trailing,
    this.chevron = LucideIcons.chevronRight300,
    this.news = swarmNoNews,
    required this.onTap,
  });

  final Widget? leading;
  final String title;

  /// A work's number, "#4", before its title.
  final String? number;

  /// The line under the title: words ([line]) or a team line.
  final Widget? detail;

  /// What the row holds at its right, in place of the chevron.
  final Widget? trailing;

  /// The chevron of a row that opens something; null draws none.
  final IconData? chevron;

  /// What is new in it: unread or tagged ([swarmChatNews]).
  final SwarmRowNews news;
  final VoidCallback? onTap;

  /// Every row clears this, for a thumb.
  static const double height = 56;

  /// A row's line under its title, in the secondary ink.
  static Widget line(String text, {Key? key, int lines = 1, Color? color}) =>
      Text(
        text,
        key: key,
        maxLines: lines,
        overflow: TextOverflow.ellipsis,
        style: AppType.caption(
          color: color ?? AppPalette.textSecondary,
          height: 1.35,
        ),
      );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final end =
        trailing ??
        (onTap == null || chevron == null
            ? null
            : Icon(chevron, size: 18, color: AppPalette.textFaint));
    final row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: height),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpace.l,
          vertical: AppSpace.m,
        ),
        child: Row(
          children: [
            if (leading case final leading?) ...[
              leading,
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Unread is heard in words, as the bold is seen; tags
                  // say their own.
                  Semantics(
                    label: news.bold && news.tags == 0
                        ? 'Unread messages'
                        : null,
                    child: Text.rich(
                      TextSpan(
                        children: [
                          if (number case final number?)
                            TextSpan(
                              text: '$number ',
                              style: tty.style(
                                size: 13.5,
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          TextSpan(text: title),
                        ],
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.label(
                        color: AppPalette.textPrimary,
                        height: 1.3,
                        fontWeight: news.bold ? AppFont.semibold : null,
                      ),
                    ),
                  ),
                  if (detail case final detail?) ...[
                    const SizedBox(height: 3),
                    detail,
                  ],
                ],
              ),
            ),
            if (news.tags > 0) ...[
              const SizedBox(width: 12),
              SwarmTags(news.tags),
            ],
            if (end != null) ...[const SizedBox(width: 12), end],
          ],
        ),
      ),
    );
    if (onTap == null) return row;
    return Material(
      color: Colors.transparent,
      child: InkWell(onTap: onTap, child: row),
    );
  }
}
