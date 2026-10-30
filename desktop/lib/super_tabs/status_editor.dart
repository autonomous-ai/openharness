import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// When a status clears itself.
enum _Clears { never, hour, fourHours, today }

/// A person's status: a preset or their own words, and when it clears.
class SuperTabStatusEditor extends StatefulWidget {
  const SuperTabStatusEditor({
    super.key,
    required this.status,
    required this.busy,
    required this.onSave,
  });
  final SuperTabPersonStatus? status;
  final bool busy;

  /// Null clears it.
  final ValueChanged<SuperTabPersonStatus?> onSave;

  @override
  State<SuperTabStatusEditor> createState() => _SuperTabStatusEditorState();
}

class _SuperTabStatusEditorState extends State<SuperTabStatusEditor> {
  late final _text = TextEditingController(text: widget.status?.text ?? '');
  late String? _emoji = widget.status?.emoji;
  _Clears _clears = _Clears.never;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  DateTime? _until() {
    final now = clock.now();
    return switch (_clears) {
      _Clears.never => null,
      _Clears.hour => now.add(const Duration(hours: 1)),
      _Clears.fourHours => now.add(const Duration(hours: 4)),
      _Clears.today => () {
        final local = now.toLocal();
        return DateTime(local.year, local.month, local.day + 1);
      }(),
    };
  }

  @override
  Widget build(BuildContext context) {
    final text = _text.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Status', style: DesktopChrome.control(medium: true)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final (emoji, words) in superTabStatusPresets)
              ChoiceChip(
                key: ValueKey('super-status-$emoji'),
                label: Text('$emoji $words'),
                selected: _emoji == emoji && text == words,
                onSelected: (_) => setState(() {
                  _emoji = emoji;
                  _text.text = words;
                }),
              ),
          ],
        ),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('super-status-text'),
          controller: _text,
          maxLength: 80,
          decoration: const InputDecoration(hintText: 'What are you up to?'),
          onChanged: (_) => setState(() {}),
        ),
        Row(
          children: [
            Text('Clears', style: DesktopChrome.metadata()),
            const SizedBox(width: 8),
            AppSelectField<_Clears>(
              key: const ValueKey('super-status-clears'),
              value: _clears,
              width: 150,
              options: const [
                SelectOption(value: _Clears.never, label: 'Never'),
                SelectOption(value: _Clears.hour, label: 'In 1 hour'),
                SelectOption(value: _Clears.fourHours, label: 'In 4 hours'),
                SelectOption(value: _Clears.today, label: 'End of today'),
              ],
              onChanged: (value) => setState(() => _clears = value),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          children: [
            if (widget.status != null)
              TextButton(
                onPressed: widget.busy ? null : () => widget.onSave(null),
                child: const Text('Clear status'),
              ),
            FilledButton(
              onPressed: widget.busy || text.isEmpty
                  ? null
                  : () => widget.onSave(
                      SuperTabPersonStatus(
                        text: text,
                        emoji: superTabStatusPresets.any((p) => p.$1 == _emoji)
                            ? _emoji
                            : null,
                        until: _until(),
                      ),
                    ),
              child: const Text('Save status'),
            ),
          ],
        ),
      ],
    );
  }
}
