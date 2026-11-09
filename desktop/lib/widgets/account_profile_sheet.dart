import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';

/// Profile (task #2654), from the avatar menu and Settings ▸ Account: the
/// account's name, everywhere. One flat sheet.
Future<void> showAccountProfileSheet(BuildContext context, AppNotifier app) =>
    showAppDialog<void>(
      context: context,
      builder: (context) => AccountProfileSheet(app: app),
    );

/// The backend's rule (backend/src/lib/accountName.ts), said before sending
/// when it is plain here: an empty name, or one too long.
const _invalidName = 'Use 1 to 60 characters, with no hidden ones.';
const _maxName = 60;

class AccountProfileSheet extends StatefulWidget {
  const AccountProfileSheet({super.key, required this.app});

  final AppNotifier app;

  @override
  State<AccountProfileSheet> createState() => _AccountProfileSheetState();
}

class _AccountProfileSheetState extends State<AccountProfileSheet> {
  late final _name = TextEditingController(
    text: widget.app.currentUser?.name ?? '',
  );
  bool _busy = false;
  String? _nameError;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  /// One space between words, as the backend keeps it.
  static String _tidy(String text) =>
      text.replaceAll(RegExp(r'[\t\s]+'), ' ').trim();

  /// Sends the name when it differs from what is saved, and says why under
  /// its field when the backend refuses it.
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
    String? failure;
    if (name != (widget.app.currentUser?.name ?? '')) {
      failure = await widget.app.setAccountName(name);
    }
    if (!mounted) return;
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
    return DesktopPromptSurface(
      key: const ValueKey('account-profile-sheet'),
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Profile', style: DesktopChrome.heading()),
          const SizedBox(height: DesktopChrome.groupGap),
          Text('Name', style: DesktopChrome.control(medium: true)),
          const SizedBox(height: 6),
          TextField(
            key: const ValueKey('account-profile-name'),
            controller: _name,
            autofocus: true,
            enabled: !_busy,
            maxLength: _maxName,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(counterText: ''),
            onChanged: (_) => setState(() => _nameError = null),
            onSubmitted: (_) => unawaited(_save()),
          ),
          if (_nameError case final error?)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                error,
                key: const ValueKey('account-profile-name-error'),
                style: DesktopChrome.metadata(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
        ],
      ),
      actions: [
        TextButton(
          key: const ValueKey('account-profile-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('account-profile-save'),
          onPressed: _busy ? null : () => unawaited(_save()),
          child: const Text('Save'),
        ),
      ],
    );
  }
}
