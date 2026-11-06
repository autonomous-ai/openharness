import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard;
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/state/app_state.dart';

import '../../swarm/swarm_buddy.dart' show swarmBuddyKey;
import '../../swarm/swarm_buddy_chat.dart' show openSwarmBuddy;
import '../../swarm/swarm_session.dart';
import '../../swarm/swarm_start.dart' show SwarmComputers;
import '../browser_handoff.dart';
import '../settings_row.dart';
import '../tty.dart';
import '../tty_controls.dart';
import 'add_device_page.dart' show SetupLine;
import 'intern3_swarm.dart';

/// Start on Set up Intern 3, with Swarm on: a page of its own, not more lines under Intern 3's setup (owner, 2026-11-06).
/// It runs [Intern3Swarm] as it opens — the Swarm, Claude Code on Intern 3, the sign-in to Claude, the Buddy — each step
/// ✓ as it is done, and opens the Buddy's chat at the end.
class SetUpSwarmPage extends StatefulWidget {
  const SetUpSwarmPage({
    super.key,
    required this.notifier,
    required this.session,
    required this.computers,
    required this.machineId,
    required this.machineName,
    this.swarmId,
  });

  final AppNotifier notifier;
  final SwarmSession session;
  final SwarmComputers computers;
  final String machineId;
  final String machineName;

  /// The Swarm picked on Set up Intern 3 ([Intern3Swarm.swarmId]).
  final String? swarmId;

  @override
  State<SetUpSwarmPage> createState() => _SetUpSwarmPageState();
}

class _SetUpSwarmPageState extends State<SetUpSwarmPage> {
  late final _swarm = Intern3Swarm(
    session: widget.session,
    computers: widget.computers,
    machineId: widget.machineId,
    machineName: widget.machineName,
    swarmId: widget.swarmId,
  )..addListener(_changed);

  /// Redraws the install's bar ([_InstallBar]) while a run goes on.
  Timer? _tick;

  /// The code Claude's sign-in page shows, for Intern 3's login ([Intern3Swarm.sendCode]).
  final _claudeCode = TextEditingController();

  /// Back from Claude's page in the browser: the code its Copy put on the clipboard is filled in.
  late final _life = AppLifecycleListener(
    onResume: () => unawaited(_pasteCode()),
  );

