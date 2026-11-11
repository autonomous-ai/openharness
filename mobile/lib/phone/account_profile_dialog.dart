import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';

/// Profile (task #2655), from the account row's sheet in Settings: the account's name, everywhere. The desktop's
/// Profile (#2917) in the phone's dialog look (`rename_agent_dialog.dart`).
Future<void> showAccountProfile(BuildContext context, AppNotifier notifier) =>
    showAppDialog<void>(context: context, builder: (_) => _AccountProfileDialog(notifier: notifier));

/// The backend's rule (backend/src/lib/accountName.ts), said before sending when it is plain here.
const _invalidName = 'Use 1 to 60 characters, with no hidden ones.';
const _maxName = 60;

class _AccountProfileDialog extends StatefulWidget {
  const _AccountProfileDialog({required this.notifier});

  final AppNotifier notifier;

  @override
  State<_AccountProfileDialog> createState() => _AccountProfileDialogState();
}

class _AccountProfileDialogState extends State<_AccountProfileDialog> {
  late final String _openedName = widget.notifier.currentUser?.name ?? '';
  late final _name = TextEditingController(text: _openedName);

  bool _busy = false;
  String? _nameError;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  /// One space between words, as the backend keeps it.
  static String _tidy(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();

  /// Sends the name when it differs from the one the sheet opened with, and says why under its field when it is
  /// refused.
  Future<void> _save() async {
    if (_busy) return;
    final name = _tidy(_name.text);
    if (name.isEmpty || name.runes.length > _maxName) {
      setState(() => _nameError = _invalidName);
      return;
    }
    setState(() {
      _busy = true;
      _nameError = null;
    });
    final failure = name == _tidy(_openedName) ? null : await widget.notifier.setAccountName(name);
    if (!mounted || !(ModalRoute.of(context)?.isActive ?? false)) return;
    if (failure == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _nameError = failure;
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    void submit(String _) => unawaited(_save());
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: 'Profile',
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              key: const ValueKey('account-profile-sheet'),
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Profile',
                  style: TextStyle(color: grid.AppPalette.textPrimary, fontSize: 17, fontWeight: grid.AppFont.semibold),
                ),
                const SizedBox(height: 18),
                _label('Name'),
                TextField(
                  key: const ValueKey('account-profile-name'),
                  controller: _name,
                  autofocus: true,
                  enabled: !_busy,
                  maxLength: _maxName,
                  textInputAction: TextInputAction.done,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(counterText: ''),
                  onChanged: (_) => setState(() => _nameError = null),
                  onSubmitted: submit,
                ),
                if (_nameError case final error?) _error('account-profile-name-error', error, danger),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      key: const ValueKey('account-profile-cancel'),
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Cancel'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      key: const ValueKey('account-profile-save'),
                      onPressed: _busy ? null : () => unawaited(_save()),
                      child: const Text('Save'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(text, style: TextStyle(color: grid.AppPalette.textPrimary, fontSize: 14, fontWeight: grid.AppFont.medium)),
  );

  /// A refusal under its field, read out when it appears, in the dialog's red ink.
  Widget _error(String key, String text, Color danger) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(2, 8, 2, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(LucideIcons.circleAlert300, size: 15, color: danger)),
          const SizedBox(width: 6),
          Expanded(child: Text(text, key: ValueKey(key), style: TextStyle(color: danger, fontSize: 13, height: 1.35))),
        ],
      ),
    ),
  );
}
