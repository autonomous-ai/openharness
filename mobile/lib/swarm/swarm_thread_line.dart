import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_face.dart';
import 'swarm_message_row.dart';

/// How long ago: "just now", "4s ago", "3 min ago", "2 h ago", "5 d ago" —
/// the desktop's `superTabAgo`, word for word.
String swarmAgo(Duration age) {
  final seconds = age.inSeconds;
  if (seconds < 1) return 'just now';
  if (seconds < 60) return '${seconds}s ago';
  if (age.inMinutes < 60) return '${age.inMinutes} min ago';
  if (age.inHours < 24) return '${age.inHours} h ago';
  return '${age.inDays} d ago';
}

/// One who replied in a thread, as the chat draws its authors.
typedef SwarmThreadFace = ({
  String name,
  String id,
  bool agent,
  bool pm,
  SwarmLook look,
});

/// The newest reply authors of [thread] as [snapshot] names and dresses them:
/// an agent by the Swarm's name for it, a person by their address's first
/// part, as the chat names a message's author. The project's coordinator
/// wears manager blue here as on its own messages, whatever its role is
/// called.
List<SwarmThreadFace> swarmThreadFaces(
  SuperTabSnapshot? snapshot,
  SuperTabThread thread,
) => [
  for (final author in thread.authors)
    if (author['id'] case final String id)
      author['kind'] == 'agent'
          ? (
              name:
                  snapshot?.agentName(
                    id,
                    fallback:
                        (author['displayName'] ?? author['name'] ?? 'Agent')
                            as String,
                  ) ??
                  (author['displayName'] ?? author['name'] ?? 'Agent')
                      as String,
              id: id,
              agent: true,
              pm: snapshot?.isLead(id) ?? false,
              look: snapshot?.agentLook(id) ?? (picture: null, status: null),
            )
          : (
              name: superTabPersonName(author['name'] as String? ?? ''),
              id: id,
              agent: false,
              pm: false,
              look: snapshot?.personLook(id) ?? (picture: null, status: null),
            ),
];

/// The line under a thread's root: who replied, how many replies, and when
/// the last came (the desktop's `SuperTabThreadLine`). A tap opens the
/// thread.
class SwarmThreadLine extends StatelessWidget {
  const SwarmThreadLine({
    super.key,
    required this.thread,
    required this.faces,
    required this.onOpen,
  });

  final SuperTabThread thread;
  final List<SwarmThreadFace> faces;
  final VoidCallback onOpen;

  /// The faces' width, a third of the chat's avatar.
  static const double face = 20;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final count = thread.replies == 1 ? '1 reply' : '${thread.replies} replies';
    final last = thread.lastAt;
    final ago = last == null
        ? null
        : 'Last reply ${swarmAgo(DateTime.now().difference(last))}';
    return Semantics(
      button: true,
      label: ago == null ? count : '$count, $ago',
      hint: 'Open thread',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: ConstrainedBox(
          // A thumb's height, though the line is shorter.
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(
            children: [
              for (final who in faces) ...[
                SwarmChatAvatar(
                  name: who.name,
                  id: who.id,
                  agent: who.agent,
                  pm: who.pm,
                  picture: who.look.picture,
                  status: who.look.status,
                  diameter: face,
                ),
                const SizedBox(width: AppSpace.xs),
              ],
              Text(
                count,
                key: ValueKey('swarm-thread-count-${thread.id}'),
                style: swarmChatText(
                  14,
                  color: AppPalette.accentOnSurface,
                  weight: FontWeight.w600,
                ),
              ),
              if (ago != null) ...[
                const SizedBox(width: AppSpace.s),
                Flexible(
                  child: Text(
                    ago,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: swarmChatText(13, color: AppPalette.textFaint),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Over a reply also sent to the chat: where it was written, a tap away
/// (the desktop's "Replied in thread").
class SwarmRepliedInThread extends StatelessWidget {
  const SwarmRepliedInThread({super.key, required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Replied in thread, open thread',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
          child: Text(
            'Replied in thread',
            style: tty.style(color: AppPalette.textFaint, size: 12.5),
          ),
        ),
      ),
    );
  }
}
