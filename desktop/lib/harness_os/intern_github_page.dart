import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/open_in_browser.dart';
import '../widgets/desktop_chrome.dart';
import 'intern_dialog.dart';
import 'intern_page.dart';

/// Manage Intern 3 ▸ GitHub: the account its agents clone, push and open pull requests with, signed
/// in from here (CLI osDevice.ts `github`). The computer runs GitHub's device sign-in and answers its
/// code; the code is entered on GitHub's page, in this computer's browser — Intern 3 needs no
/// screen. The phone's GitHub page (mobile computer_github_page.dart).
class InternGithubPage extends InternPage {
  const InternGithubPage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
  });

  /// How often a sign-in waiting for its code, or the GitHub CLI being installed, is asked after.
  @visibleForTesting
  static Duration pollEvery = const Duration(seconds: 3);

  @override
  State<InternGithubPage> createState() => _InternGithubPageState();
}

class _InternGithubPageState extends State<InternGithubPage> {
  Map<String, dynamic>? _state;
  bool _busy = true, _confirming = false;
  String _error = '';
  String? _note;

  /// Asking again while a code waits to be entered, to see the sign-in through.
  Timer? _follow;

  /// Each ask's number: an answer only counts while no later ask was sent.
  int _asks = 0;

  String get _name => widget.name;
  String? get _login => _state?['login'] as String?;
  Map? get _waiting => _state?['signingIn'] as Map?;

  /// The GitHub CLI was gone and is being put back, for the sign-in that follows.
  bool get _installing => _state?['installing'] == true;

  @override
  void initState() {
    super.initState();
    unawaited(_ask('status'));
  }

  @override
  void dispose() {
    _follow?.cancel();
    super.dispose();
  }

  Future<void> _ask(String state, {bool quiet = false}) async {
    final ask = ++_asks;
    if (!quiet) {
      setState(() {
        _busy = true;
        _confirming = false;
        _error = '';
        _note = null;
      });
    }
    final reply = await widget.app.osDevice(
      widget.machineId,
      {'action': 'github', 'state': state},
      // Following a sign-in, briefly: the next look comes 3 s later anyway.
      timeout: Duration(seconds: quiet ? 10 : 40),
    );
    if (!mounted || ask != _asks) return;
    setState(() {
      _busy = false;
      if (reply.containsKey('login')) {
        _state = reply;
        _error = '';
      } else if (!quiet) {
        _error =
            reply['message'] as String? ?? 'Could not reach $_name. Try again.';
      }
    });
    _follow?.cancel();
    if (_waiting != null || _installing) {
      _follow = Timer(
        InternGithubPage.pollEvery,
        () => unawaited(_ask('status', quiet: true)),
      );
    }
  }

  Future<void> _copyCode() async {
    final code = _waiting?['code'];
    if (code is! String) return;
    await Clipboard.setData(ClipboardData(text: code));
    if (mounted) setState(() => _note = 'Copied.');
  }

  /// The code copied, then GitHub's page opened: it is pasted there.
  Future<void> _open() async {
    final url = Uri.tryParse(
      _waiting?['url'] as String? ?? 'https://github.com/login/device',
    );
    await _copyCode();
    if (url == null || !await openInBrowser(url)) {
      if (mounted) setState(() => _note = 'Open $url in a browser.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final login = _login;
    final waiting = _waiting;
    final failed = _state?['signInError'] as String?;
    final back = internButton(
      'Back',
      widget.onBack,
      key: const Key('intern-back'),
    );
    if (_confirming && login != null) {
      return InternDialogFrame(
        title: 'Sign $_name out of GitHub?',
        actions: [
          internButton('Cancel', () => setState(() => _confirming = false)),
          internButton(
            'Sign out',
            () => unawaited(_ask('sign_out')),
            key: const Key('intern-github-confirm'),
            danger: true,
          ),
        ],
        children: [
          InternText(
            'Its agents can no longer push or open pull requests as @$login, nor clone private '
            'repositories.',
          ),
        ],
      );
    }
    final List<Widget> children;
    final List<Widget> actions;
    if (_state == null) {
      children = [if (_error.isEmpty) InternText('Asking $_name…')];
      actions = [
        back,
        if (_error.isNotEmpty)
          internButton(
            'Retry',
            () => unawaited(_ask('status')),
            key: const Key('intern-github-retry'),
          ),
      ];
    } else if (login != null) {
      children = [
        InternText(
          'Agents on $_name clone, push and open pull requests as @$login.',
        ),
        InternRow(title: 'Account', value: '@$login', chevron: false),
      ];
      actions = [
        back,
        internButton(
          _busy ? 'Signing out…' : 'Sign out',
          _busy ? null : () => setState(() => _confirming = true),
          key: const Key('intern-github-sign-out'),
          danger: true,
        ),
      ];
    } else if (waiting != null) {
      children = [
        InternText(
          'Enter this code on GitHub\'s page, then allow it. $_name signs in as soon as you do.',
        ),
        Center(
          child: SelectableText(
            waiting['code'] as String? ?? '',
            key: const Key('intern-github-code'),
            style: DesktopChrome.heading(),
          ),
        ),
        const SizedBox(height: 12),
      ];
      actions = [
        back,
        internButton(
          'Copy',
          () => unawaited(_copyCode()),
          key: const Key('intern-github-copy'),
        ),
        internButton(
          'Open GitHub',
          () => unawaited(_open()),
          key: const Key('intern-github-open'),
          primary: true,
        ),
      ];
    } else if (_installing) {
      children = [
        InternText(
          'The GitHub CLI was not on $_name, so it is installing it now. The code to enter on '
          'GitHub shows here once it is done — a minute or two.',
        ),
      ];
      actions = [back];
    } else {
      children = [
        InternText(
          'Sign $_name in to GitHub so its agents can clone private repositories, push and open '
          'pull requests.${_state?['missing'] == true ? ' The GitHub CLI is not on it: signing in installs it first.' : ''}',
        ),
        if (failed != null)
          InternText('The last sign-in did not finish: $failed', muted: false),
      ];
      actions = [
        back,
        internButton(
          _busy ? 'Asking GitHub…' : 'Sign in',
          _busy ? null : () => unawaited(_ask('sign_in')),
          key: const Key('intern-github-sign-in'),
          primary: true,
        ),
      ];
    }
    return InternDialogFrame(
      title: 'GitHub',
      message: _error.isNotEmpty
          ? _error
          : waiting != null && login == null
          ? (_note ?? 'Waiting for GitHub…')
          : _installing
          ? 'Installing the GitHub CLI…'
          : _note,
      error: _error.isNotEmpty,
      actions: actions,
      children: children,
    );
  }
}
