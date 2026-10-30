import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import 'desktop_chrome.dart';
import 'pane_menu.dart';
import 'workspace_account_button.dart';

/// What the account menu was asked for.
enum AccountMenuChoice { addPhone, customize, notifications, settings, signOut }

/// The menu under the avatar: who is signed in, then Add Phone, Appearance,
/// Notifications, Settings and Sign out. Each opens something the app
/// already has; the caller does that once this has closed, so the two never
/// stand on screen together. Kept to these five (owner, 2026-10-11).
///
/// Drawn here rather than as a native menu, so the Mac — whose tab row is
/// native — and Linux get the same one. It hangs from the window's top-right
/// corner, under the row the avatar is in; [topInset] is that row's height
/// where this app draws it.
///
/// A titlebar dropdown ([showPaneMenu]): an overlay with no veil, so a click
/// outside closes it and lands where it was aimed, and it never holds the
/// titlebar. Each opening is fresh: no row is lit unless [focusFirst] (a key
/// opened it).
Future<AccountMenuChoice?> showAccountMenu(
  BuildContext context, {
  required String name,
  required String email,
  double topInset = 0,
  bool focusFirst = false,
  void Function(void Function() close)? onOpen,
  bool Function(Offset position)? ownsPointer,
}) => showPaneMenu<AccountMenuChoice>(
  context: context,
  position: RelativeRect.fromLTRB(0, topInset + 6, 8, 0),
  minWidth: AccountMenu.width,
  maxWidth: AccountMenu.width,
  focusFirst: focusFirst,
  onOpen: onOpen == null ? null : (_, close) => onOpen(close),
  ownsPointer: ownsPointer,
  body: (close) => AccountMenu(name: name, email: email, onChoose: close),
);

class AccountMenu extends StatelessWidget {
  const AccountMenu({
    super.key,
    required this.name,
    required this.email,
    required this.onChoose,
  });

  /// As the account gives it; empty when it has only an email.
  final String name;
  final String email;
  final void Function(AccountMenuChoice? choice) onChoose;

  static const width = 264.0;

  // Add Phone stays once the account has a phone: a second one is added the
  // same way, and a row that was there at the first opening and gone at the
  // next read as a fault (1.2.64 learned of the phone only when the menu opened).
  static const _rows = [
    (AccountMenuChoice.addPhone, AppIcons.smartphone, 'Add Phone'),
    (AccountMenuChoice.customize, AppIcons.palette, 'Appearance'),
    (AccountMenuChoice.notifications, AppIcons.bell, 'Notifications'),
    (AccountMenuChoice.settings, AppIcons.settings, 'Settings'),
    (AccountMenuChoice.signOut, AppIcons.logOut, 'Sign out'),
  ];

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final title = name.isEmpty ? email : name;
    // The pane menu's surface draws the one rim; Escape, the arrows and
    // where the keyboard goes are its too.
    return DesktopChrome(
      child: Semantics(
        key: const ValueKey('account-menu'),
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: 'Account',
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
                            style: DesktopChrome.control(medium: true),
                          ),
                          // An account with no name says its email once, not
                          // twice.
                          if (name.isNotEmpty && email.isNotEmpty)
                            Text(
                              email,
                              key: const ValueKey('account-menu-email'),
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
              for (final (choice, icon, label) in _rows) ...[
                // Sign out stands apart from what opens something.
                if (choice == AccountMenuChoice.signOut) const AppMenuDivider(),
                AppMenuItem(
                  key: ValueKey('account-menu-${choice.name}'),
                  icon: icon,
                  label: label,
                  onPressed: () => onChoose(choice),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
