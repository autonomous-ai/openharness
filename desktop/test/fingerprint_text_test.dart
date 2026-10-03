// A device's key code as the detail and the "This device" card show it: the exact string on the
// clipboard, a spelled-out label for a screen reader, and the comparison wording.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/fingerprint_text.dart';

const _fp = 'E2FB·0DF5·5FD8·E6C7';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  String? clipboard;
  var failCopy = false;

  setUp(() {
    clipboard = null;
    failCopy = false;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        if (failCopy) throw PlatformException(code: 'no-clipboard');
        clipboard = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });
  });
  tearDown(
    () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
  );

  Future<void> pump(WidgetTester tester) => tester.pumpWidget(
    const MaterialApp(
      home: Scaffold(body: FingerprintText(_fp, copyKey: Key('copy'))),
    ),
  );

  testWidgets('Copy puts the exact code on the clipboard and says so for 3 s', (
    tester,
  ) async {
    await pump(tester);
    expect(find.text(_fp), findsOneWidget);
    await tester.tap(find.byKey(const Key('copy')));
    await tester.pump();
    expect(clipboard, _fp);
    expect(find.text('Copied'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 2900));
    expect(find.text('Copied'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Copied'), findsNothing);
    expect(find.text('Copy'), findsOneWidget);
  });

  testWidgets('a clipboard that refuses says to try again', (tester) async {
    failCopy = true;
    await pump(tester);
    await tester.tap(find.byKey(const Key('copy')));
    await tester.pump();
    expect(clipboard, isNull);
    expect(find.text('Couldn’t copy. Try again'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('Copy'), findsOneWidget);
  });

  testWidgets(
    'a screen reader hears the code group by group, letter by letter',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await pump(tester);
      expect(
        find.bySemanticsLabel('Key code E 2 F B, 0 D F 5, 5 F D 8, E 6 C 7'),
        findsOneWidget,
      );
      semantics.dispose();
    },
  );

  test('the explanation names the device kind and, on a computer, the CLI', () {
    expect(
      fingerprintSpoken(_fp),
      'Key code E 2 F B, 0 D F 5, 5 F D 8, E 6 C 7',
    );
    expect(
      fingerprintHowToCompare(computer: false),
      'This device’s own key code. Open Your devices on that device — the code under “This device” must match.',
    );
    expect(
      fingerprintHowToCompare(computer: true),
      'This device’s own key code. Open Your devices on that computer — the code under “This device” must match — or run harness status on it.',
    );
  });
}
