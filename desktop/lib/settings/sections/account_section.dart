import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../../screens/login_screen.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/app_state.dart';
import 'saved_super_tabs_row.dart';

class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      final local = notifier.localManualFixture != null;
      final profile = notifier.currentUser;
      // A guest's row says what an account is FOR and offers it; the sheet opens
      // over Settings, which stays where it is — there is nothing to leave, and
      // the row rewrites itself the moment the account arrives.
      if (notifier.isGuest) {
        return SectionScaffold(
          title: 'Account',
          subtitle:
              'This computer works without one. An account adds your other '
              'machines, the shared desk and voice on the dial.',
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SettingRow(
                  title: 'Not signed in',
                  detail: 'Sign in to reach your other machines',
                  control: FilledButton(
                    key: const Key('settings-sign-in-button'),
                    // Straight back to the desk once the account lands.
                    // Settings is where the person WENT to sign in, not where
                    // they were going: leaving them on a row that now just
                    // says their email is the app asking them to find their
                    // own way out (owner, 2026-09-23). Sign out is the same
                    // shape, in reverse.
                    onPressed: () async {
                      final signedIn = await showSignInSheet(context, notifier);
                      if (signedIn && context.mounted) {
                        Navigator.of(context).pop();
                      }
                    },
                    child: const Text('Sign in'),
                  ),
                ),
              ],
            ),
          ),
        );
      }
      final account = SettingRow(
        // An account with no name is called by its email, and the email is
        // the line under it: signing up by email showed the address twice.
        title: profile != null && profile.displayName != profile.email
            ? profile.displayName
            : (local && profile == null ? 'Local session' : 'Signed in'),
        detail:
            profile?.email ??
            (local ? 'Loopback backend' : 'Profile unavailable'),
        control: OutlinedButton(
          key: const Key('settings-sign-out-button'),
          onPressed: () {
            Navigator.of(context).pop();
            notifier.logout();
          },
          child: Text(local ? 'Disconnect local session' : 'Sign out'),
        ),
      );
      return SectionScaffold(
        title: 'Account',
        subtitle: local
            ? 'Connected to a local development session.'
            // A browser is not "this computer" (docs/naming-system.md).
            : kIsWeb
            ? 'Your Harness sign-in in this browser.'
            : 'Your Harness sign-in on this computer.',
        child: SingleChildScrollView(
          // Only where Super Tabs are kept on this device (the web's) does
          // Account say so; Desktop keeps none and its page is as it was.
          child: notifier.superTabs.reading.drawsSaved
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    account,
                    const SizedBox(height: 12),
                    SavedSuperTabsRow(superTabs: notifier.superTabs),
                  ],
                )
              : account,
        ),
      );
    },
  );
}
