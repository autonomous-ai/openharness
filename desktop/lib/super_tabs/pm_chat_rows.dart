import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'identity.dart';
import 'pm_chat.dart';
import 'section_heading.dart';

/// A sidebar count, such as the tags waiting in Notifications.
class SuperTabCountBadge extends StatelessWidget {
  const SuperTabCountBadge(this.count, {super.key});
  final int count;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 18),
    padding: const EdgeInsets.symmetric(horizontal: 5),
    decoration: BoxDecoration(
      color: grid.AppPalette.warn.withValues(alpha: .16),
      borderRadius: BorderRadius.circular(9),
    ),
    child: Text(
      countText(count),
      textAlign: TextAlign.center,
      style: DesktopChrome.metadata(color: grid.AppPalette.warn),
    ),
  );
}

/// A PM chat's unread count, "2 new in Chat with PM"; [onTap] opens the chat.
class SuperTabPmUnread extends StatelessWidget {
  const SuperTabPmUnread(this.count, {super.key, this.onTap});
  final int count;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: pmUnreadLabel(count),
    child: Semantics(
      button: onTap != null,
      label: pmUnreadLabel(count),
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: SuperTabCountBadge(count),
      ),
    ),
  );
}

/// A person's Chat with PM as a direct message: the Product Manager's avatar
/// and name, like a chat app's direct messages, with the project in brackets
/// after it when the Swarm has several: "Finn (web-2)".
class SuperTabPmChatRow extends StatelessWidget {
  const SuperTabPmChatRow({
    super.key,
    required this.agentId,
    required this.name,
    required this.onTap,
    this.project,
    this.selected = false,
    this.unread = false,
    this.unreadCount = 0,
  });

  /// The Product Manager's agent, for its avatar; null while it has none.
  final String? agentId;
  final String name;

  /// The project's name, shown when the Swarm has several.
  final String? project;
  final bool selected, unread;
  final int unreadCount;
  final VoidCallback? onTap;

  static const _column = SuperTabSectionHeading.actionWidth;
  static const _dotSize = 6.0;

  @override
  Widget build(BuildContext context) {
    final strong = selected || unread;
    final color = onTap == null
        ? DesktopChrome.muted
        : DesktopChrome.foreground;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
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
              message: project == null
                  ? kChatWithPm
                  : '$kChatWithPm · $project',
              child: Row(
                children: [
                  SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                  SizedBox(
                    width: _column,
                    child: Center(
                      child: SuperTabAvatar(
                        identity: agentId == null
                            ? 'pm:$name'
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
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            Flexible(
                              child: Text(
                                name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.control(
                                  medium: strong,
                                  color: color,
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
                          ],
                        ),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: _column,
                    child: Center(
                      child: unreadCount > 0
                          ? SuperTabPmUnread(unreadCount)
                          : unread
                          ? Semantics(
                              label: 'Unread messages',
                              child: Container(
                                width: _dotSize,
                                height: _dotSize,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: DesktopChrome.accent,
                                ),
                              ),
                            )
                          : null,
                    ),
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