  /// Catches Claude's sign-in on this phone's localhost ([_signIn]).
  late final _handoff = BrowserHandoff(
    widget.notifier,
    say: (text) =>
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text(text))),
  );

  @override
  void initState() {
    super.initState();
    // Built now, so a return from Claude's page is heard.
    _life;
    unawaited(_run());
  }

  @override
  void dispose() {
    _life.dispose();
    unawaited(_handoff.dispose());
    _claudeCode.dispose();
    _tick?.cancel();
    _swarm
      ..removeListener(_changed)
      ..dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _run() async {
    _tick?.cancel();
    _tick = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => _changed(),
    );
    try {
      await _swarm.run();
    } finally {
      _tick?.cancel();
    }
    // Not signed in to Claude on it: the page asks for that first ([_signIn]).
    if (mounted && _swarm.done) await _openBuddy();
  }

  Future<void> _pasteCode() async {
    if (!_swarm.needsCode || _claudeCode.text.isNotEmpty) return;
    final text = (await Clipboard.getData('text/plain'))?.text?.trim() ?? '';
    // Claude's code is one long word (code#state); anything else on the clipboard is not it.
    if (!mounted || text.length < 20 || text.contains(RegExp(r'\s'))) return;
    setState(() => _claudeCode.text = text);
  }

  /// Sign in to Claude: its page for Intern 3's login opens in the browser here. It returns to this phone's localhost,
  /// where [_handoff] catches it and hands it to Intern 3's login, as a sign-in in a pane does: no code to copy. An
  /// Intern 3 whose login gave no such page opens Claude's code page instead, whose code is filled in on return.
  Future<void> _signIn() async {
    final page = await _swarm.openSignIn();
    if (page == null || !mounted) return;
    _claudeCode.clear();
    if (_swarm.needsCode) {
      await launchUrl(Uri.parse(page), mode: LaunchMode.externalApplication);
      return;
    }
    await _handoff.open(
      widget.machineId,
      page,
      deliver: (caught) async {
        final signedIn = await _swarm.sendCallback(caught);
        if (mounted && _swarm.done) await _openBuddy();
        return signedIn;
      },
    );
  }

  /// Continue: the code into Intern 3's login; once Claude takes it, the Buddy starts and its chat opens.
  Future<void> _sendCode() async {
    await _swarm.sendCode(_claudeCode.text);
    if (mounted && _swarm.done) await _openBuddy();
  }

  /// The Buddy tab, in this Swarm, with Settings and this page gone (owner, 2026-11-06), as an old chat's way back to
  /// the Buddy does; its chat as its own page only with no tabs up.
  Future<void> _openBuddy() async {
    final reader = _swarm.reader;
    if (reader == null) return;
    if (widget.session.showBuddyTab case final show?) {
      widget.session.home.showBuddy(reader.tabId);
      Navigator.of(context).popUntil((route) => route.isFirst);
      show();
      return;
    }
    final failed = await openSwarmBuddy(
      context,
      reader,
      reader.tabId,
      swarmBuddyKey,
    );
    if (failed != null && mounted) setState(() => _swarm.error = failed);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      resizeToAvoidBottomInset: false,
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
              child: ListView(
                padding: EdgeInsets.fromLTRB(
                  Tty.origin,
                  8,
                  Tty.origin,
                  MediaQuery.paddingOf(context).bottom +
                      MediaQuery.viewInsetsOf(context).bottom +
                      24,
                ),
                children: [
                  const TtyText(
                    'Set up Swarm',
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 16),
                  ..._body(tty),
                  const SizedBox(height: 20),
                  ..._actions(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Each step, done ✓ or going on, then what went wrong or what is left.
  List<Widget> _body(Tty tty) {
    final swarm = _swarm;
    final name = swarm.machineName;
    final reached = swarm.done
        ? Intern3SwarmStep.values.length
        : swarm.step?.index ?? 0;
    final lines = [
      'Your Swarm',
      'Claude Code on $name, and $name in your Swarm',
      'Signed in to Claude',
      'Claude set up for your Buddy',
      swarm.keptBuddy ? 'Your Buddy, as it runs now' : 'Your Buddy on $name',
    ];
    return [
      for (var i = 0; i < lines.length; i++)
        if (i < reached || (i == reached && swarm.busy)) ...[
          SetupLine(done: i < reached, text: lines[i]),
          if (i == reached && swarm.step == Intern3SwarmStep.machine)
            _InstallBar(since: swarm.stepSince),
        ],
      if (swarm.error case final error?) ...[
        const SizedBox(height: 12),
        Text(
          error,
          key: const Key('set-up-swarm-error'),
          style: tty.style(color: tty.red),
        ),
      ],
      if (swarm.step == Intern3SwarmStep.signIn && !swarm.done) ...[
        const SizedBox(height: 12),
        Text(
          !swarm.signInOpened
              ? 'Claude Code is on $name. Sign in to Claude so your Buddy can use it: the page opens here.'
              : swarm.needsCode
              ? 'Signed in on Claude\'s page? Tap Copy there, come back, and Continue: the code is filled in.'
              : 'Sign in on Claude\'s page. Once you have, it closes by itself and this goes on.',
          key: const Key('set-up-swarm-sign-in'),
          style: tty.style(color: tty.dim),
        ),
        if (swarm.signInOpened && swarm.needsCode) ...[
          const SizedBox(height: 12),
          TtyField(
            key: const Key('set-up-swarm-claude-code'),
            controller: _claudeCode,
            hint: 'Code from Claude',
            onSubmitted: swarm.busy ? null : () => unawaited(_sendCode()),
          ),
        ],
      ],
      if (swarm.step == Intern3SwarmStep.firstRun && !swarm.done) ...[
        const SizedBox(height: 12),
        Text(
          'Claude Code asks two things the first time it runs on $name. Answer them here.',
          key: const Key('set-up-swarm-first-run'),
          style: tty.style(color: tty.dim),
        ),
        const SizedBox(height: 8),
        SettingsGroup(
          children: [
            for (final (theme, label) in _themes)
              SettingsRow(
                key: ValueKey('set-up-swarm-theme-$theme'),
                title: label,
                detail: 'Its text style, for its terminal',
                trailing: _theme == theme ? _checked(tty) : null,
                onTap: swarm.busy ? null : () => setState(() => _theme = theme),
              ),
          ],
        ),
        const SizedBox(height: 8),
        SettingsGroup(
          children: [
            SettingsRow(
              key: const Key('set-up-swarm-full-mode'),
              title: 'Let Claude run commands on $name without asking',
              detail:
                  'Your Buddy needs this: it works on its own, with nobody there to say yes to each command.',
              detailLines: 3,
              trailing: _fullMode ? _checked(tty) : null,
              onTap: swarm.busy
                  ? null
                  : () => setState(() => _fullMode = !_fullMode),
            ),
          ],
        ),
      ],
    ];
  }

  /// Claude Code's text styles offered here, its own words (cli engines/claude/launch.ts `onboarding.theme`).
  static const _themes = [('dark', 'Dark mode'), ('light', 'Light mode')];

  /// The theme picked for Claude Code on Intern 3: dark, as its screen first offers.
  String _theme = 'dark';

  /// Full mode accepted by the person: the Buddy starts only then. Ticked to begin with, as the Buddy needs it (owner,
  /// 2026-11-06); untick it and Continue waits.
  bool _fullMode = true;

  static Widget _checked(Tty tty) =>
      Icon(LucideIcons.check300, size: 18, color: tty.green);

  /// Continue: the answers to Intern 3, then the Buddy starts and its tab opens.
  Future<void> _answerFirstRun() async {
    await _swarm.answerFirstRun(theme: _theme);
    if (mounted && _swarm.done) await _openBuddy();
  }

  List<Widget> _actions() {
    final swarm = _swarm;
    if (swarm.done) {
      return [
        TtyPrimaryButton(
          key: const Key('set-up-swarm-open-buddy'),
          label: 'Open Buddy chat',
          onPressed: () => unawaited(_openBuddy()),
        ),
      ];
    }
    if (swarm.step == Intern3SwarmStep.signIn && swarm.needsSignIn) {
      final code = swarm.signInOpened && swarm.needsCode;
      return [
        TtyPrimaryButton(
          key: const Key('set-up-swarm-claude-sign-in'),
          label: code
              ? 'Continue'
              : swarm.signInOpened
              ? 'Open Claude\'s page again'
              : 'Sign in to Claude',
          busy: swarm.busy,
          busyLabel: swarm.signInOpened ? 'Signing in…' : 'Opening Claude…',
          onPressed: () => unawaited(code ? _sendCode() : _signIn()),
        ),
        if (code && !swarm.busy)
          TtyTextButton(
            key: const Key('set-up-swarm-claude-page-again'),
            label: 'Open Claude\'s page again',
            onPressed: () => unawaited(_signIn()),
          ),
      ];
    }
    if (swarm.step == Intern3SwarmStep.firstRun && swarm.needsFirstRun) {
      return [
        TtyPrimaryButton(
          key: const Key('set-up-swarm-first-run-continue'),
          label: 'Continue',
          busy: swarm.busy,
          busyLabel: 'Starting your Buddy…',
          onPressed: _fullMode ? () => unawaited(_answerFirstRun()) : null,
        ),
      ];
    }
    if (swarm.busy || swarm.error == null) return const [];
    return [
      TtyPrimaryButton(
        key: const Key('set-up-swarm-try-again'),
        label: 'Try again',
        onPressed: () => unawaited(_run()),
      ),
    ];
  }
}

/// Claude Code installing on Intern 3, as New harness draws its install in the pane (cli lib/engineLaunch.ts
/// `INSTALL_PROGRESS_JS`, owner 2026-11-05): a bar from the time it has taken, fast then slower, never full before it
/// ends, under how long is left. Expected longer than a pane's 12 s: over a slow Wi-Fi it took minutes.
class _InstallBar extends StatelessWidget {
  const _InstallBar({required this.since});

  final DateTime since;

  static const _expected = Duration(seconds: 60);

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final t = DateTime.now().difference(since).inMilliseconds;
    final e = _expected.inMilliseconds;
    final done = (1 - 1 / (1 + 2.4 * t / e)).clamp(0.04, 0.97);
    final left = ((e - t) / 1000).round();
    final when = t > 3 * e
        ? 'still working, this can take a while'
        : left > 3
        ? 'about $left s'
        : 'almost there';
    return Padding(
      padding: const EdgeInsets.only(left: 30, top: 4, bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Installing Claude Code…  $when',
            key: const Key('set-up-swarm-install-when'),
            style: tty.style(color: tty.dim),
          ),
          const SizedBox(height: 6),
          ClipRRect(
            key: const Key('set-up-swarm-install-bar'),
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: done,
              minHeight: 6,
              color: tty.green,
              backgroundColor: tty.green.withValues(alpha: 0.18),
            ),
          ),
        ],
      ),
    );
  }
}
