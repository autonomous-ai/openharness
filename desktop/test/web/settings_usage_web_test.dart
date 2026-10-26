@TestOn('browser')
library;

// Settings ▸ Usage in a browser: the account's subscriptions, as the footer
// reads them from its computers, not an empty box. Audit finding P6.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/usage_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/empty_state.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_controller.dart';

/// The account's subscriptions as the computers answered, without asking any.
class _Subscriptions extends ModelsMenuController {
  _Subscriptions(this.answer)
    : super(usage: UsageController(autoStart: false, sources: const []));

  final List<Map<String, Object?>> answer;
  var refreshes = 0;

  @override
  List<Map<String, Object?>> get rows => answer;

  @override
  Future<void> refresh() async => refreshes++;
}

Map<String, Object?> _claude({required num left}) => {
  'title': 'Claude',
  'account': 'sam@example.com',
  'accountKey': 'k1',
  'local': false,
  'machines': ['Studio Mac'],
  'status': '$left% remaining',
  'remainingPercent': left,
  'details': ['Resets in 3 hours'],
  'engine': 'claude',
};

void main() {
  Future<_Subscriptions> mount(
    WidgetTester tester,
    List<Map<String, Object?>> rows,
  ) async {
    final subscriptions = _Subscriptions(rows);
    addTearDown(subscriptions.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(body: UsageSection(subscriptions: subscriptions)),
      ),
    );
    return subscriptions;
  }

  testWidgets('shows each subscription with what is left and where', (
    tester,
  ) async {
    final subscriptions = await mount(tester, [_claude(left: 62)]);
    expect(subscriptions.refreshes, 1);
    expect(find.text('Claude Code'), findsOneWidget);
    // The figure once, at the row's end; the detail keeps only what it adds.
    expect(find.textContaining('62%'), findsOneWidget);
    expect(find.text('62%'), findsOneWidget);
    expect(find.textContaining('Studio Mac'), findsOneWidget);
    expect(find.textContaining('sam@example.com'), findsOneWidget);
    expect(find.textContaining('Start your first harness'), findsNothing);
  });

  testWidgets('running low says so beside the figure, without repeating it', (
    tester,
  ) async {
    await mount(tester, [_claude(left: 14)]);
    expect(find.textContaining('14%'), findsOneWidget);
    expect(find.textContaining('Running low'), findsOneWidget);
  });

  testWidgets('with none yet, says so instead of an empty box', (
    tester,
  ) async {
    await mount(tester, const []);
    expect(
      find.widgetWithText(EmptyState, 'No subscriptions yet'),
      findsOneWidget,
    );
    expect(find.textContaining('Start your first harness'), findsNothing);
  });
}
