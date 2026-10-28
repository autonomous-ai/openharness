import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'join_link.dart';
import 'model.dart';

Future<void> showSuperTabSharing(
  BuildContext context,
  SuperTabController controller,
) => showAppDialog<void>(
  context: context,
  builder: (_) => SuperTabDialogScope(
    controller: controller,
    requireWrite: false,
    child: SwarmSharingDialog(controller: controller),
  ),
);

class SwarmSharingDialog extends StatefulWidget {
  const SwarmSharingDialog({super.key, required this.controller});
  final SuperTabController controller;

  @override
  State<SwarmSharingDialog> createState() => _SwarmSharingDialogState();
}

class _SwarmSharingDialogState extends State<SwarmSharingDialog> {
  final _email = TextEditingController();
  final _domain = TextEditingController();
  String _inviteRole = 'collaborator',
      _mode = 'invited',
      _role = 'collaborator';
  bool _loading = true,
      _saving = false,
      _peopleExpanded = false,
      _copied = false;
  String? _sharingError, _emailError;
  Map<String, dynamic>? _settings, _pending;
  Timer? _copyFeedback;
  SuperTabController get c => widget.controller;
  String get _path => '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/sharing';
  bool get _current => mounted && !c.accessRevoked && c.isOwner;
  bool get _busy =>
      _saving || c.saving || c.hasPendingAction || _pending != null;
  Map<String, dynamic> get _access => {
    'mode': _mode,
    'role': _role,
    if (_mode == 'domain') 'domain': _domain.text.trim().toLowerCase(),
  };
  bool get _changed {
    if (_settings == null) return false;
    final saved = superTabMap(_settings!['access']);
    return _mode != saved['mode'] ||
        _role != saved['role'] ||
        (_mode == 'domain' && _access['domain'] != saved['domain']);
  }

  bool get _domainValid =>
      _mode != 'domain' ||
      RegExp(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
          .hasMatch(_domain.text.trim().toLowerCase());
  String? get _joinUrl {
    final value = _settings?['joinUrl'];
    if (value is! String) return null;
    final link = SwarmJoinLink.parse(value);
    return link?.tabId == c.tabId ? link!.url : null;
  }

  @override
  void initState() {
    super.initState();
    _email.addListener(_edited);
    _domain.addListener(_edited);
    if (c.isOwner) {
      unawaited(_load());
    } else {
      _loading = false;
      _peopleExpanded = true;
    }
  }

  void _edited() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _copyFeedback?.cancel();
    _email.dispose();
    _domain.dispose();
    super.dispose();
  }

  void _apply(Map<String, dynamic> reply) {
    final access = superTabMap(reply['access']);
    if (reply['revision'] is! num ||
        !const ['invited', 'domain', 'link'].contains(access['mode']) ||
        !const ['collaborator', 'viewer'].contains(access['role']) ||
        (access['mode'] == 'domain' && access['domain'] is! String)) {
      throw const FormatException('Invalid sharing settings');
    }
    _settings = reply;
    _mode = access['mode'] as String;
    _role = access['role'] as String;
    _domain.text = access['domain'] as String? ?? '';
    _copied = false;
  }

  Future<void> _load() async {
    if (!_current) return;
    setState(() {
      _loading = true;
      _sharingError = null;
    });
    try {
      final reply = await c.request('GET', _path);
      if (_current) setState(() => _apply(reply));
    } catch (failure) {
      if (_current) {
        setState(() {
          _sharingError =
              failure is SuperTabFailure && failure.statusCode == 404
              ? 'Sharing links aren’t available on this server yet.'
              : 'Could not load sharing settings. Try again.';
        });
      }
    } finally {
      if (_current) setState(() => _loading = false);
    }
  }

  Future<void> _save({bool rotate = false}) async {
    if (!_current ||
        _saving ||
        c.saving ||
        c.hasPendingAction ||
        _settings == null) {
      return;
    }
    if (_pending == null && !_domainValid) return;
    // Retry the same receipt after an uncertain response, especially for a
    // rotated link. Never create a fresh token merely because its reply was lost.
    _pending ??= {
      'operationId': superTabOperationId(),
      'revision': _settings!['revision'],
      'access': _access,
      if (rotate) 'rotateLink': true,
    };
    setState(() {
      _saving = true;
      _sharingError = null;
    });
    try {
      final reply = await c.request('POST', _path, body: _pending);
      if (!_current) return;
      setState(() {
        _apply(reply);
        _pending = null;
      });
    } catch (failure) {
      if (!_current) return;
      if (failure is SuperTabFailure &&
          failure.statusCode >= 400 &&
          failure.statusCode < 500 &&
          !const {408, 429}.contains(failure.statusCode)) {
        _pending = null;
        if (const {
          'REVISION_CHANGED',
          'SHARING_CHANGED',
        }.contains(failure.code)) {
          await _load();
          if (_current) {
            setState(
              () => _sharingError =
                  'Sharing changed. Review the current settings and try again.',
            );
          }
        } else {
          setState(
            () => _sharingError =
                'Could not change sharing. Check your access and try again.',
          );
        }
      } else {
        setState(
          () => _sharingError =
              'Could not confirm this change. Retry to check it.',
        );
      }
    } finally {
      if (_current) setState(() => _saving = false);
    }
  }

