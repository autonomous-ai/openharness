import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'buddy_chat.dart';
import 'identity.dart';
import 'section_heading.dart';

/// A sidebar count, such as the tags waiting in Notifications.
class SuperTabCountBadge extends StatelessWidget {
  const SuperTabCountBadge(this.count, {super.key});
  final int count;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 18),
    padding: const EdgeInsets.symmetric(horizontal: grid.AppDesktop.badgeInset),
    decoration: ShapeDecoration(
      color: grid.AppPalette.warn.withValues(alpha: .16),
      shape: const StadiumBorder(),
    ),
    child: Text(
      countText(count),
      textAlign: TextAlign.center,
      style: DesktopChrome.metadata(color: grid.AppPalette.warn),
    ),
  );
}

/// A person's Buddy chat in a project, in the sidebar's Buddies: its Buddy's
/// avatar and name ("Buddy" while none runs), with the project in brackets
/// after it when the Swarm has several: "Wren (web-2)". New lines, the PM's
/// private ones among them, show as the name in bold, with no count (design
/// system: Unread).
class SuperTabBuddyRow extends StatelessWidget {
  const SuperTabBuddyRow({
    super.key,
    required this.agentId,
    required this.name,
    required this.tooltip,
    required this.onTap,
    this.project,
    this.selected = false,
    this.unread = false,
    this.note,
    this.detail,
    this.status,
  });

  /// The Buddy, for its avatar; null while none runs.
  final String? agentId;
  final String name;

  /// The project's name, shown when the Swarm has several.
  final String? project;
  final bool selected, unread;
  final VoidCallback? onTap;

  /// What hovering says: "Your Buddy · openharness".
  final String tooltip;

  /// A quiet word after the name, such as a Buddy's "offline".
  final String? note;

  /// A line under the name, such as where a Buddy runs, with [status], its
  /// activity mark, before it.
  final String? detail;
  final Widget? status;

  static const _column = SuperTabSectionHeading.actionWidth;

  @override
  Widget build(BuildContext context) {
    final color = onTap == null
        ? DesktopChrome.muted
        : DesktopChrome.foreground;
    return Padding(
      padding: const EdgeInsets.only(bottom: grid.AppDesktop.listRowGap),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: Semantics(
          button: true,
          selected: selected,
          child: InkWell(
            onTap: onTap,
            hoverColor: grid.AppSurface.hoverFill,
            focusColor: grid.AppSurface.hoverFill,
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            child: Tooltip(
              message: tooltip,
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                  SizedBox(
                    width: _column,
                    child: Center(
                      child: SuperTabAvatar(
                        identity: agentId == null
                            ? 'buddy:$name'
                            : 'agent:$agentId',
                        name: name,
                        size: 20,
                      ),
                    ),
                  ),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 36),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: grid.AppDesktop.controlGap,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    // Unread is the name in bold, no dot (Dee, 2026-10-29).
                                    style:
                                        DesktopChrome.control(
                                          medium: selected,
                                          color: color,
                                        ).copyWith(
                                          fontWeight: unread
                                              ? grid.AppFont.semibold
                                              : null,
                                        ),
                                  ),
                                ),
                                if (project case final project?) ...[
                                  const SizedBox(width: 8),
                                  Flexible(
                                    child: Text(
                                      '($project)',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                ],
                                // A quiet note yields first at large text sizes.
                                if (note case final note?) ...[
                                  const SizedBox(width: 8),
                                  Flexible(
                                    child: Text(
                                      note,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            if (detail case final detail?)
                              Row(
                                children: [
                                  if (status case final status?) ...[
                                    status,
                                    const SizedBox(width: 6),
                                  ],
                                  Flexible(
                                    child: Text(
                                      detail,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                ],
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: _column,
                    // Unread is drawn as a bold name and heard in words.
                    child: Semantics(label: unread ? 'Unread messages' : null),
                  ),
                  const SizedBox(width: _column),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
