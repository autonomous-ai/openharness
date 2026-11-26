import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/browser_handoff.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Claude Code or Codex signed in on a machine from Chat UI (Pixel, 2026-11-26). A harness started where its engine is
/// signed out waits on the engine's own first-run screens, which a chat cannot show: its chat stayed empty, and what
/// was typed went into a theme picker. Chat UI asks for a sign-in instead ([EngineSignInPanel]).
///
/// The machine runs the engine's own login (CLI lib/engineSignIn.ts) and answers its page; this phone opens it, catches
/// the redirect to its own localhost and hands it back ([BrowserHandoff]), or takes the code Claude's page shows when it
/// could not. Once signed in, the engine's report is read again and the harness started again, past its first-run
/// screens.
class EngineSignIn extends ChangeNotifier {
  EngineSignIn({
    required this.engine,
    required this.ask,
    required this.open,
    required this.signedIn,
    this.folder,
    this.close,
    this.pause = const Duration(seconds: 1),
  });

  /// [agentId]'s engine on [machineId], through [notifier]: its questions, the phone's [BrowserHandoff], and the harness
  /// started again once signed in.
  factory EngineSignIn.of(
    AppNotifier notifier, {
    required String machineId,
    required String agentId,
    required String engine,
    String? folder,
  }) {
    final browser = BrowserHandoff(notifier, say: (_) {});
    return EngineSignIn(
      engine: engine,
      folder: folder,
      ask: (payload) => notifier.engineSignIn(machineId, payload),
      open: (url, deliver) => browser.open(machineId, url, deliver: deliver),
      signedIn: () async {
        // Read until the machine says so: a probe already under way when the login ended answers from before it, and
        // Chat UI kept saying Signing in over a signed-in engine.
        for (var attempt = 0; attempt < 3; attempt++) {
          await notifier.probeEngines(machineId, force: true);
          final agent = notifier
              .stateOf(machineId)
              ?.agents
              .where((agent) => agent.id == agentId)
              .firstOrNull;
          if (agent == null || !notifier.engineSignedOut(machineId, agent)) {
            break;
          }
        }
        await notifier.restartAgent(machineId, agentId);
      },
      close: browser.dispose,
    );
  }

  /// `claude` or `codex`.
  final String engine;

  /// The harness's folder, which the machine trusts once signed in where Harness made it (MSI, 2026-11-26: on a computer
  /// the engine never ran on, its start could not, and the harness stopped at "Is this a project you trust?").
  final String? folder;

  /// One question to the machine's sign-in ([AppNotifier.engineSignIn]).
  final Future<Map<String, dynamic>> Function(Map<String, dynamic> payload) ask;

  /// Opens the page here, handing its caught redirect to `deliver`.
  final Future<void> Function(
    String url,
    Future<void> Function(String caught) deliver,
  )
  open;

  /// Once signed in: the machine's engines read again, and the harness waiting on its first-run screens started again.
  final Future<void> Function() signedIn;
  final Future<void> Function()? close;

  /// Between two questions to the machine while its login starts or finishes.
  final Duration pause;

  /// Asking the machine, or finishing once the redirect came: the button says so and takes no tap.
  bool busy = false;

  /// The page is open on this phone; the person signs in there.
  bool opened = false;

  /// The page is Claude's code page (no localhost one): its code goes in here.
  bool needsCode = false;

  /// What went wrong, as a sentence to show.
  String? error;

  bool done = false;
  String? _id;
  bool _disposed = false;

  /// Who the person signs in to.
  String get account => engine == 'codex' ? 'ChatGPT' : 'Claude';

  /// The engine is signed in already and the harness still waits on its first-run screens (signed in elsewhere, or the
  /// app gone before it started the harness again): the machine records them done, and the harness starts again.
  Future<void> finishSetup() => _go(() async {
    await _ask({'firstRun': true});
    await signedIn();
    done = true;
  });

  /// Starts the machine's login and opens its page here. Asked again, it starts a new one: a page left without signing
  /// in, or a sign-in that failed there, is never waited on.
  Future<void> start() => _go(() async {
    done = false;
    final id = _id = '$engine-sign-in-${DateTime.now().microsecondsSinceEpoch}';
    final deadline = DateTime.now().add(const Duration(seconds: 60));
    String? page;
    while (page == null) {
      final answer = await _ask({'operationId': id});
      if (answer['state'] == 'page') {
        page = answer['url'] as String?;
        needsCode = page != null && page == answer['codeUrl'];
      }
      if (page != null) break;
      if (DateTime.now().isAfter(deadline)) {
        throw _Refused('$account\'s sign-in did not open. Try again.');
      }
      await Future<void>.delayed(pause);
    }
    opened = true;
    await open(page, _deliver);
  });

  /// The code Claude's page showed, into the login waiting on the machine.
  Future<void> submitCode(String code) => code.trim().isEmpty
      ? Future.value()
      : _go(() => _finish({'code': code.trim()}));

  /// The redirect the browser handed this phone's localhost.
  Future<void> _deliver(String caught) =>
      _go(() => _finish({'callback': caught}));

