import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/account_menu.dart';

/// The running version, one quiet line under the account menu's last row
/// (task #2185, Huy's mockup). Only the web build says one: Desktop's menu is
/// as it was.
void main() {
  Future<void> open(WidgetTester tester, {String? version}) =>
      tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: AccountMenu(
              name: 'Huy',
              email: 'huy@example.com',
              onChoose: (_) {},
              version: version,
            ),
          ),
        ),
      );

  testWidgets('the web build says which version is running', (tester) async {
    await open(tester, version: '1.3.51');
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('account-menu-version')))
          .data,
      'Harness 1.3.51',
    );
    // Under Sign out, the menu's last row.
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('account-menu-version'))).dy,
      greaterThan(
        tester
                .getBottomLeft(
                  find.byKey(const ValueKey('account-menu-signOut')),
                )
                .dy -
            1,
      ),
    );
  });

  testWidgets('a build that says none shows no such line (Desktop)', (
    tester,
  ) async {
    await open(tester);
    expect(find.byKey(const ValueKey('account-menu-version')), findsNothing);
    expect(find.byKey(const ValueKey('account-menu-signOut')), findsOneWidget);
  });
}