  Future<void> _invite() async {
    if (!_current || _busy) return;
    final email = _email.text.trim();
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)) {
      setState(() => _emailError = 'Enter an email address.');
      return;
    }
    setState(() => _emailError = null);
    final result = await c.command({
      'type': 'invite.create',
      'email': email,
      'role': _inviteRole,
      // Swarm invitations do not depend on the open workgroup or grant private
      // project membership. The backend keeps this legacy landing identifier.
      'conversationId': 'lead',
    });
    if (result != null && _current) {
      _email.clear();
      setState(() => _peopleExpanded = true);
    }
  }

  Future<void> _copyLink() async {
    final url = _joinUrl;
    if (url == null || _changed || _busy || !_current) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (!_current) return;
    setState(() => _copied = true);
    _copyFeedback?.cancel();
    _copyFeedback = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  Future<void> _remove(SuperTabPerson person) async {
    if (_removeReason(person) != null) return;
    final leaving = person.id == c.accountId;
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: AlertDialog(
          title: Text(leaving ? 'Leave Swarm?' : 'Remove ${person.email}?'),
          content: const Text(
            'Swarm access and agent contributions will be withdrawn. Running harnesses stay on their machines.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(leaving ? 'Leave' : 'Remove'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted || c.accessRevoked) return;
    final result = await c.command({
      'type': 'member.remove',
      'userId': person.id,
    });
    if (result != null && leaving && mounted) Navigator.pop(context);
  }

  String? _removeReason(SuperTabPerson person) {
    final snapshot = c.snapshot;
    if (snapshot == null) return null;
    for (final agent in snapshot.agents) {
      if (agent.contributorId != person.id) continue;
      if (snapshot.leadProtectionReason(agent.id) case final reason?) {
        return reason;
      }
    }
    return null;
  }

  Widget _select({
    required Key key,
    required String value,
    required String label,
    required List<SelectOption<String>> options,
    required ValueChanged<String> onChanged,
    bool quiet = false,
  }) {
    final measure = TextPainter(
      text: TextSpan(text: options.first.label, style: DesktopChrome.control()),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = measure.width + 46;
    measure.dispose();
    return ExcludeFocus(
      excluding: _busy,
      child: IgnorePointer(
        ignoring: _busy,
        child: AppSelectField<String>(
          key: key,
          value: value,
          options: options,
          semanticLabel: label,
          textStyle: DesktopChrome.control(),
          width: quiet ? width : null,
          fillColor: quiet ? Colors.transparent : null,
          selected: quiet ? false : null,
          onChanged: (value) {
            if (!_busy) onChanged(value);
          },
        ),
      ),
    );
  }

  /// The email, its access and Invite on one line; with enlarged text, the email above the other two.
  Widget _inviteRow(Widget email, Widget role, Widget invite) => LayoutBuilder(
    builder: (context, constraints) {
      final roomy =
          constraints.maxWidth >= 360 &&
          MediaQuery.textScalerOf(context).scale(13) <= 20;
      return roomy
          ? Row(
              children: [
                Expanded(child: email),
                const SizedBox(width: DesktopChrome.controlGap),
                role,
                const SizedBox(width: DesktopChrome.controlGap),
                invite,
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                email,
                const SizedBox(height: DesktopChrome.controlGap),
                Row(
                  children: [
                    Flexible(child: role),
                    const Spacer(),
                    invite,
                  ],
                ),
              ],
            );
    },
  );

  static Widget _explained(String? why, Widget control) =>
      why == null ? control : Tooltip(message: why, child: control);

  /// A row's own control: text with no pill, its fill only on hover.
  static final _quiet = superTabQuietAction;

  static const _roles = [
    SelectOption(value: 'collaborator', label: 'Can collaborate'),
    SelectOption(value: 'viewer', label: 'Can view'),
  ];

  Widget _people() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final person in c.snapshot?.people ?? <SuperTabPerson>[])
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(person.email, style: DesktopChrome.text()),
                    Text(
                      person.role == 'owner'
                          ? 'Owner'
                          : person.role == 'viewer'
                          ? 'Can view'
                          : 'Can collaborate',
                      style: DesktopChrome.metadata(),
                    ),
                  ],
                ),
              ),
              if (person.role != 'owner' &&
                  (c.isOwner || person.id == c.accountId)) ...[
                const SizedBox(width: 8),
                // Quiet, and why it is unavailable on hover rather than as a sentence in the list (Ken, 2026-10-28).
                _explained(
                  _removeReason(person),
                  TextButton(
                    style: _quiet,
                    onPressed: _busy || _removeReason(person) != null
                        ? null
                        : () => _remove(person),
                    child: Text(person.id == c.accountId ? 'Leave' : 'Remove'),
                  ),
                ),
              ],
            ],
          ),
        ),
      for (final invite in c.snapshot?.invitations ?? <Map<String, dynamic>>[])
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      invite['email'] as String,
                      style: DesktopChrome.text(),
                    ),
                    Text('Invited', style: DesktopChrome.metadata()),
                  ],
                ),
              ),
              if (c.isOwner) ...[
                const SizedBox(width: 8),
                TextButton(
                  style: _quiet,
                  onPressed: _busy
                      ? null
                      : () => c.command({
                          'type': 'invite.revoke',
                          'inviteId': invite['id'],
                        }),
                  child: const Text('Revoke'),
                ),
              ],
            ],
          ),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SuperTabDetailDialog(
      title: 'Share Swarm',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (c.isOwner) ...[
            _inviteRow(
              TextField(
                key: const Key('swarm-invite-email'),
                controller: _email,
                autofocus: true,
                enabled: !_busy,
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.send,
                decoration: const InputDecoration(hintText: 'Email address'),
                onSubmitted: (_) => _invite(),
              ),
              _select(
                key: const Key('swarm-invite-role'),
                value: _inviteRole,
                label: 'Invitation access',
                options: _roles,
                quiet: true,
                onChanged: (value) => setState(() => _inviteRole = value),
              ),
              FilledButton(
                key: const Key('swarm-invite-send'),
                onPressed: _busy || _email.text.trim().isEmpty ? null : _invite,
                child: const Text('Invite'),
              ),
            ),
            if (_emailError != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_emailError!, style: DesktopChrome.metadata()),
              ),
            const SizedBox(height: 24),
            Text('General access', style: DesktopChrome.control(medium: true)),
            const SizedBox(height: 8),
            if (_loading)
              const LinearProgressIndicator()
            else if (_settings != null) ...[
              _select(
                key: const Key('swarm-general-access'),
                value: _mode,
                label: 'General access',
                options: const [
                  SelectOption(value: 'invited', label: 'Invited people'),
                  SelectOption(value: 'domain', label: 'Anyone at a domain'),
                  SelectOption(value: 'link', label: 'Anyone with the link'),
                ],
                onChanged: (value) => setState(() {
                  _mode = value;
                  _copied = false;
                  if (value == 'domain' && _domain.text.isEmpty) {
                    final email = c.snapshot!.people
                        .where((p) => p.id == c.accountId)
                        .firstOrNull
                        ?.email;
                    if (email != null && email.contains('@')) {
                      _domain.text = email.split('@').last;
                    }
                  }
                }),
              ),
              if (_mode == 'domain') ...[
                const SizedBox(height: 8),
                TextField(
                  key: const Key('swarm-sharing-domain'),
                  controller: _domain,
                  enabled: !_busy,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(hintText: 'example.com'),
                ),
              ],
              if (_mode != 'invited') ...[
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: _select(
                    key: const Key('swarm-sharing-role'),
                    value: _role,
                    label: 'General access role',
                    options: _roles,
                    quiet: true,
                    onChanged: (value) => setState(() => _role = value),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Private projects stay private.',
                  style: DesktopChrome.metadata(),
                ),
              ],
            ],
            if (_sharingError != null) ...[
              const SizedBox(height: 8),
              Text(_sharingError!, style: DesktopChrome.metadata()),
              if (_settings == null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: _load,
                    child: const Text('Retry'),
                  ),
                ),
            ],
            const SizedBox(height: 24),
          ],
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              key: const Key('swarm-sharing-people'),
              style: TextButton.styleFrom(
                backgroundColor: Colors.transparent,
                side: BorderSide.none,
                padding: EdgeInsets.zero,
              ),
              onPressed: () =>
                  setState(() => _peopleExpanded = !_peopleExpanded),
              icon: Icon(
                _peopleExpanded ? AppIcons.chevronDown : AppIcons.chevronRight,
                size: 16,
              ),
              label: const Text('People with access'),
            ),
          ),
          if (_peopleExpanded) _people(),
          if (c.operationError != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(c.operationError!, style: DesktopChrome.metadata()),
            ),
          if (c.hasPendingAction)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: c.saving ? null : c.retry,
                child: const Text('Check pending invitation'),
              ),
            ),
        ],
      ),
      leadingActions: [
        if (_joinUrl != null)
          TextButton.icon(
            key: const Key('swarm-copy-link'),
            onPressed: _busy || _changed ? null : _copyLink,
            icon: Icon(_copied ? AppIcons.check : AppIcons.link2, size: 16),
            label: Text(_copied ? 'Copied' : 'Copy link'),
          ),
        if (_mode == 'link' && !_changed && _joinUrl != null)
          Tooltip(
            message: 'Replace the link. The previous link will stop working.',
            child: TextButton(
              key: const Key('swarm-reset-link'),
              style: _quiet,
              onPressed: _busy ? null : () => _save(rotate: true),
              child: const Text('Reset link'),
            ),
          ),
      ],
      actions: [
        if (_pending != null || _changed)
          FilledButton(
            key: const Key('swarm-sharing-save'),
            onPressed:
                _saving || c.saving || c.hasPendingAction || !_domainValid
                ? null
                : () => _save(),
            child: Text(
              _saving
                  ? 'Saving…'
                  : _pending != null
                  ? 'Retry'
                  : 'Save',
            ),
          )
        else
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
      ],
    ),
  );
}
