import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'harness_os.dart';
import 'intern_computer_use_page.dart';
import 'intern_dialog.dart';
import 'intern_github_page.dart';
import 'intern_page.dart';
import 'intern_password_page.dart';
import 'intern_ssh_page.dart';
import 'intern_version_page.dart';
import 'intern_wifi_page.dart';

/// Manage Intern 3: what can be done to a Harness OS computer that is online and linked, over its
/// daemon (`os_device`, CLI services/osDevice.ts) — the phone's rows for it (mobile
/// machine_actions.dart) in one dialog: the list, and a page for each, Back to the list.
///
/// [onUnlock] is offered on Version when an update restarted an encrypted one and it waits for
/// its password; this dialog closes first.
Future<void> showInternManage(
  BuildContext context,
  AppNotifier app,
  String machineId, {
  VoidCallback? onUnlock,
}) => showInternDialog<void>(
  context,
  (_) =>
      _InternManageDialog(app: app, machineId: machineId, onUnlock: onUnlock),
);

enum _Page { list, version, wifi, password, ssh, github, computerUse, signOut }

class _InternManageDialog extends StatefulWidget {
  const _InternManageDialog({
    required this.app,
    required this.machineId,
    this.onUnlock,
  });

  final AppNotifier app;
  final String machineId;
  final VoidCallback? onUnlock;

  @override
  State<_InternManageDialog> createState() => _InternManageDialogState();
}

class _InternManageDialogState extends State<_InternManageDialog> {
  _Page _page = _Page.list;
  bool _asking = true, _signingOut = false;
  String? _error;

  HarnessOs get _os => widget.app.harnessOs;
  String get _id => widget.machineId;
  String get _name =>
      widget.app.machineStates[_id]?.machine.displayName ?? 'The computer';

  @override
  void initState() {
    super.initState();
    _os.addListener(_changed);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _os.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _refresh() async {
    setState(() => _asking = true);
    await _os.refresh(_id, force: true);
    if (mounted) setState(() => _asking = false);
  }

  void _open(_Page page) => setState(() {
    _page = page;
    _error = null;
  });

  void _back() => _open(_Page.list);

  /// Signed out of this account, for another one to set it up (os/setup.py `sign_out`): it forgets
  /// its Wi-Fi and opens its own hotspot. Its harnesses, projects and files stay.
  Future<void> _signOut() async {
    setState(() {
      _signingOut = true;
      _error = null;
    });
    final reply = await widget.app.osDevice(_id, {'action': 'sign_out'});
    if (!mounted) return;
    if (reply['started'] == true) {
      _os.forget(_id);
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _signingOut = false;
      _error = 'Could not reach $_name. Try again.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    return switch (_page) {
      _Page.list => _list(),
      _Page.version => InternVersionPage(
        app: app,
        machineId: _id,
        onBack: _back,
        onUnlock: widget.onUnlock,
      ),
      _Page.wifi => InternWifiPage(app: app, machineId: _id, onBack: _back),
      _Page.password => InternPasswordPage(
        app: app,
        machineId: _id,
        onBack: _back,
      ),
      _Page.ssh => InternSshPage(app: app, machineId: _id, onBack: _back),
      _Page.github => InternGithubPage(app: app, machineId: _id, onBack: _back),
      _Page.computerUse => InternComputerUsePage(
        app: app,
        machineId: _id,
        onBack: _back,
      ),
      _Page.signOut => _confirmSignOut(),
    };
  }

  Widget _confirmSignOut() {
    final hotspot = _os.hotspot(_id) ?? 'Harness-…';
    return InternDialogFrame(
      title: 'Sign out $_name?',
      message: _error ?? (_signingOut ? 'Signing out…' : null),
      error: _error != null,
      actions: [
        internButton(
          'Cancel',
          _signingOut ? null : _back,
          key: const Key('intern-back'),
        ),
        internButton(
          'Sign out',
          _signingOut ? null : () => unawaited(_signOut()),
          key: const Key('intern-sign-out-confirm'),
          danger: true,
        ),
      ],
      children: [
        InternText(
          'It signs out of this account and forgets its Wi-Fi, then opens its own Wi-Fi "$hotspot" '
          'to be set up again, on this account or another. Its harnesses, projects and files stay '
          'on it.',
        ),
      ],
    );
  }

  Widget _list() {
    final status = _os.status[_id];
    final runs = _os.runsHarnessOs(_id);
    bool has(String feature) => _os.feature(_id, feature);
    final update = _os.updateAvailable(_id);
    InternRow row(String key, String title, _Page page, {String? value}) =>
        InternRow(
          key: Key('intern-manage:$key'),
          title: title,
          value: value,
          valueColor: key == 'version' && update ? DesktopChrome.accent : null,
          onTap: () => _open(page),
        );
    return InternDialogFrame(
      title: _name,
      message: _asking && status == null
          ? 'Asking $_name…'
          : status == null
          ? 'Could not reach $_name.'
          : null,
      error: !_asking && status == null,
      actions: [
        if (!_asking && status == null)
          internButton(
            'Retry',
            () => unawaited(_refresh()),
            key: const Key('intern-manage-retry'),
          ),
        internButton(
          'Close',
          () => Navigator.of(context).pop(),
          key: const Key('intern-close'),
          primary: true,
        ),
      ],
      children: [
        if (status != null && !runs)
          InternText('$_name does not run Harness OS.'),
        if (runs) ...[
          row(
            'version',
            'Version',
            _Page.version,
            value: update ? 'New version' : 'Up to date',
          ),
          row('wifi', 'Wi-Fi', _Page.wifi, value: _os.wifi(_id)),
          if (has('password')) row('password', 'Password', _Page.password),
          if (has('ssh')) row('ssh', 'SSH', _Page.ssh),
          if (has('github')) row('github', 'GitHub', _Page.github),
          if (has('computer_use'))
            row('computer-use', 'Computer use', _Page.computerUse),
          if (has('sign_out'))
            InternRow(
              key: const Key('intern-manage:sign-out'),
              title: 'Sign out',
              danger: true,
              onTap: () => _open(_Page.signOut),
            ),
        ],
      ],
    );
  }
}
