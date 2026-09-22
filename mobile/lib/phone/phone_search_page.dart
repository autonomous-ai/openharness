import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart';
import 'phone_search_actions.dart';
import 'phone_search_commands.dart';
import 'phone_search_controller.dart';
import 'phone_search_field.dart';
import 'phone_search_results.dart';
import 'phone_search_scope_bar.dart';

/// One query over every agent, machine and project the account can reach.
///
/// A screen of its own rather than a field above either list, and that is the
/// whole point: the two tabs each answer half the question, and somebody who
/// remembers "that review thing" does not know which half holds it.
///
/// This is the phone's version of the desktop's box, mode for mode —
/// [PhoneSearchController] carries `>` commands, `#` projects, `@` machines and
/// `?` help, and ranks with the desktop's own scorer, so a query that finds an
/// agent on the laptop finds the same agent here.
///
/// ⚠️ Keystrokes never ask a machine anything. They filter what the app already
/// holds, so typing on two bars of signal stays instant.
///
/// Returns when the search closes, so a caller whose own chrome depends on
/// being the top route can rebuild — see `terminal_page.dart`, where the header
/// buttons hide behind a keyboard this page did not raise.
Future<void> openPhoneSearch(BuildContext context, AppNotifier notifier) =>
    Navigator.of(
      context,
    ).push(phoneRoute((_) => PhoneSearchPage(notifier: notifier)));

class PhoneSearchPage extends StatefulWidget {
  const PhoneSearchPage({
    super.key,
    required this.notifier,
    this.commands,
  });

  final AppNotifier notifier;

  /// What `>` offers. Defaults to [phoneSearchCommands], the app's real set;
  /// overridden by tests, which must not push the real Settings screen to find
  /// out whether a command ran.
  final List<PhoneCommand> Function()? commands;

  @override
  State<PhoneSearchPage> createState() => _PhoneSearchPageState();
}

class _PhoneSearchPageState extends State<PhoneSearchPage> {
  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Phone search');
  late final PhoneSearchController _search = PhoneSearchController(
    notifier: widget.notifier,
    history: widget.notifier.searchHistory,
    commands:
        widget.commands ??
        () => phoneSearchCommands(context, widget.notifier),
  );

  @override
  void initState() {
    super.initState();
    // The order the box opens in comes off disk. Not awaited: what is known
    // draws now, and the visits fold in a frame later, before anything has been
    // read let alone tapped.
    widget.notifier.searchHistory.load().then((_) {
      if (mounted) _search.setQuery(_search.query);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    _search.dispose();
    super.dispose();
  }

  /// Back leaves the chosen project or machine first, and only then the screen —
  /// the same step `#`/`@` took to get in.
  void _back() {
    if (_search.back()) {
      _controller.text = _search.query;
      return;
    }
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      // The keyboard is up for this page's whole life, so the body must shrink
      // rather than let the list run underneath it.
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        bottom: false,
        child: PopScope(
          canPop: !_search.canGoBack,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _back();
          },
          child: Column(
            children: [
              ListenableBuilder(
                listenable: _search,
                builder: (context, _) => PhoneSearchField(
                  controller: _controller,
                  focus: _focus,
                  hintText: _search.hint,
                  onChanged: _search.setQuery,
                  onClear: () {
                    _controller.clear();
                    _search.setQuery('');
                    // Clearing is a step back into browsing, not out of the
                    // screen — the caret stays where the next query will go.
                    _focus.requestFocus();
                  },
                  onBack: _back,
                ),
              ),
              PhoneSearchScopeBar(search: _search),
              Expanded(
                child: PhoneSearchResults(
                  notifier: widget.notifier,
                  controller: _search,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
