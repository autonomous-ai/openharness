import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../swarm/swarm_face.dart';
import '../swarm/swarm_profile.dart';
import '../swarm/swarm_session.dart';

/// One Swarm the person is in, as Profile changes their @username there (`member.username`) and, when it followed
/// their account name, the Swarm's own name for them (`member.name`).
class AccountProfileSwarm {
  const AccountProfileSwarm({
    required this.name,
    required this.username,
    required this.personName,
    required this.setUsername,
    required this.setName,
  });

  /// The Swarm's name, as "in Pilot" says it.
  final String name;
  final String? username;

  /// The name this Swarm shows for them.
  final String? personName;

  /// Null once saved, else the Swarm's refusal in its words.
  final Future<String?> Function(String username) setUsername;
  final Future<String?> Function(String name) setName;
}

/// The Swarms of [session] the person may still rename themselves in (`SwarmProfile.canRename`), in the inbox's
/// order: each a Username field in Profile.
List<AccountProfileSwarm> accountProfileSwarms(SwarmSession? session) {
  if (session == null) return const [];
  final targets = <AccountProfileSwarm>[];
  for (final listing in session.inbox.swarms) {
    final reader = session.inbox.reader(listing.id);
    if (reader == null) continue;
    final profile = SwarmProfile(reader: reader);
    if (!profile.canRename) continue;
    final me = reader.snapshot?.person(reader.accountId);
    targets.add(AccountProfileSwarm(
      name: listing.name,
      username: me?.username,
      personName: me?.name,
      setUsername: profile.setUsername,
      setName: profile.setName,
    ));
  }
  return targets;
}

/// Profile (task #2655), from the account row's sheet in Settings: the account's name, everywhere, and the @username
/// in each Swarm of [swarms]. The desktop's Profile (#2917) in the phone's dialog look (`rename_agent_dialog.dart`).
Future<void> showAccountProfile(
  BuildContext context,
  AppNotifier notifier, {
  List<AccountProfileSwarm> swarms = const [],
}) => showAppDialog<void>(
  context: context,
  builder: (_) => _AccountProfileDialog(notifier: notifier, swarms: swarms),
);

/// The backend's rule (backend/src/lib/accountName.ts), said before sending when it is plain here.
const _invalidName = 'Use 1 to 60 characters, with no hidden ones.';
const _maxName = 60;
const _maxUsername = 32;

class _AccountProfileDialog extends StatefulWidget {
  const _AccountProfileDialog({required this.notifier, required this.swarms});

  final AppNotifier notifier;
  final List<AccountProfileSwarm> swarms;

  @override
  State<_AccountProfileDialog> createState() => _AccountProfileDialogState();
}

class _AccountProfileDialogState extends State<_AccountProfileDialog> {
  /// The name when the sheet opened: a Swarm's own name follows only a name changed here, and only where it was
  /// that name, so one set on purpose in a Swarm stays.
  late final String _openedName = widget.notifier.currentUser?.name ?? '';
  late final _name = TextEditingController(text: _openedName);
  late final _usernames = [for (final s in widget.swarms) TextEditingController(text: s.username ?? '')];

  /// What each Swarm holds now: updated as each save lands, so Save again sends only what is left.
  late final _savedUsernames = [for (final s in widget.swarms) s.username ?? ''];
  late final _swarmNames = [for (final s in widget.swarms) s.personName];
  late String _savedName = _openedName;

  bool _busy = false;
  String? _nameError;
  late final _usernameErrors = List<String?>.filled(widget.swarms.length, null);

  @override
  void dispose() {
    _name.dispose();
    for (final c in _usernames) {
      c.dispose();
    }
    super.dispose();
  }

  /// One space between words, as the backend keeps it.
  static String _tidy(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();

  /// Sends only what differs from what is saved, in order: the account name, each username, then each Swarm's own
  /// name where it followed the old one. Stops at the first refusal and says why under its field.
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
      _usernameErrors.fillRange(0, _usernameErrors.length, null);
    });
    String? failure;
    int? failedSwarm;
    if (name != _tidy(_savedName)) {
      failure = await widget.notifier.setAccountName(name);
      if (failure == null) _savedName = name;
    }
    for (var i = 0; failure == null && i < widget.swarms.length; i++) {
      final username = _usernames[i].text.trim();
      if (username.isEmpty || username == _savedUsernames[i]) continue;
      failure = await widget.swarms[i].setUsername(username);
      if (failure == null) {
        _savedUsernames[i] = username;
      } else {
        failedSwarm = i;
      }
    }
    final renamed = name != _tidy(_openedName);
    for (var i = 0; failure == null && renamed && i < widget.swarms.length; i++) {
      final own = _swarmNames[i];
      if (own == null || _tidy(own) != _tidy(_openedName)) continue;
      failure = await widget.swarms[i].setName(name);
      if (failure == null) {
        _swarmNames[i] = name;
      } else {
        failedSwarm = null;
      }
    }
    if (!mounted || !(ModalRoute.of(context)?.isActive ?? false)) return;
    if (failure == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      if (failedSwarm case final i?) {
        _usernameErrors[i] = failure;
      } else {
        _nameError = failure;
      }
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
                for (var i = 0; i < widget.swarms.length; i++) ...[
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      _label('Username'),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'in ${widget.swarms[i].name}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: grid.AppPalette.textSecondary, fontSize: 13),
                        ),
                      ),
                    ],
                  ),
                  TextField(
                    key: ValueKey('account-profile-username-$i'),
                    controller: _usernames[i],
                    enabled: !_busy,
                    maxLength: _maxUsername,
                    autocorrect: false,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(counterText: '', prefixText: '@'),
                    onChanged: (_) => setState(() => _usernameErrors[i] = null),
                    onSubmitted: submit,
                  ),
                  if (_usernameErrors[i] case final error?) _error('account-profile-username-$i-error', error, danger),
                ],
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
