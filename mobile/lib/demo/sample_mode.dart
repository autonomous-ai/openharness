/// Sample mode: the phone app, whole, over mock computers and harnesses — no account, no
/// network, nothing written anywhere the real app reads.
///
/// It is how someone tries Harness before they have a machine to link, and how we walk the app
/// as a first-time user: two computers, five harnesses in every state a harness can be in — one
/// working, one finished, one asking a question, two idle — each answering what it is told in a
/// few scripted lines, and New making more.
///
/// ```dart
/// TextButton(
///   onPressed: () => openSampleMode(context),
///   child: const Text('Try a sample'),
/// )
/// ```
///
/// What keeps it apart from the real app:
///
///  - its own [AppNotifier] ([SampleNotifier]), whose machines are in-process
///    ([SampleConnection]) and whose REST client answers everything itself ([SampleApiClient]);
///  - no `paneLayoutStore`, so every store the notifier keeps — last agent, project history,
///    search history, machine cache — remembers for this visit only, and its notices stay out of
///    the notification centre;
///  - its session, device keys and counters in memory ([SampleMemoryStore]);
///  - a microphone that records nothing ([SampleVoiceRecorder]);
///  - the New form's draft, which is a global, put back as it was when the sample is left.
library;

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/voice_input_scope.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'sample_runtime.dart';

export 'sample_runtime.dart' show SampleConnection, SampleRuntime;

/// Opens sample mode over whatever is on screen, and completes when it is left.
///
/// A route of its own on the root navigator, so it is independent of the app under it — signed
/// out or signed in — and leaving it (Settings → Leave sample, the back chevron on its first screen,
/// or the system back at its root)
/// takes all of it away: the harnesses, their timers and its app state.
/// Opens the sample. Completes when it is left — with [SampleExit.setUp] when it was left to set up
/// a real computer (the end card's green button), so the caller can go there next.
Future<String?> openSampleMode(BuildContext context) =>
    Navigator.of(context, rootNavigator: true).push<String>(
      MaterialPageRoute<String>(
        // Full screen, and no edge swipe to leave by: a swipe right on a terminal is Find.
        fullscreenDialog: true,
        builder: (_) => const SampleModeScreen(),
      ),
    );

/// What a screen inside sample mode can ask of it.
/// How the sample was left.
abstract final class SampleExit {
  /// To set up a real computer.
  static const setUp = 'set-up';
}

abstract interface class SampleSession {
  /// Leaves the sample: back to whatever it was opened over, with everything it ran disposed.
  /// [result] is what [openSampleMode] completes with — see [SampleExit].
  void leave([String? result]);

  /// The sample's app state.
  AppNotifier get notifier;

  /// Whether the end card ("That's Harness") has been shown this visit — it comes once.
  bool get endCardSeen;
  set endCardSeen(bool value);
}

/// Marks everything under it as sample mode — see [maybeOf].
class SampleMode extends InheritedWidget {
  const SampleMode({super.key, required this.session, required super.child});

  final SampleSession session;

  /// The sample [context] is in, or null in the real app.
  ///
  /// A screen pushed on the ROOT navigator is outside this widget — a sheet, a chooser — and can
  /// ask [ofNotifier] with the notifier it was handed instead.
  static SampleSession? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<SampleMode>()?.session;

  /// The sample [notifier] belongs to, or null when it is the real app's.
  static SampleSession? ofNotifier(AppNotifier notifier) => _open[notifier];

  static final Expando<SampleSession> _open = Expando('sample mode');

  @override
  bool updateShouldNotify(SampleMode oldWidget) => oldWidget.session != session;
}

/// Sample mode's screen: the phone shell over [SampleRuntime].
class SampleModeScreen extends StatefulWidget {
  const SampleModeScreen({super.key, this.runtime});

  /// The sample to show; a fresh one when null. Disposed with the screen either way.
  final SampleRuntime? runtime;

  @override
  State<SampleModeScreen> createState() => _SampleModeScreenState();
}

class _SampleModeScreenState extends State<SampleModeScreen>
    implements SampleSession {
  late final SampleRuntime _runtime = widget.runtime ?? SampleRuntime();

  /// The real app's New form, as it was — see [newAgentDraft]. The sample's form must neither
  /// open on it nor leave its own behind.
  NewAgentDraft? _realDraft;

  bool _leaving = false;

  @override
  bool endCardSeen = false;

  @override
  AppNotifier get notifier => _runtime.notifier;

  @override
  void initState() {
    super.initState();
    _realDraft = newAgentDraft;
    newAgentDraft = null;
    SampleMode._open[_runtime.notifier] = this;
  }

  @override
  void leave([String? result]) {
    if (_leaving || !mounted) return;
    final route = ModalRoute.of(context);
    final navigator = route?.navigator;
    if (route == null || navigator == null) return;
    _leaving = true;
    // Anything the sample put over itself on the root navigator — a sheet, a chooser — goes
    // first, then the sample.
    navigator.popUntil((candidate) => candidate == route);
    navigator.pop(result);
  }

  @override
  void dispose() {
    SampleMode._open[_runtime.notifier] = null;
    _runtime.dispose();
    newAgentDraft = _realDraft;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SampleMode(
    session: this,
    child: VoiceInputScope(
      create: _runtime.voiceController,
      child: PhoneShell(notifier: _runtime.notifier),
    ),
  );
}
