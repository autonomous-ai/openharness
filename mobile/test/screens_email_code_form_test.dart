import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/screens/email_code_form.dart';

/// The phone's sign-in form: an email, then the four-digit code — no browser.
void main() {
  late List<String> sentTo;
  late List<(String, String)> signedIn;
  Object? refuseCode;

  Future<void> pumpForm(WidgetTester tester) async {
    sentTo = [];
    signedIn = [];
    refuseCode = null;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: EmailCodeForm(
            sendCode: (email) async => sentTo.add(email),
            signIn: (email, code) async {
              if (refuseCode case final error?) throw error;
              signedIn.add((email, code));
            },
          ),
        ),
      ),
    );
  }

  Future<void> askForCode(WidgetTester tester) async {
    await tester.enterText(find.byKey(const Key('login-email')), ' a@b.co ');
    await tester.tap(find.text('Email me a code'));
    await tester.pump();
  }

  testWidgets('an email is asked for, then its code signs in', (tester) async {
    await pumpForm(tester);
    await askForCode(tester);

    expect(sentTo, ['a@b.co']);
    expect(find.text('We emailed a sign-in code to a@b.co.'), findsOneWidget);

    // The fourth digit signs in on its own.
    await tester.enterText(find.byKey(const Key('login-code')), '1234');
    await tester.pump();
    expect(signedIn, [('a@b.co', '1234')]);
    await tester.pump(EmailCodeForm.resendAfter);
  });

  testWidgets('something that is not an email is not sent', (tester) async {
    await pumpForm(tester);
    await tester.enterText(find.byKey(const Key('login-email')), 'nope');
    await tester.tap(find.text('Email me a code'));
    await tester.pump();

    expect(sentTo, isEmpty);
    expect(
      find.text('Enter the email of your Autonomous account.'),
      findsOneWidget,
    );
  });

  testWidgets('a wrong code is said under the field, which stays', (
    tester,
  ) async {
    await pumpForm(tester);
    await askForCode(tester);
    refuseCode = 'Invalid OTP';

    await tester.enterText(find.byKey(const Key('login-code')), '9999');
    await tester.pump();

    expect(find.text('Invalid OTP'), findsOneWidget);
    expect(find.byKey(const Key('login-code')), findsOneWidget);
    await tester.pump(EmailCodeForm.resendAfter);
  });

  testWidgets('a code can be sent again only after the wait', (tester) async {
    await pumpForm(tester);
    await askForCode(tester);
    expect(find.text('Resend in 30s'), findsOneWidget);

    await tester.pump(EmailCodeForm.resendAfter);
    await tester.tap(find.text('Resend code'));
    await tester.pump();
    expect(sentTo, ['a@b.co', 'a@b.co']);
    await tester.pump(EmailCodeForm.resendAfter);
  });

  testWidgets('a different email goes back to the first step', (tester) async {
    await pumpForm(tester);
    await askForCode(tester);
    await tester.tap(find.text('Use a different email'));
    await tester.pump();
    expect(find.byKey(const Key('login-email')), findsOneWidget);
  });
}
