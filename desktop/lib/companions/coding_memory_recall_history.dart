import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart';
import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';
import 'coding_memory_library.dart';

/// Feedback belongs to this version in one receiving session, not to its truth.
class CodingMemoryRecallHistory extends StatefulWidget {
  const CodingMemoryRecallHistory({
    super.key,
    required this.recalls,
    required this.busy,
    required this.onFeedback,
    required this.onRefresh,
  });
  final List<Map<String, dynamic>> recalls;
  final bool busy;
  final Future<void> Function(Map<String, dynamic> recall, String? value)
  onFeedback;
  final VoidCallback onRefresh;

  @override
  State<CodingMemoryRecallHistory> createState() =>
      _CodingMemoryRecallHistoryState();
}

class _CodingMemoryRecallHistoryState extends State<CodingMemoryRecallHistory> {
  bool expanded = false;
  final _focus = <String, FocusNode>{};

  FocusNode _node(Map<String, dynamic> recall, String choice) =>
      _focus.putIfAbsent('${recall['receiptId']}:$choice', () => FocusNode());

  Future<void> _rate(Map<String, dynamic> recall, String? value) async {
    await widget.onFeedback(recall, value);
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          widget.recalls.any((r) => r['receiptId'] == recall['receiptId'])) {
        _node(recall, value ?? 'helpful').requestFocus();
      }
    });
  }

  @override
  void didUpdateWidget(CodingMemoryRecallHistory oldWidget) {
    super.didUpdateWidget(oldWidget);
    final current = widget.recalls.map((r) => '${r['receiptId']}:').toSet();
    for (final key in _focus.keys.toList()) {
      if (!current.any(key.startsWith)) _focus.remove(key)!.dispose();
    }
  }

  @override
  void dispose() {
    for (final node in _focus.values) {
      node.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Recent recall',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      const SizedBox(height: 8),
      Text(
        widget.recalls.isEmpty
            ? 'No recent recall history is available for this version.'
            : widget.recalls.any((recall) => recall['canGuideRecall'] == true)
            ? 'Was this useful in that session? Feedback helps choose memories for matching work. Correct the memory separately if the fact is wrong.'
            : 'Was this useful in that session? Your feedback stays with this version. Correct the memory separately if the fact is wrong.',
        style: AppType.caption(color: AppPalette.textSecondary, height: 1.5),
      ),
      for (final recall in widget.recalls.take(expanded ? 10 : 3))
        _recall(context, recall),
      Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [
          if (widget.recalls.length > 3)
            TextButton(
              onPressed: widget.busy
                  ? null
                  : () => setState(() => expanded = !expanded),
              child: Text(expanded ? 'Show fewer' : 'Show all recent recalls'),
            ),
          TextButton(
            onPressed: widget.busy ? null : widget.onRefresh,
            child: const Text('Refresh recent recall'),
          ),
        ],
      ),
      if (widget.recalls.isNotEmpty)
        Text(
          'Up to 10 recent recalls from the last 30 days. Repeats in the same session and task context share one rating.',
          style: AppType.caption(color: AppPalette.textSecondary, height: 1.5),
        ),
    ],
  );

  Widget _recall(BuildContext context, Map<String, dynamic> recall) {
    final feedback = memoryMap(recall['feedback']);
    final value = feedback['value'];
    final project = memoryMap(recall['project']);
    final engine = switch (recall['engine']) {
      'claude' => 'Claude',
      'opencode' => 'OpenCode',
      _ => 'Codex',
    };
    final where = project['name'] as String? ?? 'Companion conversation';
    final millis = recall['preparedAt'];
    final date = millis is num
        ? DateTime.fromMillisecondsSinceEpoch(millis.toInt()).toLocal()
        : null;
    final local = MaterialLocalizations.of(context);
    final when = date == null
        ? 'Date unavailable'
        : '${local.formatMediumDate(date)} at ${local.formatTimeOfDay(TimeOfDay.fromDateTime(date), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
    final description = '$engine · $where · $when';
    final enabled = !widget.busy && recall['canFeedback'] == true;
    return Padding(
      key: ValueKey(recall['receiptId']),
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$engine · $where',
            style: AppType.body(
              color: AppPalette.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          Text(
            when,
            style: AppType.caption(
              color: AppPalette.textSecondary,
              height: 1.5,
            ),
          ),
          if (project['location'] is String)
            Text(
              project['location'] as String,
              style: AppType.caption(
                color: AppPalette.textSecondary,
                height: 1.5,
              ),
            ),
          Text(
            recall['emittedAt'] == null
                ? 'Selected for recall · Delivery not confirmed'
                : 'Sent by Harness · Delivery not confirmed',
            style: AppType.caption(
              color: AppPalette.textSecondary,
              height: 1.5,
            ),
          ),
          if (recall['canGuideRecall'] == true)
            Text(
              'Guides recall for this version in the same project and matching conditions. Clear feedback to remove its effect.',
              style: AppType.caption(
                color: AppPalette.textSecondary,
                height: 1.5,
              ),
            )
          else if (recall['canGuideRecall'] == false && value != null)
            Text(
              'Saved in history. This earlier rating does not affect future recall.',
              style: AppType.caption(
                color: AppPalette.textSecondary,
                height: 1.5,
              ),
            ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final choice in ['helpful', 'unhelpful'])
                DesktopPill(
                  label: choice == 'helpful' ? 'Helpful' : 'Not helpful',
                  semanticLabel:
                      '${choice == 'helpful' ? 'Helpful' : 'Not helpful'} for $description',
                  selected: value == choice,
                  focusNode: _node(recall, choice),
                  leading: SizedBox(
                    width: 16,
                    child: value == choice
                        ? const Icon(AppIcons.check, size: 16)
                        : null,
                  ),
                  onPressed: enabled
                      ? () async {
                          if (value != choice) await _rate(recall, choice);
                        }
                      : null,
                ),
              if (value != null)
                TextButton(
                  focusNode: _node(recall, 'clear'),
                  onPressed: enabled ? () => _rate(recall, null) : null,
                  child: const Text('Clear feedback'),
                ),
            ],
          ),
          if (!widget.busy && recall['canFeedback'] != true)
            Text(
              'Feedback is unavailable for this memory’s current state.',
              style: AppType.caption(
                color: AppPalette.textSecondary,
                height: 1.5,
              ),
            ),
        ],
      ),
    );
  }
}
