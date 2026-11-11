import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_shell_scope.dart';
import 'settings_page.dart' show PhoneSettingsButton;
import 'tty.dart';
import 'tty_controls.dart';
import 'welcome/unlock_computer.dart';

/// A machine's password form, as a phone page — the form the desktop's `LinkMachineScreen` pops
/// up, since the exchange behind it is the same.
///
/// It leaves by itself either way — once the link lands, and when the form's own Close is pressed —
/// unless it is [embedded], where moving on is somebody else's job.
class LinkPage extends StatefulWidget {
  const LinkPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.embedded = false,
  });

  final AppNotifier notifier;
  final String machineId;

  /// Whether this form is drawn INSIDE another page — [AgentHome], when the account's one machine
  /// needs its password — rather than being a route of its own.
  ///
  /// ⚠️ **It turns off every navigation this page does, and it has to.** The route belongs to the
  /// page around the form, not to the form: a `pushReplacement` here would swap out the home
  /// screen itself, and a `maybePop` has nothing behind it to go back to. Embedded, the page just
  /// draws the form; the builder above it watches the same `needsLink` and puts the agents there
  /// the moment the link lands.
  final bool embedded;

  @override
  State<LinkPage> createState() => _LinkPageState();
}

class _LinkPageState extends State<LinkPage> {
  /// The form's Close marks the prompt dismissed. One already dismissed before this page opened
  /// must not shut the page on its first frame.
  ///
  /// Always false in practice on a pushed page, now that [initState] clears the mark — kept as the
  /// guard it is, so the rule below still reads on its own if that ever stops being true. An
  /// embedded page never reaches it: [_follow] is not even subscribed there.
  late final bool _dismissedBefore = widget.notifier.isLinkPromptDismissed(
    widget.machineId,
  );
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    // Opening this page IS the person asking for the form — the machine tile, the padlock empty
    // state, the machine sheet's "Re-enter password…". Without clearing the mark, a machine whose
    // form was Closed once could never be reached again: [_follow] reads the mark on its first
    // run and pops the page on the frame it opened. The desktop fixes the same bug the same way
    // (`revisitLinkPrompt`, 051ea5b), where the reactive gates check the mark before calling.
    //
    // ⚠️ Embedded, mounting is NOT somebody asking: the page around the form put it up by itself,
    // so the mark is that page's to read and clear, not this form's.
    if (!widget.embedded) {
      widget.notifier.revisitLinkPrompt(widget.machineId);
      widget.notifier.addListener(_follow);
    }
  }

  @override
  void dispose() {
    widget.notifier.removeListener(_follow);
    super.dispose();
  }

  void _follow() {
    // Embedded, there is nowhere for this page to go: [AgentHome] rebuilds off the same notifier
    // and swaps the form for the agents itself. Listening at all would only risk the pops below.
    if (widget.embedded || _leaving || !mounted) return;
    final machine = widget.notifier.stateOf(widget.machineId);
    final navigator = Navigator.of(context);
    if (machine != null && !machine.needsLink) {
      // Linked: this form is finished, so it leaves. It used to `pushReplacement` its way to that
      // machine's agent list, which is the navigation the Machines tab no longer does — agents
      // belong to the Agents tab, where the machine is a filter rather than a step. Going back is
      // what shows the result: the row this was opened from is now under "Linked".
      //
      // …and then the shell carries on to the agent, which is what the password was for. Read
      // before the pop: once the route starts leaving, this context is on its way out.
      final shell = PhoneShellScope.maybeOf(context);
      _leaving = true;
      navigator.maybePop();
      shell?.onMachineLinked(widget.machineId);
      return;
    }
    final closed =
        !_dismissedBefore &&
        widget.notifier.isLinkPromptDismissed(widget.machineId);
    if (machine == null || closed) {
      _leaving = true;
      navigator.maybePop();
      return;
    }
    // Waiting for its key, or done waiting: the page swaps between the wait and the form.
    final awaiting = machine.awaitingKey;
    if (awaiting != _awaiting) setState(() => _awaiting = awaiting);
  }

  /// What [build] last drew: the wait for the machine's key ([MachineState.awaitingKey]).
  late bool _awaiting =
      widget.notifier.stateOf(widget.machineId)?.awaitingKey ?? false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final machine = widget.notifier.stateOf(widget.machineId);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!widget.embedded)
              Align(
                alignment: Alignment.centerLeft,
                child: TtyBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              )
            else
              // Embedded, this form IS the home screen — the account's one computer, locked — and
              // the person on it may be on the wrong account: Settings, and its Sign out, from here.
              Align(
                alignment: Alignment.centerRight,
                child: PhoneSettingsButton(notifier: widget.notifier),
              ),
            // Its key not in the account's log yet: it comes in by itself, so no QR and no password
            // are asked for — only once the wait has run out ([MachineState.keyAwaitLimit]).
            if (machine != null && machine.awaitingKey)
              Expanded(child: _AwaitingKey(name: machine.machine.displayName))
            else if (machine != null)
              Expanded(
                child: UnlockComputer(
                  notifier: widget.notifier,
                  machineState: machine,
                  // Home, not a pushed page: nothing pops here, so the shell is told — and it
                  // carries on to the harnesses, or to New when there are none.
                  onUnlocked: widget.embedded
                      ? () =>
                            PhoneShellScope.maybeOf(context)
                                ?.onMachineLinked(widget.machineId)
                      : null,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// While [name]'s key is not in the account's device log yet ([MachineState.awaitingKey]): what
/// the password form would have stood for, said as the wait it is. It goes by itself, to the
/// agents once the key lands, to the form if it never does.
class _AwaitingKey extends StatelessWidget {
  const _AwaitingKey({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ListView(
      key: const Key('link-awaiting-key'),
      padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 24),
      children: [
        Text(
          'Connecting to $name',
          style: tty.style(size: 24, weight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        Text(
          '$name is setting up its secure link to your account. It opens here by itself in a '
          'moment: nothing to scan or type.',
          style: tty.style(size: TtySize.row, color: tty.faint),
        ),
        const SizedBox(height: 24),
        ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: LinearProgressIndicator(
            minHeight: 6,
            color: tty.green,
            backgroundColor: tty.green.withValues(alpha: 0.18),
          ),
        ),
      ],
    );
  }
}
