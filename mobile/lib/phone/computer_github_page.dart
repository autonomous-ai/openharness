import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ a Harness OS computer ▸ GitHub: the account its agents clone, push and open pull
/// requests with, signed in from here (CLI osDevice.ts `github`). The computer runs GitHub's device
/// sign-in and answers its code; the code is entered on GitHub's page, in this phone's browser —
/// the computer needs no screen. Signed in, git there uses the account too (`gh auth setup-git`).
class ComputerGithubPage extends StatefulWidget {
  const ComputerGithubPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.openPage,
  });

  final AppNotifier notifier;
  final String machineId;

  /// Opens GitHub's page; the phone's browser unless a test says otherwise.
  final Future<void> Function(Uri url)? openPage;

  @override
  State<ComputerGithubPage> createState() => _ComputerGithubPageState();
}

class _ComputerGithubPageState extends State<ComputerGithubPage> {
  Map<String, dynamic>? _state;
  bool _busy = true;
  String _error = '';

  /// Asking again while a code waits to be entered, to see the sign-in through.
  Timer? _follow;

  /// Back from GitHub's page in the browser: asked at once. The ask that was under way when the app
  /// went behind the browser can hang on the connection Android closed, for its whole timeout.
  late final AppLifecycleListener _back;

  /// Each ask's number: an answer only counts while no later ask was sent ([_ask]).
  int _asks = 0;

  AppNotifier get _app => widget.notifier;
  String get _name =>
      _app.stateOf(widget.machineId)?.machine.displayName ?? 'The computer';
  String? get _login => _state?['login'] as String?;
  Map? get _waiting => _state?['signingIn'] as Map?;

  /// The GitHub CLI was gone and is being put back, for the sign-in that follows (os/setup.py install-gh).
  bool get _installing => _state?['installing'] == true;

  @override
  void initState() {
    super.initState();
    _back = AppLifecycleListener(
      onResume: () {
        if (_waiting != null || _installing) {
          unawaited(_ask('status', quiet: true));
        }
      },
    );
    unawaited(_ask('status'));
  }

  @override
  void dispose() {
    _back.dispose();
    _follow?.cancel();
    super.dispose();
  }

  Future<void> _ask(String state, {bool quiet = false}) async {
    final ask = ++_asks;
    if (!quiet) {
      setState(() {
        _busy = true;
        _error = '';
      });
    }
    final reply = await _app.osDevice(
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
            reply['message'] as String? ??
            'Could not reach $_name. Pull down to try again.';
      }
    });
    _follow?.cancel();
    if (_waiting != null || _installing) {
      _follow = Timer(
        const Duration(seconds: 3),
        () => unawaited(_ask('status', quiet: true)),
      );
    }
  }

  /// The code copied, then GitHub's page opened: it is pasted there.
  Future<void> _openGithub() async {
    final waiting = _waiting;
    if (waiting == null) return;
    await Clipboard.setData(ClipboardData(text: waiting['code'] as String));
    final url = Uri.parse(
      waiting['url'] as String? ?? 'https://github.com/login/device',
    );
    final open =
        widget.openPage ??
        (Uri url) async {
          await launchUrl(url, mode: LaunchMode.externalApplication);
        };
    await open(url);
  }

  Future<void> _signOut() async {
    final confirmed = await confirmPhoneAction(
      context,
      icon: LucideIcons.logOut300,
      title: 'Sign $_name out of GitHub?',
      message:
          'Its agents can no longer push or open pull requests as @$_login, nor clone private '
          'repositories.',
      confirmLabel: 'Sign out',
    );
    if (confirmed && mounted) await _ask('sign_out');
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Text say(String text, {Color? color}) =>
        Text(text, style: tty.style(color: color ?? tty.dim));
    final login = _login;
    final waiting = _waiting;
    final failed = _state?['signInError'] as String?;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => _ask('status'),
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    MediaQuery.paddingOf(context).bottom + 24,
                  ),
                  children: [
                    const TtyText(
                      'GitHub',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 8),
                    if (_error.isNotEmpty)
                      say(_error, color: tty.red)
                    else if (_state == null)
                      const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else if (login != null) ...[
                      say(
                        'Agents on $_name clone, push and open pull requests as @$login.',
                      ),
                      const SizedBox(height: 12),
                      SettingsGroup(
                        children: [
                          SettingsRow(
                            key: const Key('github-account'),
                            title: 'Account',
                            value: '@$login',
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      TtyPrimaryButton(
                        key: const Key('github-sign-out'),
                        label: 'Sign out of GitHub',
                        busy: _busy,
                        busyLabel: 'Signing out…',
                        onPressed: () => unawaited(_signOut()),
                      ),
                    ] else if (waiting != null) ...[
                      say(
                        'Enter this code on GitHub\'s page, then allow it. $_name signs in '
                        'as soon as you do.',
                      ),
                      const SizedBox(height: 16),
                      Center(
                        child: SelectableText(
                          waiting['code'] as String,
                          key: const Key('github-code'),
                          style: tty.style(
                            size: TtySize.display,
                            weight: FontWeight.w600,
                            color: tty.text,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      TtyPrimaryButton(
                        key: const Key('github-open'),
                        label: 'Copy code and open GitHub',
                        onPressed: () => unawaited(_openGithub()),
                      ),
                      const SizedBox(height: 12),
                      say('Waiting for GitHub…'),
                    ] else if (_installing) ...[
                      say(
                        'The GitHub CLI was not on $_name, so it is installing it now. The '
                        'code to enter on GitHub shows here once it is done — a minute or two.',
                      ),
                      const SizedBox(height: 20),
                      const Center(
                        key: Key('github-installing'),
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ] else ...[
                      say(
                        _state?['missing'] == true
                            ? 'Sign $_name in to GitHub so its agents can clone private repositories, '
                                  'push and open pull requests — with a Swarm too. The GitHub CLI is '
                                  'not on it: signing in installs it first.'
                            : 'Sign $_name in to GitHub so its agents can clone private repositories, '
                                  'push and open pull requests — with a Swarm too.',
                      ),
                      if (failed != null) ...[
                        const SizedBox(height: 8),
                        say(
                          'The last sign-in did not finish: $failed',
                          color: tty.red,
                        ),
                      ],
                      const SizedBox(height: 20),
                      TtyPrimaryButton(
                        key: const Key('github-sign-in'),
                        label: 'Sign in to GitHub',
                        busy: _busy,
                        busyLabel: 'Asking GitHub…',
                        onPressed: () => unawaited(_ask('sign_in')),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
