import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../super_tabs/controller.dart';
import '../super_tabs/profile_actions.dart';
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';

/// The Swarm a Profile sheet edits the @username in, and its name.
typedef AccountProfileSwarm = ({SuperTabController controller, String name});

/// The Swarm open in this window, when the reader is one of its people: its
/// username is theirs to change from Profile. Null with no Swarm open.
AccountProfileSwarm? accountProfileSwarm(AppNotifier app) {
  if (app.swarms.isEmpty) return null;
  final id = app.activeSwarm.superTabId;
  if (id == null) return null;
  final controller = app.superTabs.peek(id);
  if (controller == null || controller.accessRevoked) return null;
  final member =
      controller.snapshot?.people.any((p) => p.id == controller.accountId) ==
      true;
  if (!member) return null;
  return (controller: controller, name: app.superTabName(id) ?? 'this Swarm');
}

/// Profile (task #2654), from the avatar menu and Settings ▸ Account: the
/// account's name, everywhere, and in [swarm] the @username. One flat sheet.
Future<void> showAccountProfileSheet(
  BuildContext context,
  AppNotifier app, {
  AccountProfileSwarm? swarm,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => AccountProfileSheet(app: app, swarm: swarm),
);

/// The backend's rule (backend/src/lib/accountName.ts), said before sending
/// when it is plain here: an empty name, or one too long.
const _invalidName = 'Use 1 to 60 characters, with no hidden ones.';
const _maxName = 60;

class AccountProfileSheet extends StatefulWidget {
  const AccountProfileSheet({super.key, required this.app, this.swarm});

  final AppNotifier app;
  final AccountProfileSwarm? swarm;

  @override
  State<AccountProfileSheet> createState() => _AccountProfileSheetState();
}

class _AccountProfileSheetState extends State<AccountProfileSheet> {
  /// The name as it was when the sheet opened: the Swarm's name follows only
  /// a name the person changed here, so a Swarm name set on purpose stays.
  late final String _openedName = widget.app.currentUser?.name ?? '';
  late final _name = TextEditingController(text: _openedName);
  late final _username = TextEditingController(text: _currentUsername ?? '');
  bool _busy = false;
  String? _nameError, _usernameError;

  SuperTabController? get _swarm => widget.swarm?.controller;

  String? get _currentUsername {
    final c = _swarm;
    return c?.snapshot?.people
        .where((p) => p.id == c.accountId)
        .firstOrNull
        ?.username;
  }

  String? get _currentSwarmName {
    final c = _swarm;
    return c?.snapshot?.people
        .where((p) => p.id == c.accountId)
        .firstOrNull
        ?.name;
  }

  @override
  void dispose() {
    _name.dispose();
    _username.dispose();
    super.dispose();
  }

  /// One space between words, as the backend keeps it.
  static String _tidy(String text) =>
      text.replaceAll(RegExp(r'[\t\s]+'), ' ').trim();

  /// Sends only what differs from what is saved, in order: the account name,
  /// the username, then this Swarm's name. Stops at the first refusal and says
  /// why under its field; what was saved before it stays saved, so Save again
  /// sends only what is left.
  Future<void> _save() async {
    if (_busy) return;
    final name = _tidy(_name.text);
    final username = _username.text.trim();
    if (name.isEmpty || name.runes.length > _maxName) {
      setState(() => _nameError = _invalidName);
      return;
    }
    setState(() {
      _busy = true;
      _nameError = null;
      _usernameError = null;
    });
    String? failure;
    var field = 'name';
    final renamed = name != _tidy(_openedName);
    if (name != (widget.app.currentUser?.name ?? '')) {
      failure = await widget.app.setAccountName(name);
    }
    final swarm = _swarm;
    if (failure == null &&
        swarm != null &&
        username.isNotEmpty &&
        username != _currentUsername) {
      field = 'username';
      failure = await swarm.setUsername(username);
    }
    if (failure == null &&
        swarm != null &&
        renamed &&
        name != _currentSwarmName) {
      field = 'name';
      failure = await swarm.setName(name);
    }
    if (!mounted) return;
    if (failure == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      if (field == 'username') {
        _usernameError = failure;
      } else {
        _nameError = failure;
      }
    });
  }

  Widget _error(String key, String text) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Text(
      text,
      key: ValueKey(key),
      style: DesktopChrome.metadata(color: Theme.of(context).colorScheme.error),
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final swarm = widget.swarm;
    void submit(String _) => unawaited(_save());
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
            onSubmitted: submit,
          ),
          if (_nameError case final error?)
            _error('account-profile-name-error', error),
          if (swarm != null) ...[
            const SizedBox(height: DesktopChrome.groupGap),
            Text('Username', style: DesktopChrome.control(medium: true)),
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const ValueKey('account-profile-username'),
                    controller: _username,
                    enabled: !_busy,
                    maxLength: 32,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(
                      counterText: '',
                      prefixText: '@',
                    ),
                    onChanged: (_) => setState(() => _usernameError = null),
                    onSubmitted: submit,
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    'in ${swarm.name}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ],
            ),
            if (_usernameError case final error?)
              _error('account-profile-username-error', error),
          ],
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
