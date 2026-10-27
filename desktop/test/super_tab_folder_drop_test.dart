// Folders dropped on a Swarm chat's composer: their paths go into the message
// at the cursor, dropped files still attach, and when the chat's agents run on
// another computer the box says so and offers the folder as a zip instead.
import 'dart:async';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final hint = find.byKey(const ValueKey('super-folder-path-hint'));
  final surface = find.byKey(const ValueKey('super-message-composer-surface'));

  late Directory root;
  late ConversationServer server;
  setUp(() => root = Directory.systemTemp.createTempSync('swarm-folder-drop'));
  tearDown(() => root.deleteSync(recursive: true));

  /// A real folder under [root], so the drop can tell it from a file.
  Directory folder(String name) =>
      Directory('${root.path}/$name')..createSync();

  /// The chat's one agent runs on [machineId]; this computer is `here`.
  Future<SuperTabController> open(
    WidgetTester tester, {
    String machineId = 'here',
  }) async {
    // One logical pixel per device pixel, so the platform's drop position
    // needs no scaling on any host.
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetDevicePixelRatio);
    server = ConversationServer();
    (server.state['agents'] as List).add({
      'id': 'lead-agent',
      'name': 'Lead',
      'displayName': 'Atlas',
      'machineId': machineId,
      'harnessId': 'native-lead',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    });
    (server.state['conversations'] as List)[0]
      ..['leadId'] = 'lead-agent'
      ..['agentIds'] = ['lead-agent'];
    final controller = server.controller();
    await controller.refresh();
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
            isThisComputer: (machine) => machine == 'here',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  Future<void> platform(String method, Object arguments) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            'desktop_drop',
            const StandardMethodCodec().encodeMethodCall(
              MethodCall(method, arguments),
            ),
            (_) {},
          );

  /// Lets files be read and the zip's isolate answer, a frame at a time,
  /// until [done].
  Future<void> settle(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();
    }
    await tester.pumpAndSettle();
  }

  /// Drops on the composer: [method] and [arguments] as the platform sends
  /// them, then waits [until] the drop has landed. The drop is delivered on
  /// the test's clock, as the composer's other work is, never inside
  /// `runAsync`: a drop handled there leaves frames on the real clock, and a
  /// later isolate then never lets the test finish.
  Future<void> dropAs(
    WidgetTester tester,
    String method,
    Object arguments, {
    required bool Function() until,
  }) async {
    final inside = tester.getCenter(surface);
    await platform('entered', [inside.dx, inside.dy]);
    await tester.pump();
    await platform(method, arguments);
    await settle(tester, until);
  }

  /// Drops [paths] the way Linux and Windows report them: paths alone, a
  /// folder not told apart from a file.
  Future<void> drop(
    WidgetTester tester,
    List<String> paths, {
    required bool Function() until,
  }) => dropAs(tester, 'performOperation', paths, until: until);

  TextEditingController field(WidgetTester tester) =>
      tester.widget<TextField>(composer).controller!;

  List<String> names(SuperTabController c) => [
    for (final file in c.attachments('lead').files) file.name,
  ];

  testWidgets('a dropped folder puts its path at the cursor', (tester) async {
    final controller = await open(tester);
    final docs = folder('docs');
    await tester.enterText(composer, 'see please');
    field(tester).selection = const TextSelection.collapsed(offset: 4);

    await drop(tester, [
      docs.path,
    ], until: () => field(tester).text.contains(docs.path));

    expect(field(tester).text, 'see ${docs.path} please');
    expect(
      field(tester).selection,
      TextSelection.collapsed(offset: 'see ${docs.path} '.length),
    );
    expect(controller.draft('lead'), 'see ${docs.path} please');
    expect(names(controller), isEmpty);
    await close(tester, controller);
  });

  testWidgets('several folders go in space-separated, quoted when a path has '
      'a space', (tester) async {
    final controller = await open(tester);
    final plain = folder('plain'), spaced = folder('my notes');
    await tester.enterText(composer, 'Read');

    await drop(tester, [
      plain.path,
      spaced.path,
    ], until: () => field(tester).text.contains(spaced.path));

    expect(field(tester).text, 'Read ${plain.path} "${spaced.path}" ');
    await close(tester, controller);
  });

  testWidgets('a folder macOS marks as one pastes its path too', (
    tester,
  ) async {
    final controller = await open(tester);
    // A folder that is gone by now: macOS's own word that it is a folder is
    // enough, nothing is read from it.
    await dropAs(tester, 'performOperation_macos', [
      {'path': '/Volumes/Work/project', 'isDirectory': true},
    ], until: () => field(tester).text.isNotEmpty);

    expect(field(tester).text, '/Volumes/Work/project ');
    expect(names(controller), isEmpty);
    await close(tester, controller);
  });

  testWidgets('a dropped file still attaches and leaves the text alone', (
    tester,
  ) async {
    final controller = await open(tester);
    final log = File('${root.path}/trace.log')..writeAsStringSync('boom');
    await tester.enterText(composer, 'Here');

    await drop(tester, [log.path], until: () => names(controller).isNotEmpty);

    expect(names(controller), ['trace.log']);
    expect(field(tester).text, 'Here');
    await close(tester, controller);
  });

  testWidgets('a mixed drop attaches the files and pastes the folder paths', (
    tester,
  ) async {
    final controller = await open(tester);
    final log = File('${root.path}/trace.log')..writeAsStringSync('boom');
    final src = folder('src');

    await drop(
      tester,
      [log.path, src.path],
      until: () =>
          names(controller).isNotEmpty && field(tester).text.isNotEmpty,
    );

    expect(names(controller), ['trace.log']);
    expect(field(tester).text, '${src.path} ');
    await close(tester, controller);
  });

  testWidgets('no hint when the chat\'s agents are on this computer', (
    tester,
  ) async {
    final controller = await open(tester);

    await drop(tester, [
      folder('src').path,
    ], until: () => field(tester).text.isNotEmpty);

    expect(hint, findsNothing);
    await close(tester, controller);
  });

  testWidgets('the hint says the path is here when the chat\'s agents are '
      'elsewhere, and goes with the path', (tester) async {
    final controller = await open(tester, machineId: 'studio');

    await drop(tester, [
      folder('src').path,
    ], until: () => field(tester).text.isNotEmpty);

    expect(hint, findsOneWidget);
    expect(
      find.descendant(
        of: hint,
        matching: find.text(
          "This path is on this computer. Agents on other computers can't "
          'open it.',
        ),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: hint, matching: find.text('Attach as zip')),
      findsOneWidget,
    );

    await tester.enterText(composer, 'never mind');
    await tester.pump();
    expect(hint, findsNothing);
    await close(tester, controller);
  });

  testWidgets('a folder dropped twice is still one path to zip', (
    tester,
  ) async {
    final controller = await open(tester, machineId: 'studio');
    final src = folder('src');
    File('${src.path}/main.dart').writeAsStringSync('void main() {}');
    await drop(tester, [
      src.path,
    ], until: () => field(tester).text.contains(src.path));
    await drop(
      tester,
      [src.path],
      until: () =>
          field(tester).text.indexOf(src.path) !=
          field(tester).text.lastIndexOf(src.path),
    );

    expect(
      find.descendant(
        of: hint,
        matching: find.text(
          "This path is on this computer. Agents on other computers can't "
          'open it.',
        ),
      ),
      findsOneWidget,
    );
    await close(tester, controller);
  });

  testWidgets('Attach as zip takes the path out and attaches the folder', (
    tester,
  ) async {
    final controller = await open(tester, machineId: 'studio');
    final src = folder('src');
    File('${src.path}/main.dart').writeAsStringSync('void main() {}');
    Directory('${src.path}/lib').createSync();
    File('${src.path}/lib/a.dart').writeAsStringSync('// a');
    await tester.enterText(composer, 'Look at');
    await drop(tester, [
      src.path,
    ], until: () => field(tester).text.contains(src.path));
    expect(field(tester).text, 'Look at ${src.path} ');

    await tester.tap(find.text('Attach as zip'));
    await settle(tester, () => names(controller).isNotEmpty);

    expect(names(controller), ['src.zip']);
    expect(field(tester).text, 'Look at ');
    expect(controller.draft('lead'), 'Look at ');
    expect(hint, findsNothing);
    final zip = ZipDecoder().decodeBytes(
      controller.attachments('lead').files.single.bytes,
    );
    final entries = {
      for (final entry in zip.files)
        if (entry.isFile) entry.name: String.fromCharCodes(entry.content),
    };
    expect(entries, {
      'src/main.dart': 'void main() {}',
      'src/lib/a.dart': '// a',
    });
    await close(tester, controller);
  });

  testWidgets('a folder over the attachment limit is not zipped, and its '
      'path stays', (tester) async {
    final controller = await open(tester, machineId: 'studio');
    final big = folder('big');
    File('${big.path}/blob.bin')
        .writeAsBytesSync(List.filled(kSuperTabAttachmentMaxBytes + 1, 0));
    await drop(tester, [
      big.path,
    ], until: () => field(tester).text.contains(big.path));

    await tester.tap(find.text('Attach as zip'));
    await settle(tester, () => find.byType(SnackBar).evaluate().isNotEmpty);

    expect(names(controller), isEmpty);
    expect(find.text('big is over 10 MB.'), findsOneWidget);
    expect(field(tester).text, '${big.path} ');
    await close(tester, controller);
  });

  testWidgets('a zip that lands while its message is sending is not kept '
      'for the next one', (tester) async {
    final controller = await open(tester, machineId: 'studio');
    final src = folder('src');
    File('${src.path}/main.dart').writeAsStringSync('void main() {}');
    await tester.enterText(composer, 'Look at');
    await drop(tester, [
      src.path,
    ], until: () => field(tester).text.contains(src.path));

    await tester.tap(find.text('Attach as zip'));
    server.holdReads = Completer<void>();
    await tester.tap(find.byTooltip('Send message'));
    await tester.pump();
    // The zip has its answer while the send still waits on the server.
    await settle(tester, () => names(controller).isNotEmpty);
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();

    expect(
      (server.posts.single['command'] as Map)['text'],
      'Look at ${src.path}',
    );
    expect(names(controller), isEmpty);
    await close(tester, controller);
  });

  testWidgets('a message that fails to send keeps offering its folder as a '
      'zip', (tester) async {
    final controller = await open(tester, machineId: 'studio');
    await drop(tester, [
      folder('src').path,
    ], until: () => field(tester).text.isNotEmpty);

    server.refuse = {'code': 'CONFLICT', 'message': 'Try again.'};
    await tester.tap(find.byTooltip('Send message'));
    await tester.pumpAndSettle();

    expect(hint, findsOneWidget);
    expect(
      find.descendant(of: hint, matching: find.text('Attach as zip')),
      findsOneWidget,
    );
    await close(tester, controller);
  });
}
