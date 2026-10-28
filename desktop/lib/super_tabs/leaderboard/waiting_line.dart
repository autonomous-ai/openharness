import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';
import 'model.dart';

/// "Agents waiting on a person now": who and how many, in name order, never a
/// ranking or blame. Answer goes straight to the viewer's own waiting item, or
/// to the first one when none waits on them.
class LeaderboardWaitingLine extends StatelessWidget {
  const LeaderboardWaitingLine({
    super.key,
    required this.waiting,
    required this.viewerId,
    required this.nameOf,
    required this.onAnswer,
  });
  final SuperTabWaiting waiting;
  final String viewerId;
  final String Function(String personId) nameOf;
  final ValueChanged<String> onAnswer;

  String? get _target {
    final own = waiting.people.where((p) => p.personId == viewerId).firstOrNull;
    return (own ?? waiting.people.firstOrNull)?.conversationIds.firstOrNull;
  }

  @override
  Widget build(BuildContext context) {
    final target = _target;
    // The team total's quiet hierarchy and inset.
    return Padding(
      key: const ValueKey('leaderboard-waiting'),
      padding: const EdgeInsets.fromLTRB(
        DesktopChrome.groupGap,
        DesktopChrome.controlGap,
        DesktopChrome.controlGap,
        DesktopChrome.controlGap,
      ),
      child: waiting.total == 0
          ? Text(
              'No agent is waiting on a person.',
              style: DesktopChrome.metadata(),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // The whole width, so the count never wraps beside Answer.
                Text(
                  'Agents waiting on a person now: ${waiting.total}',
                  style: DesktopChrome.metadata(),
                ),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        waiting.people
                            .map((p) => '${nameOf(p.personId)} ${p.count}')
                            .join(' · '),
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                    if (target != null)
                      TextButton(
                        onPressed: () => onAnswer(target),
                        child: const Text('Answer'),
                      ),
                  ],
                ),
              ],
            ),
    );
  }
}
