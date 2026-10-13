import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_menu.dart';
import 'desktop_chrome.dart';
import 'workspace_account_button.dart';

/// What the account menu was asked for.
enum AccountMenuChoice { addPhone, customize, notifications, settings, signOut }

/// The menu under the avatar: who is signed in, then Add Phone, Customize
/// Harness, Notifications, Settings and Sign out. Each opens something the app
/// already has; the caller does that once this has closed, so the two never
/// stand on screen together. Kept to these five (owner, 2026-10-11).
///
/// Drawn here rather than as a native menu, so the Mac — whose tab row is
/// native — and Linux get the same one. It hangs from the window's top-right
/// corner, under the row the avatar is in; [topInset] is that row's height
/// where this app draws it.
Future<AccountMenuChoice?> showAccountMenu(
  BuildContext context, {
  required String name,
  required String email,
  bool showAddPhone = true,
  double topInset = 0,
}) => showAppDialog<AccountMenuChoice>(
  context: context,
  veilTint: Colors.transparent,
  builder: (_) => AccountMenu(
    name: name,
    email: email,
    showAddPhone: showAddPhone,
    topInset: topInset,
  ),
);

class AccountMenu extends StatefulWidget {
  const AccountMenu({
    super.key,
    required this.name,
    required this.email,
    this.showAddPhone = true,
    this.topInset = 0,
  });

  /// As the account gives it; empty when it has only an email.
  final String name;
  final String email;

  /// Whether Add Phone is offered: not once the account has a phone.
  final bool showAddPhone;
  final double topInset;

  static const width = 264.0;

  @override
  State<AccountMenu> createState() => _AccountMenuState();
}

class _AccountMenuState extends State<AccountMenu> {
  final _focus = FocusNode(debugLabel: 'Account menu');

  late final _rows = [
    if (widget.showAddPhone)
      (AccountMenuChoice.addPhone, AppIcons.smartphone, 'Add Phone'),
    (AccountMenuChoice.customize, AppIcons.palette, 'Customize Harness'),
    (AccountMenuChoice.notifications, AppIcons.bell, 'Notifications'),
    (AccountMenuChoice.settings, AppIcons.settings, 'Settings'),
    (AccountMenuChoice.signOut, AppIcons.logOut, 'Sign out'),
  ];
  late final _rowFocus = [
    for (final (choice, _, _) in _rows)
      FocusNode(debugLabel: 'Account menu: ${choice.name}'),
  ];

  @override
  void initState() {
    super.initState();
    // The keys are the menu's from the frame it appears: `autofocus` alone
    // loses to the route's own first focus.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    for (final node in _rowFocus) {
      node.dispose();
    }
    super.dispose();
  }

  void _choose(AccountMenuChoice choice) => Navigator.of(context).pop(choice);

  /// Up and Down walk the rows, round and round. Opened, no row is lit — as a
  /// menu a pointer opened is — so the first Down lands on the first and the
  /// first Up on the last.
  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    final delta = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowDown => 1,
      LogicalKeyboardKey.arrowUp => -1,
      _ => 0,
    };
    if (delta == 0) return KeyEventResult.ignored;
    final current = _rowFocus.indexWhere((row) => row.hasPrimaryFocus);
    final next = current < 0
        ? (delta > 0 ? 0 : _rowFocus.length - 1)
        : (current + delta) % _rowFocus.length;
    _rowFocus[next].requestFocus();
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final name = widget.name;
    final email = widget.email;
    final title = name.isEmpty ? email : name;
    return DesktopChrome(
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): () =>
              Navigator.of(context).pop(),
        },
        child: LayoutBuilder(
          builder: (context, constraints) => Dialog(
            alignment: Alignment.topRight,
            insetPadding: EdgeInsets.fromLTRB(8, widget.topInset + 6, 8, 8),
            backgroundColor: Colors.transparent,
            surfaceTintColor: Colors.transparent,
            elevation: 0,
            constraints: BoxConstraints(
              maxWidth: math.min(
                AccountMenu.width,
                math.max(0, constraints.maxWidth - 16),
              ),
            ),
            child: DesktopDialogSurface(
              key: const ValueKey('account-menu'),
              radius: 12,
              elevation: 12,
              child: Semantics(
                scopesRoute: true,
                namesRoute: true,
                explicitChildNodes: true,
                label: 'Account',
                child: Focus(
                  focusNode: _focus,
                  autofocus: true,
                  onKeyEvent: _onKey,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(15, 8, 15, 10),
                          child: Row(
                            children: [
                              ExcludeSemantics(
                                child: AccountAvatar(
                                  initial: accountInitial(name, email),
                                  diameter: 34,
                                  accent: grid.AppPalette.swarmAccent,
                                ),
                              ),
                              const SizedBox(width: 11),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      title,
                                      key: const ValueKey('account-menu-name'),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: DesktopChrome.control(
                                        medium: true,
                                      ),
                                    ),
                                    // An account with no name says its email
                                    // once, not twice.
                                    if (name.isNotEmpty && email.isNotEmpty)
                                      Text(
                                        email,
                                        key: const ValueKey(
                                          'account-menu-email',
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.metadata(),
                                      ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                        const AppMenuDivider(),
                        for (final (index, (choice, icon, label))
                            in _rows.indexed) ...[
                          // Sign out stands apart from what opens something.
                          if (choice == AccountMenuChoice.signOut)
                            const AppMenuDivider(),
                          AppMenuItem(
                            key: ValueKey('account-menu-${choice.name}'),
                            focusNode: _rowFocus[index],
                            icon: icon,
                            label: label,
                            onPressed: () => _choose(choice),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
