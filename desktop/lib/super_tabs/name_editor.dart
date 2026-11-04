import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';

/// The most characters a name takes (backend personNames.ts MAX_NAME_LENGTH).
const superTabNameMaxLength = 40;

/// The name the Swarm shows for the reader ("Minh Nguyen"): the field, Save,
/// and why a name was refused, said under the field. Emptied, Save clears it
/// and the Swarm shows their username again.
class SuperTabNameEditor extends StatefulWidget {
  const SuperTabNameEditor({
    super.key,
    required this.name,
    required this.busy,
    required this.onSave,
  });

  /// The name they set; null when they have none.
  final String? name;
  final bool busy;

  /// Saves the name, null to clear it; answers why it was refused, or null
  /// once saved.
  final Future<String?> Function(String? name) onSave;

  @override
  State<SuperTabNameEditor> createState() => _SuperTabNameEditorState();
}

class _SuperTabNameEditorState extends State<SuperTabNameEditor> {
  late final _text = TextEditingController(text: widget.name ?? '');
  String? _error;

  /// The last name saved, until the server's version of it arrives.
  String? _sent;

  @override
  void didUpdateWidget(SuperTabNameEditor old) {
    super.didUpdateWidget(old);
    // A saved name comes back as the server keeps it (one space between
    // words), but never over a newer edit typed while it was on its way.
    final typed = _text.text.trim();
    if (old.name == widget.name) return;
    if (typed == (old.name ?? '') || typed == _sent) {
      _text.text = widget.name ?? '';
    }
    _sent = null;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _changed => _text.text.trim() != (widget.name ?? '');

  Future<void> _save() async {
    if (widget.busy || !_changed) return;
    final typed = _sent = _text.text.trim();
    final error = await widget.onSave(typed.isEmpty ? null : typed);
    if (error != null) _sent = null;
    if (mounted) setState(() => _error = error);
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('Name', style: DesktopChrome.control(medium: true)),
      const SizedBox(height: 8),
      Row(
        children: [
          Expanded(
            child: TextField(
              key: const ValueKey('super-name-field'),
              controller: _text,
              maxLength: superTabNameMaxLength,
              textInputAction: TextInputAction.done,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() => _error = null),
              onSubmitted: (_) => _save(),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            key: const ValueKey('super-name-save'),
            onPressed: widget.busy || !_changed ? null : _save,
            child: const Text('Save'),
          ),
        ],
      ),
      const SizedBox(height: 4),
      Text(
        'What teammates see. Leave empty to show your username.',
        style: DesktopChrome.metadata(),
      ),
      if (_error case final error?) ...[
        const SizedBox(height: 4),
        Text(
          error,
          style: DesktopChrome.metadata(
            color: Theme.of(context).colorScheme.error,
          ),
        ),
      ],
    ],
  );
}