  Future<void> _finish(Map<String, dynamic> sent) async {
    final id = _id;
    if (id == null) return;
    // An answer that did not come is asked again, not taken for a failed sign-in: the machine may be handing the redirect
    // to the engine still, and Codex had signed in while this said "not reachable" (MSI, 2026-11-26).
    var answer = await _ask({'operationId': id, ...sent}, waits: true);
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    while (answer['state'] != 'done') {
      if (DateTime.now().isAfter(deadline)) {
        throw _Refused('$account did not answer yet. Try again.');
      }
      await Future<void>.delayed(pause);
      answer = await _ask({'operationId': id}, waits: true);
    }
    _id = null;
    // Signed in: the machine says so again, and the harness waiting on its first-run screens starts past them.
    await signedIn();
    done = true;
  }

  /// One question to the machine's sign-in; a refusal ends this one, and the next Sign in starts a new login. With
  /// [waits], no answer is an answer still to come.
  Future<Map<String, dynamic>> _ask(
    Map<String, dynamic> payload, {
    bool waits = false,
  }) async {
    final answer = await ask({
      'engine': engine,
      if (folder != null) 'folder': folder,
      ...payload,
    });
    final refused = answer['error'];
    if (waits && refused == 'UNAVAILABLE') return const {'state': 'checking'};
    if (refused is String) {
      _id = null;
      opened = false;
      needsCode = false;
      throw _Refused(switch (refused) {
        'UNAVAILABLE' => 'The computer is not reachable. Try again.',
        'UNKNOWN_TYPE' ||
        'UNSUPPORTED' ||
        'E2EE_REQUIRED' => 'Update Harness on this computer, then try again.',
        _ => answer['detail'] as String? ?? 'Could not sign in. Try again.',
      });
    }
    return answer;
  }

  /// One action at a time; what went wrong goes in [error].
  Future<void> _go(Future<void> Function() act) async {
    if (busy || _disposed) return;
    busy = true;
    error = null;
    _changed();
    try {
      await act();
    } on _Refused catch (refused) {
      error = refused.message;
    } catch (_) {
      error = 'Could not sign in. Try again.';
    } finally {
      busy = false;
      _changed();
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    final close = this.close;
    if (close != null) unawaited(close());
    super.dispose();
  }
}

class _Refused implements Exception {
  const _Refused(this.message);
  final String message;
}

/// What Chat UI shows in place of the conversation while the agent's engine is signed out: one line, and Sign in in
/// the middle. The composer and the model chip are off meanwhile (`phone/terminal_page.dart`). With [setup], the engine
/// is signed in and the harness still waits on its first-run screens: Continue instead.
class EngineSignInPanel extends StatefulWidget {
  const EngineSignInPanel({
    super.key,
    required this.signIn,
    required this.engineName,
    required this.machineName,
    this.setup = false,
    this.checking = false,
  });

  final EngineSignIn signIn;

  /// The machine is still saying whether the engine is signed in: no button, so neither Sign in nor Continue is pressed
  /// on a guess.
  final bool checking;

  /// `Claude Code`, `Codex`.
  final String engineName;
  final String machineName;
  final bool setup;

  @override
  State<EngineSignInPanel> createState() => _EngineSignInPanelState();
}

class _EngineSignInPanelState extends State<EngineSignInPanel> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ColoredBox(
      color: AppPalette.windowBg,
      child: ListenableBuilder(
        listenable: widget.signIn,
        builder: (context, _) {
          final signIn = widget.signIn;
          return Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.xl),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.logIn,
                    size: 28,
                    color: AppPalette.textSecondary,
                  ),
                  const SizedBox(height: AppSpace.m),
                  Text(
                    widget.checking && !signIn.busy
                        ? 'Checking ${widget.engineName} on ${widget.machineName}…'
                        : widget.setup
                        ? '${widget.engineName} needs to finish its setup on ${widget.machineName}.'
                        : '${widget.engineName} isn\'t signed in on ${widget.machineName}.',
                    textAlign: TextAlign.center,
                    style: AppType.body(color: AppPalette.textPrimary),
                  ),
                  if (!widget.checking || signIn.busy) ...[
                  const SizedBox(height: AppSpace.l),
                  // Never held once the page is open: a page left without signing in, or a sign-in that failed there,
                  // is tried again from here, as a new one.
                  FilledButton(
                    onPressed: signIn.busy
                        ? null
                        : () => unawaited(
                            widget.setup
                                ? signIn.finishSetup()
                                : signIn.start(),
                          ),
                    child: Text(switch ((signIn.busy, widget.setup)) {
                      (true, true) => 'Starting…',
                      (true, false) => 'Signing in…',
                      (false, true) => 'Continue',
                      (false, false) => 'Sign in',
                    }),
                  ),
                  if (signIn.opened && !signIn.busy && !widget.setup) ...[
                    const SizedBox(height: AppSpace.s),
                    Text(
                      'Finish signing in on the page that opened.',
                      textAlign: TextAlign.center,
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                  ],
                  if (signIn.opened && signIn.needsCode) ...[
                    const SizedBox(height: AppSpace.l),
                    TextField(
                      controller: _code,
                      decoration: InputDecoration(
                        hintText: 'Code from ${signIn.account}',
                      ),
                    ),
                    const SizedBox(height: AppSpace.s),
                    TextButton(
                      onPressed: signIn.busy
                          ? null
                          : () => unawaited(signIn.submitCode(_code.text)),
                      child: const Text('Continue'),
                    ),
                  ],
                  if (signIn.error != null) ...[
                    const SizedBox(height: AppSpace.m),
                    Text(
                      signIn.error!,
                      textAlign: TextAlign.center,
                      style: AppType.caption(color: AppPalette.dangerFill),
                    ),
                  ],
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
