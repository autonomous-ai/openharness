import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

bool _recordingGap(SuperTabMessage message) =>
    message.fromTerminal &&
    message.source['phase'] == 'gap' &&
    message.replyTo == null &&
    message.deliveries.isEmpty;

/// Only coalesce identical, adjacent recording diagnostics from the same session.
/// Ordinary posts, source messages and their IDs remain untouched.
List<({SuperTabMessage message, int interruptions})> superTabTranscriptEntries(
  List<SuperTabMessage> messages,
) {
  final entries = <({SuperTabMessage message, int interruptions})>[];
  for (final message in messages) {
    final previous = entries.lastOrNull;
    final first = previous?.message;
    if (_recordingGap(message) &&
        previous != null &&
        previous.interruptions > 0 &&
        first!.authorId == message.authorId &&
        first.author['kind'] == message.author['kind'] &&
        first.conversationId == message.conversationId &&
        first.author['membershipGeneration'] ==
            message.author['membershipGeneration'] &&
        first.authorName == message.authorName &&
        first.text == message.text &&
        first.createdAt != null &&
        message.createdAt != null &&
        DateUtils.isSameDay(
          first.createdAt!.toLocal(),
          message.createdAt!.toLocal(),
        ) &&
        !message.createdAt!.difference(first.createdAt!).isNegative &&
        message.createdAt!.difference(first.createdAt!) <=
            const Duration(minutes: 5)) {
      entries[entries.length - 1] = (
        message: first,
        interruptions: previous.interruptions + 1,
      );
    } else {
      entries.add((
        message: message,
        interruptions: _recordingGap(message) ? 1 : 0,
      ));
    }
  }
  return entries;
}

class SuperTabRecordingNotice extends StatelessWidget {
  const SuperTabRecordingNotice({
    super.key,
    required this.author,
    required this.count,
    this.onOpenTerminal,
  });

  final String author;
  final int count;
  final VoidCallback? onOpenTerminal;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 5),
          child: Icon(AppIcons.terminal, size: 16, color: DesktopChrome.muted),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Tooltip(
            message:
                'Some terminal activity could not be recorded. '
                'Open the terminal for the full conversation.',
            child: Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 6,
              children: [
                Text(
                  '$author’s terminal recording was interrupted'
                  '${count > 1 ? ' $count times' : ''}.',
                  style: DesktopChrome.metadata(),
                ),
                if (onOpenTerminal != null)
                  TextButton(
                    onPressed: onOpenTerminal,
                    style: TextButton.styleFrom(
                      foregroundColor: DesktopChrome.accent,
                      backgroundColor: Colors.transparent,
                      side: BorderSide.none,
                      minimumSize: const Size(0, 28),
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      textStyle: DesktopChrome.metadata(),
                    ),
                    child: const Text('Open terminal'),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}
