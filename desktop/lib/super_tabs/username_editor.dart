import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';

/// The reader's username: the field, Save, and why a name was refused (taken,
/// or not one a username can be), said under the field it is about.
class SuperTabUsernameEditor extends StatefulWidget {
  const SuperTabUsernameEditor({
    super.key,
    required this.username,
    required this.busy,
    required this.onSave,
  });
  final String username;
  final bool busy;

  /// Saves the name; answers why it was refused, or null once saved.
  final Future<String?> Function(String username) onSave;

  @override
  State<SuperTabUsernameEditor> createState() => _SuperTabUsernameEditorState();
}

class _SuperTabUsernameEditorState extends State<SuperTabUsernameEditor> {
  late final _text = TextEditingController(text: widget.username);
  String? _error;

  /// The last name saved, until the server's version of it arrives.
  String? _sent;

  @override
  void didUpdateWidget(SuperTabUsernameEditor old) {
    super.didUpdateWidget(old);
    // A saved name comes back as the server keeps it (lowercased), but never
    // over a newer edit typed while it was on its way.
    final typed = _text.text.trim();
    if (old.username == widget.username) return;
    if (typed == old.username || typed == _sent) _text.text = widget.username;
    _sent = null;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _changed {
    final typed = _text.text.trim();
    return typed.isNotEmpty && typed != widget.username;
  }

  Future<void> _save() async {
    if (widget.busy || !_changed) return;
    final error = await widget.onSave(_sent = _text.text.trim());
    if (error != null) _sent = null;
    if (mounted) setState(() => _error = error);
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('Username', style: DesktopChrome.control(medium: true)),
      const SizedBox(height: 8),
      Row(
        children: [
          Expanded(
            child: TextField(
              key: const ValueKey('super-username-field'),
              controller: _text,
              maxLength: 32,
              textInputAction: TextInputAction.done,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() => _error = null),
              onSubmitted: (_) => _save(),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            key: const ValueKey('super-username-save'),
            onPressed: widget.busy || !_changed ? null : _save,
            child: const Text('Save'),
          ),
        ],
      ),
      const SizedBox(height: 4),
      Text(
        'How people see and tag you in this Swarm.',
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
