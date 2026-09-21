import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/link_machine_screen.dart';

import 'phone_header.dart';
import 'phone_shell_scope.dart';

/// A machine's password form, as a phone page — the same [LinkMachineScreen] the desktop pops
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

  /// Whether this form is a PAGE INSIDE something else — [MachinePage] in the machine pager — rather
  /// than a route of its own.
  ///
  /// ⚠️ **It turns off every navigation this page does, and it has to.** The route belongs to the
  /// pager, not to this page: a `pushReplacement` here would swap out the PAGER and take the swipe
  /// with it, and a `maybePop` would drop the person back to the tab from a page they were only
  /// swiping past. Embedded, the page just draws the form; the builder above it watches the same
  /// `needsLink` and puts the agents there the moment the link lands.
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
    // ⚠️ Embedded, mounting is NOT somebody asking. A pager builds the pages either side of the one
    // on screen, so this would clear the dismissal of a machine nobody has opened — reopening a form
    // that was Closed, one page over, out of sight. There the mark is [MachinePage]'s to read and the
    // "Enter password" button's to clear, and both act on the machine actually being looked at.
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
    // Embedded, there is nowhere for this page to go: [MachinePage] rebuilds off the same notifier
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
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final machine = widget.notifier.stateOf(widget.machineId);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        child: Column(
          children: [
            PhoneHeader(
              title: machine?.machine.displayName ?? 'Machine',
              subtitle: Text(
                'Enter the password set on this machine',
                style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
              ),
            ),
            if (machine != null)
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  child: LinkMachineScreen(
                    notifier: widget.notifier,
                    machineState: machine,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
