import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/phone_sign_in.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/qr_code_view.dart';
import 'package:harness/widgets/approval_sign_in_panel.dart';
import 'package:harness/widgets/sign_in_step.dart';

import 'support/capture.dart';

/// What the first-run page shows in place of its ways in while a phone scans its QR or another
/// device takes its code: the QR or the code, where to go on the other device, when a new one
/// comes, and then whose account approved it. `HARNESS_SIGN_IN_CAPTURE_DIR` writes what it draws.
final _boundary = GlobalKey();

Future<void> _mount(
  WidgetTester tester,
  Widget panel, {
  Size size = const Size(1280, 800),
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      // On the page itself, as a person sees it.
      home: RepaintBoundary(
        key: _boundary,
        child: SignInStep(onSignIn: (_) {}, onApprove: (_) {}, approval: panel),
      ),
    ),
  );
  await tester.pump();
}

Future<void> _capture(WidgetTester tester, String name) => captureBoundary(
  tester,
  _boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary,
  Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR'],
  name,
);

ApprovalSignInPanel _panel({
  ApprovalSignIn method = ApprovalSignIn.code,
  String? qrLink,
  String? code,
  DateTime? refreshAt,
  String? confirmEmail,
  String? previousEmail,
  ValueChanged<bool>? onConfirm,
  VoidCallback? onCancel,
}) => ApprovalSignInPanel(
  method: method,
  qrLink: qrLink,
  code: code,
  refreshAt: refreshAt,
  confirmEmail: confirmEmail,
  previousEmail: previousEmail,
  onConfirm: onConfirm ?? (_) {},
  onCancel: onCancel ?? () {},
);

const _link =
    'https://harness.autonomous.ai/signin#k=hnq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

void main() {
  setUpAll(
    () => loadCaptureFonts(Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR']),
  );

  testWidgets('the code, where to type it on a phone or a computer, and when '
      'a new one comes', (tester) async {
    var cancels = 0;
    await _mount(
      tester,
      _panel(
        code: '12345678',
        refreshAt: clock.now().add(const Duration(minutes: 9, seconds: 45)),
        onCancel: () => cancels++,
      ),
    );
    // Split in two, the way the CLI says it, so it reads and types in halves.
    expect(find.text('1234 5678'), findsOneWidget);
    expect(
      find.text(
        'Harness ▸ Settings ▸ Sign in a computer ▸ Type a code instead',
      ),
      findsOneWidget,
    );
    expect(find.text('Machines ▸ Approve a device'), findsOneWidget);
    expect(find.text('New code in 9:45'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('New code in 9:44'), findsOneWidget);
    // No QR on this path.
    expect(find.byType(QrCodeView), findsNothing);

    await tester.tap(find.text('Cancel'));
    expect(cancels, 1);
  });

  testWidgets('Copy puts the code itself on the clipboard, and says so for '
      'that code only', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final refreshAt = clock.now().add(const Duration(minutes: 5));
    await _mount(tester, _panel(code: '12345678', refreshAt: refreshAt));
    await tester.tap(find.byKey(const Key('sign-in-code-copy')));
    await tester.pump();
    expect(copied, ['12345678']);
    expect(find.text('Copied'), findsOneWidget);

    // A new code: the old one's "Copied" does not speak for it.
    await _mount(tester, _panel(code: '87654321', refreshAt: refreshAt));
    expect(find.text('Copied'), findsNothing);
    expect(find.text('Copy'), findsOneWidget);
  });

  testWidgets('the QR, and where to go on the phone', (tester) async {
    await _mount(
      tester,
      _panel(
        method: ApprovalSignIn.phone,
        qrLink: _link,
        refreshAt: clock.now().add(const Duration(seconds: 45)),
      ),
    );
    expect(find.byKey(const Key('login-phone-qr')), findsOneWidget);
    expect(
      find.text('On your phone: Harness ▸ Settings ▸ Sign in a computer'),
      findsOneWidget,
    );
    expect(find.text('New code in 0:45'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
  });

  testWidgets('before the CLI has a code: getting one, with Cancel', (
    tester,
  ) async {
    await _mount(tester, _panel());
    expect(find.text('Getting a code…'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    expect(find.textContaining('New code in'), findsNothing);
    await _mount(tester, _panel(method: ApprovalSignIn.phone));
    expect(find.text('Getting a QR code…'), findsOneWidget);
  });

  testWidgets('a code whose refresh is due says a new one is coming, never a '
      'negative time', (tester) async {
    await _mount(
      tester,
      _panel(
        code: '12345678',
        refreshAt: clock.now().add(const Duration(seconds: 1)),
      ),
    );
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('Getting a new code…'), findsOneWidget);
    expect(find.textContaining('-'), findsNothing);
  });

  testWidgets(
    'approved elsewhere: whose account, before anything is signed in',
    (tester) async {
      final answers = <bool>[];
      await _mount(
        tester,
        _panel(
          code: '12345678',
          confirmEmail: 'dee@example.com',
          onConfirm: answers.add,
        ),
      );
      expect(find.text('Sign in as dee@example.com?'), findsOneWidget);
      expect(
        find.text('Continue only if this is your account.'),
        findsOneWidget,
      );
      // The code is no longer shown: it has done its work.
      expect(find.text('1234 5678'), findsNothing);
      await tester.tap(find.byKey(const Key('login-phone-continue')));
      await tester.tap(find.byKey(const Key('login-phone-refuse')));
      expect(answers, [true, false]);

      await _mount(
        tester,
        _panel(
          confirmEmail: 'dee@example.com',
          previousEmail: 'ken@example.com',
        ),
      );
      expect(
        find.text(
          'This computer was signed in as ken@example.com. Continue only if dee@example.com is yours.',
        ),
        findsOneWidget,
      );
    },
  );

  for (final brightness in Brightness.values) {
    for (final (size, scale) in const [
      (Size(1280, 800), 1.0),
      (Size(880, 560), 1.0),
      (Size(880, 560), 2.0),
    ]) {
      final tag =
          '${brightness.name}-${size.width.round()}'
          '${scale == 1.0 ? '' : '-text-${(scale * 100).round()}'}';
      testWidgets('draws the scan, the code and the account question in $tag '
          'without overflow', (tester) async {
        final refreshAt = clock.now().add(
          const Duration(minutes: 9, seconds: 45),
        );
        final states = {
          'scan': _panel(
            method: ApprovalSignIn.phone,
            qrLink: _link,
            refreshAt: refreshAt,
          ),
          'code': _panel(code: '12345678', refreshAt: refreshAt),
          'confirm': _panel(code: '12345678', confirmEmail: 'dee@example.com'),
        };
        for (final MapEntry(key: name, value: panel) in states.entries) {
          await _mount(
            tester,
            panel,
            size: size,
            brightness: brightness,
            textScale: scale,
          );
          expect(tester.takeException(), isNull, reason: name);
          await _capture(tester, 'sign-in-step-$name-$tag');
        }
      });
    }
  }
}
