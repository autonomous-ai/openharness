import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'decisions.dart';
import 'hands_on.dart';

/// One hands-on request: what to do, its numbered steps, what the agent does
/// next, and the three answers. Answered, it shows the answer instead.
class SuperTabHandsOnCard extends StatelessWidget {
  const SuperTabHandsOnCard({
    super.key,
    required this.decisions,
    required this.request,
  });
  final SuperTabDecisions decisions;
  final SuperTabHandsOn request;

  @override
  Widget build(BuildContext context) => Container(
    key: ValueKey('super-hands-on-${request.id}'),
    margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
    decoration: BoxDecoration(
      color: DesktopChrome.surface,
      border: Border.all(color: DesktopChrome.rim),
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(request.request, style: DesktopChrome.control(medium: true)),
        const SizedBox(height: 4),
        for (final (index, step) in request.steps.indexed)
          Text('${index + 1}. $step', style: DesktopChrome.control()),
        const SizedBox(height: 2),
        Text('Then: ${request.next}', style: DesktopChrome.metadata()),
        const SizedBox(height: 8),
        if (request.answer case final answer?)
          Text(
            _answered(context, answer),
            style: DesktopChrome.control(color: DesktopChrome.muted),
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              for (final answer in SuperTabHandsOnAnswer.values)
                _button(context, answer),
            ],
          ),
      ],
    ),
  );

  String _answered(BuildContext context, SuperTabHandsOnAnswer answer) {
    final until = request.until;
    return [
      'You answered: ${answer.label}'
          '${until == null ? '' : ' until ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(until.toLocal()))}'}',
      ?request.note,
    ].join(' · ');
  }

  Widget _button(BuildContext context, SuperTabHandsOnAnswer answer) {
    final busy = decisions.answering.contains(request.id);
    final key = ValueKey('super-hands-on-${request.id}-${answer.name}');
    final label = Text(
      answer == SuperTabHandsOnAnswer.done ? answer.label : '${answer.label}…',
    );
    if (answer == SuperTabHandsOnAnswer.done) {
      return FilledButton.tonal(
        key: key,
        onPressed: busy
            ? null
            : () => unawaited(decisions.answerHandsOn(request, answer)),
        child: label,
      );
    }
    return OutlinedButton(
      key: key,
      onPressed: busy
          ? null
          : () => unawaited(_HandsOnAnswerDialog.show(context, this, answer)),
      child: label,
    );
  }
}

/// "Can't now", with an optional time and note, or a note, which it needs.
class _HandsOnAnswerDialog extends StatefulWidget {
  const _HandsOnAnswerDialog(this.card, this.answer);
  final SuperTabHandsOnCard card;
  final SuperTabHandsOnAnswer answer;

  static Future<void> show(
    BuildContext context,
    SuperTabHandsOnCard card,
    SuperTabHandsOnAnswer answer,
  ) => showAppDialog<void>(
    context: context,
    builder: (_) => _HandsOnAnswerDialog(card, answer),
  );

  @override
  State<_HandsOnAnswerDialog> createState() => _HandsOnAnswerDialogState();
}

class _HandsOnAnswerDialogState extends State<_HandsOnAnswerDialog> {
  /// Until when "can't now" holds, from when Send is pressed; null for no
  /// time.
  static const _times = <(String, Duration?)>[
    ('No time', null),
    ('In an hour', Duration(hours: 1)),
    ('In 3 hours', Duration(hours: 3)),
    ('Tomorrow', Duration(days: 1)),
  ];
  Duration? _wait;
  String _note = '';
  String? _error;
  bool _sending = false;

  bool get _cant => widget.answer == SuperTabHandsOnAnswer.cant;

  Future<void> _send() async {
    if (!_cant && _note.trim().isEmpty) {
      setState(() => _error = 'Write the note.');
      return;
    }
    setState(() => _sending = true);
    final wait = _wait;
    final sent = await widget.card.decisions.answerHandsOn(
      widget.card.request,
      widget.answer,
      note: _note,
      until: wait == null ? null : DateTime.now().add(wait),
    );
    if (!mounted) return;
    if (sent) {
      Navigator.pop(context);
    } else {
      setState(() {
        _sending = false;
        _error = widget.card.decisions.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(_cant ? "Can't now" : 'Note'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(widget.card.request.request, style: DesktopChrome.metadata()),
        if (_cant) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final (label, wait) in _times)
                ChoiceChip(
                  label: Text(label),
                  selected: _wait == wait,
                  onSelected: (_) => setState(() => _wait = wait),
                ),
            ],
          ),
        ],
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('super-hands-on-note'),
          autofocus: true,
          maxLength: 2000,
          minLines: 1,
          maxLines: 4,
          decoration: InputDecoration(
            hintText: _cant ? 'Note (optional)' : 'Your note',
            errorText: _error,
          ),
          onChanged: (value) => _note = value,
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      TextButton(onPressed: _sending ? null : _send, child: const Text('Send')),
    ],
  );
}
