import 'new_device_banner.dart';

import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';

import '../p2p/phone_terminal_p2p.dart';
import 'agent_home.dart';
import 'phone_shell_scope.dart';

/// The signed-in phone app: one page stack, rooted in [AgentHome] — the terminal the phone opens
/// on and stays on. Machines and Settings are pages pushed onto it, from the terminal's menu and
/// from Find.
///
/// ⚠️ **One stack, no tabs.** There were three — Agents, Machines, Settings — each with its own
/// navigator under a bottom bar. The bar was hidden once the terminal became the home screen, and
/// with no bar there was no way to reach the other two: they were built out of sight and never
/// shown, so they went with it.
///
/// Its own [Navigator], nested under the app's, on purpose: `RootShell` swaps this whole shell out
/// on sign-out, and the pages have to go with it rather than stay stacked over the sign-in screen,
/// as they would on the root navigator.
class PhoneShell extends StatefulWidget {
  const PhoneShell({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<PhoneShell> createState() => _PhoneShellState();
}

class _PhoneShellState extends State<PhoneShell> with WidgetsBindingObserver {
  final _navigator = GlobalKey<NavigatorState>();

  /// The nested navigator's own — see the note at the `HeroControllerScope` below.
  final _heroController = HeroController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final notices = widget.notifier.agentNotices.system;
    notices.opened.addListener(_openNoticedAgent);
    // ⚠️ Not asked here any more. Signed in with nothing on screen, "Harness would like to send you
    // notifications" is a question with no reason attached. It is asked the first time a harness
    // is on screen — see `FocusHints.onDone` in `terminal_page.dart`.
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.notifier.agentNotices.system.opened.removeListener(
      _openNoticedAgent,
    );
    _linkedMachineId.dispose();
    _openAgentRequest.dispose();
    _heroController.dispose();
    super.dispose();
  }

  // ── Where the app lands ───────────────────────────────────────────────────────────────────────
  //
  // Almost nothing, now — and that is the change. The shell used to reopen the last agent itself,
  // fall back to Machines when nothing answered, and time the wait out after 45 seconds, because
  // the thing it was steering towards was a page it had to PUSH over an agents list. There is no
  // list and no push: [AgentHome] is the stack's root, and it reads the last-agent record, waits
  // for the machines to answer and picks the agent, all as part of drawing itself.
  //
  // One move is left, because no page can make it alone: a password accepted on a page pushed over
  // the home screen takes the person back to it, where the machine they just opened is about to
  // bring its agents with it.

  /// The machine whose password was just accepted, for [AgentHome] to open once it answers.
  ///
  /// ⚠️ **A notifier and not a field on this State, because a field cannot reach [AgentHome] at
  /// all.** The stack's root is built inside `onGenerateRoute`, which a nested [Navigator] runs ONCE
  /// when it creates that route — so the root keeps forever whatever arguments it was first given,
  /// and `setState` here rebuilds this widget without ever rebuilding it. A value passed down as a
  /// constructor field would have been read on the first launch frame, when no machine had been
  /// linked, and never again.
  ///
  /// Handed over once, at construction, and written to afterwards: [AgentHome] listens, so a value
  /// set at any point reaches it. Never reset here — [AgentHome] spends the request itself, on the
  /// agent arriving or on a swipe away from it.
  final _linkedMachineId = ValueNotifier<String?>(null);

  /// A password was accepted: the agent is what the person came for, so the phone points itself at
  /// that machine.
  ///
  /// No waiting and no timeout here, which is what this used to be full of. The machine is still
  /// connecting at this point and [AgentHome] is already watching for exactly that — it holds
  /// whatever is on screen while the machine dials, then opens the first agent it reports.
  void _followLinkedMachine(String machineId) =>
      _linkedMachineId.value = machineId;

  /// An agent somebody picked — from search, the new-agent form, the attention list — for
  /// [AgentHome] to put on screen. A notifier for the reason [_linkedMachineId] is one.
  final _openAgentRequest =
      ValueNotifier<({String machineId, String agentId})?>(null);

  /// Opens an agent AS the home screen rather than on top of it.
  ///
  /// ⚠️ **This is what took the back button off the terminal.** A terminal pushed over search, or
  /// over the new-agent form, had a page under it, so its header drew a chevron back to a screen the
  /// person had finished with. The stack is emptied back to its root instead and the root terminal
  /// switches agent, so there is never anything to go back to.
  void _openAgentAtHome(String machineId, String agentId) {
    _navigator.currentState?.popUntil((route) => route.isFirst);
    // Reset first, so picking the agent already requested last time still notifies.
    _openAgentRequest.value = null;
    _openAgentRequest.value = (machineId: machineId, agentId: agentId);
    setState(() => _canPop = false);
  }

  /// A tapped "agent finished" notice: that agent, as the home screen — the
  /// dial's drawer row opening its agent.
  void _openNoticedAgent() {
    final opened = widget.notifier.agentNotices.system.opened;
    final agent = opened.value;
    if (agent == null) return;
    opened.value = null;
    _openAgentAtHome(agent.machineId, agent.agentId);
  }

  /// Back in the foreground: a p2p retry waiting out its delay fires now, and so does every machine
  /// socket the phone lost while it was away. Going to the background needs nothing — the OS
  /// suspends the socket, and the redial tears the old wire down and negotiates a fresh one.
  ///
  /// ⚠️ The two used to be one line, and the missing half showed. P2P was kicked here from the
  /// start; the WebSocket underneath it was not, so a phone coming back sat through a backoff that
  /// had already climbed to its 30s ceiling — the machine list saying "Connecting…" at somebody
  /// who was looking straight at it, with a network that would have answered at once.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      // The other half of the resume below: work that only makes sense in
      // front of somebody stops here. The sockets are not touched — the OS
      // suspends them, and the redial on the way back is what recovers them.
      widget.notifier.handleAppPaused();
      return;
    }
    if (state != AppLifecycleState.resumed) return;
    phoneTerminalP2p.kickRetry();
    widget.notifier.handleAppResumed();
  }

  /// Whether the stack has a page to go back to — what [PopScope] is given.
  ///
  /// Kept as state rather than read inline in `build`, because a push or pop inside a nested
  /// [Navigator] does not rebuild this widget: the flag has to be pushed here by the notification
  /// below, or `canPop` would answer with whatever was true when the shell last happened to build.
  bool _canPop = false;

  /// Android's back button: the stack's own pages first, then the system.
  ///
  /// The notification is used only as a SIGNAL that the stack moved, and the answer is then read
  /// from the navigator itself.
  bool _onNavigation(NavigationNotification notification) {
    _syncCanPop();
    // Let it keep bubbling: the root navigator above this shell tracks its own state from it.
    return false;
  }

  void _syncCanPop() {
    final next = _navigator.currentState?.canPop() ?? false;
    if (next == _canPop) return;
    // The notification arrives mid-build of the subtree that sent it, so defer rather than calling
    // setState inside another widget's build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final current = _navigator.currentState?.canPop() ?? false;
      if (current == _canPop) return;
      setState(() => _canPop = current);
    });
  }

  void _handleBack(bool didPop, Object? result) {
    if (didPop) return;
    _navigator.currentState?.maybePop().then((_) {
      if (mounted) _syncCanPop();
    });
  }

  @override
  Widget build(BuildContext context) => PhoneShellScope(
    onMachineLinked: _followLinkedMachine,
    onOpenAgent: _openAgentAtHome,
    child: ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) => PopScope<Object?>(
        // False while the stack has somewhere to go back to, so the gesture reaches [_handleBack]
        // instead of leaving the app. True at its root: the press then belongs to the system.
        canPop: !_canPop,
        onPopInvokedWithResult: _handleBack,
        child: NotificationListener<NavigationNotification>(
          onNotification: _onNavigation,
          child: Scaffold(
            // ⚠️ The nested navigator needs its OWN HeroController, and without this the
            // engine-mark flights simply never happen — silently, with no error.
            //
            // `MaterialApp` installs one controller for the ROOT navigator only; a nested
            // `Navigator` inherits nothing, so its routes have no observer to drive a flight.
            body: Column(
              children: [
                // A device this phone had never trusted joined the account (device key log).
                NewDeviceBanner(
                  notifier: widget.notifier,
                  navigator: _navigator,
                ),
                Expanded(
                  child: HeroControllerScope(
                    controller: _heroController,
                    child: Navigator(
                      key: _navigator,
                      // ⚠️ The controller goes in the SCOPE ONLY, never also in `observers`.
                      // `NavigatorState._updateEffectiveObservers` appends the scope's controller to
                      // `widget.observers` itself, so listing it here registers it twice and trips
                      // "A HeroController can not be shared by multiple Navigators" — which reads
                      // like a sharing bug and is really a double-subscription by one navigator.
                      onGenerateRoute: (_) => MaterialPageRoute<void>(
                        builder: (_) => AgentHome(
                          notifier: widget.notifier,
                          openMachineId: _linkedMachineId,
                          openAgent: _openAgentRequest,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
