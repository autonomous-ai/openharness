import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/fork_inbox.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/sharing.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';

const _token = '1234567890123456789012345678901234567890123';
const _secondToken = 'abcdefghijabcdefghijabcdefghijabcdefghijabc';
const _link = SwarmJoinLink('tab', token: _token);

class _Store implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class SwarmSharingServer extends ConversationServer {
  Map<String, dynamic> access = {'mode': 'invited', 'role': 'collaborator'};
  int sharingRevision = 0, sharingReads = 0;
  String token = _token;
  bool loseSharingReply = false, stale = false, failSharingRead = false;
  Completer<void>? hold;
  final sharingPosts = <Map<String, dynamic>>[];
  final sharingReceipts = <String, Map<String, dynamic>>{};

  Map<String, dynamic> get settings => {
    'revision': sharingRevision,
    'access': Map<String, dynamic>.from(access),
    'joinUrl': access['mode'] == 'invited'
        ? null
        : SwarmJoinLink(
            'tab',
            token: access['mode'] == 'link' ? token : null,
          ).url,
  };

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (path.endsWith('/sharing')) {
      await hold?.future;
      if (method == 'GET') {
        sharingReads++;
        if (failSharingRead) {
          throw const SuperTabFailure(
            'NOT_FOUND',
            'Not found',
            statusCode: 404,
          );
        }
        return settings;
      }
      sharingPosts.add(Map<String, dynamic>.from(body!));
      final operation = body['operationId'] as String;
      if (sharingReceipts[operation] case final receipt?) return receipt;
      if (stale) {
        throw const SuperTabFailure(
          'REVISION_CHANGED',
          'Sharing changed',
          statusCode: 409,
        );
      }
      access = Map<String, dynamic>.from(body['access'] as Map);
      if (body['rotateLink'] == true) token = _secondToken;
      sharingRevision++;
      final result = settings;
      sharingReceipts[operation] = result;
      if (loseSharingReply) throw TimeoutException('lost reply');
      return result;
    }
    final command = body?['command'] as Map?;
    if (command?['type'] == 'invite.create') {
      (state['invitations'] as List).add({
        'id': 'invitation',
        'email': command!['email'],
        'role': command['role'],
      });
    }
    return super.request(method, path, body: body);
  }
}

Future<SuperTabController> _open(
  WidgetTester tester,
  SwarmSharingServer server, {
  String account = 'owner',
  Brightness brightness = Brightness.dark,
  double scale = 1,
  Size size = const Size(900, 700),
  GlobalKey? boundary,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final controller = server.controller(account: account);
  await controller.refresh();
  controller.select('offline');
  addTearDown(controller.dispose);
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSuperTabSharing(context, controller),
              child: const Text('Share'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Share'));
  await tester.pumpAndSettle();
  return controller;
}

Future<void> _choose(WidgetTester tester, String key, String label) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

void main() {
  final capture = Platform.environment['HARNESS_SWARM_SHARING_CAPTURE'];
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  test('join links accept only a typed domain or bearer invitation', () {
    expect(SwarmJoinLink.parse(_link.url)?.token, _token);
    expect(SwarmJoinLink.parse('harness://swarm/join/tab')?.tabId, 'tab');
    for (final value in [
      'https://swarm/join/tab',
      'harness://user@swarm/join/tab',
      'harness://swarm:42/join/tab',
      'harness://swarm/join/tab#secret',
      'harness://swarm/join/tab?',
      'harness://swarm/join/tab?token=short',
      '${_link.url}&token=$_token',
      '${_link.url}&role=owner',
      'harness://swarm/join/tab/extra',
      'harness://swarm/join/%2F',
      'harness://swarm/join/${'x' * 161}',
    ]) {
      expect(SwarmJoinLink.parse(value), isNull, reason: value);
    }
  });

  testWidgets(
    'native cold-start links share one channel and never persist join tokens',
    (tester) async {
      final store = _Store(), joins = SwarmJoinInbox();
      const channel = MethodChannel('harness/join-fixture');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        expect(call.method, 'ready');
        return [
          _link.url,
          'harness://fork/starter-demo?request=11111111-1111-4111-8111-111111111111',
        ];
      });
      final forks = ForkInbox(
        store,
        channel: channel,
        onUnhandledLink: joins.accept,
      );
      await forks.initialize();
      expect(joins.pending.single.tabId, 'tab');
      expect(forks.pending.single.harnessId, 'starter-demo');
      expect(store.values.values.join(), isNot(contains(_token)));
      await forks.accept(_link.url);
      expect(joins.pending, hasLength(1));
      await forks.accept('harness://swarm/join/tab?token=invalid');
      expect(joins.pending, hasLength(1));
      joins.complete(joins.pending.single);
      expect(joins.pending, isEmpty);
      forks.dispose();
      joins.dispose();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      );
    },
  );

  testWidgets(
    'email invitation is Swarm scoped and does not use the open workgroup',
    (tester) async {
      final server = SwarmSharingServer();
      await _open(tester, server);
      expect(
        tester.getSize(find.byType(DesktopDialogSurface)).height,
        lessThan(400),
      );
      expect(find.text('Find a person'), findsNothing);
      expect(find.byKey(const Key('swarm-copy-link')), findsNothing);
      expect(server.sharingPosts, isEmpty);
      await tester.enterText(
        find.byKey(const Key('swarm-invite-email')),
        'invalid',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('swarm-invite-send')));
      await tester.pumpAndSettle();
      expect(find.text('Enter an email address.'), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.enterText(
        find.byKey(const Key('swarm-invite-email')),
        'leo@example.com',
      );
      await _choose(tester, 'swarm-invite-role', 'Can view');
      await tester.tap(find.byKey(const Key('swarm-invite-send')));
      await tester.pumpAndSettle();
      expect(server.posts.single['command'], {
        'type': 'invite.create',
        'email': 'leo@example.com',
        'role': 'viewer',
        'conversationId': 'lead',
      });
      expect(find.text('leo@example.com'), findsOneWidget);
      expect(find.text('Invited'), findsOneWidget);
    },
  );

  testWidgets(
    'domain access requires Save; copied link carries no bearer token',
    (tester) async {
      final server = SwarmSharingServer();
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      await _open(tester, server);
      await _choose(tester, 'swarm-general-access', 'Anyone at a domain');
      expect(server.sharingPosts, isEmpty);
      await tester.enterText(
        find.byKey(const Key('swarm-sharing-domain')),
        'team.example.com',
      );
      await _choose(tester, 'swarm-sharing-role', 'Can view');
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      expect(server.sharingPosts.single['access'], {
        'mode': 'domain',
        'role': 'viewer',
        'domain': 'team.example.com',
      });
      await tester.tap(find.byKey(const Key('swarm-copy-link')));
      await tester.pumpAndSettle();
      expect(copied, 'harness://swarm/join/tab');
      expect(find.text('Copied'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      );
    },
  );

  testWidgets(
    'link rotation retries one receipt and restrictive access removes Copy link',
    (tester) async {
      final server = SwarmSharingServer()
        ..access = {'mode': 'link', 'role': 'collaborator'};
      await _open(tester, server);
      server.loseSharingReply = true;
      await tester.tap(find.byKey(const Key('swarm-reset-link')));
      await tester.pumpAndSettle();
      expect(
        find.text('Could not confirm this change. Retry to check it.'),
        findsOneWidget,
      );
      final first = server.sharingPosts.single;
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      expect(server.sharingPosts.last['operationId'], first['operationId']);
      expect(server.sharingPosts.last['rotateLink'], true);
      expect(server.sharingRevision, 1);
      expect(
        find.text('Could not confirm this change. Retry to check it.'),
        findsNothing,
      );
      server.loseSharingReply = false;
      await _choose(tester, 'swarm-general-access', 'Invited people');
      expect(
        tester
            .widget<TextButton>(find.byKey(const Key('swarm-copy-link')))
            .onPressed,
        isNull,
      );
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      expect(server.access['mode'], 'invited');
      expect(find.byKey(const Key('swarm-copy-link')), findsNothing);
    },
  );

  testWidgets(
    'a stale access edit reloads instead of overwriting another owner change',
    (tester) async {
      final server = SwarmSharingServer();
      await _open(tester, server);
      await _choose(tester, 'swarm-general-access', 'Anyone with the link');
      server.stale = true;
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      expect(server.sharingReads, 2);
      expect(find.text('Invited people'), findsOneWidget);
      expect(
        find.text(
          'Sharing changed. Review the current settings and try again.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'old server leaves email invitations available and explains unavailable links',
    (tester) async {
      final server = SwarmSharingServer()..failSharingRead = true;
      await _open(tester, server);
      expect(
        find.text('Sharing links aren’t available on this server yet.'),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const Key('swarm-invite-email')),
        'leo@example.com',
      );
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('swarm-invite-send')))
            .onPressed,
        isNotNull,
      );
    },
  );

  testWidgets('viewers can see people but cannot change sharing', (
    tester,
  ) async {
    final server = SwarmSharingServer();
    (server.state['people'] as List).add({
      'id': 'viewer',
      'email': 'viewer@example.com',
      'role': 'viewer',
    });
    await _open(tester, server, account: 'viewer');
    expect(server.sharingReads, 0);
    expect(find.byKey(const Key('swarm-invite-email')), findsNothing);
    expect(find.text('General access'), findsNothing);
    expect(find.text('viewer@example.com'), findsOneWidget);
    expect(find.text('Leave'), findsOneWidget);
  });

  testWidgets('contributor of a Product Manager cannot be removed', (
    tester,
  ) async {
    final server = SwarmSharingServer();
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.state['agents'] = [
      {
        'id': 'pm',
        'name': 'Quinn',
        'machineId': 'm',
        'harnessId': 'native-pm',
        'contributorId': 'peer',
        'configuration': {'engine': 'claude'},
      },
    ];
    (server.state['conversations'] as List)[0]['leadId'] = 'pm';
    await _open(tester, server);
    await tester.tap(find.byKey(const Key('swarm-sharing-people')));
    await tester.pumpAndSettle();
    final remove = find.widgetWithText(TextButton, 'Remove');
    expect(remove, findsOneWidget);
    expect(tester.widget<TextButton>(remove).onPressed, isNull);
    // Why, where it matters: on the unavailable Remove, not as a sentence in the list (Ken, 2026-10-28).
    const why =
        'Quinn is the Product Manager of project Pilot. Delete the project first.';
    expect(find.text(why), findsNothing);
    expect(find.byTooltip(why), findsOneWidget);
    // A quiet control, not a heavy pill on every row.
    expect(
      tester.widget<TextButton>(remove).style?.backgroundColor?.resolve({}),
      Colors.transparent,
    );
    expect(server.posts, isEmpty);
  });

  testWidgets(
    'the owner\'s row says only Owner, even when an agent of theirs is a Product Manager',
    (tester) async {
      final server = SwarmSharingServer();
      server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'River',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (server.state['conversations'] as List)[0]['leadId'] = 'pm';
      await _open(tester, server);
      await tester.tap(find.byKey(const Key('swarm-sharing-people')));
      await tester.pumpAndSettle();
      expect(find.text('Owner'), findsOneWidget);
      expect(find.textContaining('Product Manager'), findsNothing);
      expect(
        find.byTooltip(
          'River is the Product Manager of project Pilot. Delete the project first.',
        ),
        findsNothing,
      );
    },
  );

  testWidgets(
    'one primary action at a time: Save, not Invite as well, once general access changes',
    (tester) async {
      final server = SwarmSharingServer();
      await _open(tester, server);
      await tester.enterText(
        find.byKey(const Key('swarm-invite-email')),
        'peer@example.com',
      );
      await tester.pumpAndSettle();
      expect(
        find.byType(FilledButton),
        findsOneWidget,
        reason: 'Invite, while nothing else changed',
      );
      await _choose(tester, 'swarm-general-access', 'Anyone with the link');
      expect(find.byType(FilledButton), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      // Invite still works, as a secondary action.
      final invite = tester.widget<ButtonStyleButton>(
        find.byKey(const Key('swarm-invite-send')),
      );
      expect(invite.onPressed, isNotNull);
    },
  );

  testWidgets('the email, its access and Invite sit on one line', (
    tester,
  ) async {
    final server = SwarmSharingServer();
    await _open(tester, server);
    double middle(Finder f) => tester.getCenter(f).dy;
    final email = middle(find.byKey(const Key('swarm-invite-email')));
    expect(
      middle(find.byKey(const Key('swarm-invite-role'))),
      closeTo(email, 1),
    );
    expect(
      middle(find.byKey(const Key('swarm-invite-send'))),
      closeTo(email, 1),
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('swarm-invite-role'))).dx,
      greaterThan(
        tester.getTopRight(find.byKey(const Key('swarm-invite-email'))).dx,
      ),
    );
  });

  testWidgets('member removal shows a backend Product Manager refusal', (
    tester,
  ) async {
    final server = SwarmSharingServer();
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.refuse = {
      'code': 'LEAD_PROTECTED',
      'message': 'Sage is now the Product Manager of project Pilot. Delete the project first.',
    };
    await _open(tester, server);
    await tester.tap(find.byKey(const Key('swarm-sharing-people')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Remove'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Sage is now the Product Manager of project Pilot. Delete the project first.',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'revocation removes the captured Share dialog and late settings cannot restore it',
    (tester) async {
      final server = SwarmSharingServer();
      final controller = await _open(tester, server);
      controller.revokeAccess('Removed');
      await tester.pumpAndSettle();
      expect(find.text('This action is no longer available.'), findsOneWidget);
      expect(find.byKey(const Key('swarm-invite-email')), findsNothing);
      expect(find.text('General access'), findsNothing);
    },
  );

  for (final profile in [
    (
      name: 'dark',
      brightness: Brightness.dark,
      scale: 1.0,
      size: const Size(900, 700),
    ),
    (
      name: 'light',
      brightness: Brightness.light,
      scale: 1.0,
      size: const Size(900, 700),
    ),
    (
      name: 'compact',
      brightness: Brightness.dark,
      scale: 2.0,
      size: const Size(600, 600),
    ),
  ]) {
    testWidgets('sharing remains compact and usable in ${profile.name}', (
      tester,
    ) async {
      final server = SwarmSharingServer();
      final boundary = GlobalKey();
      await _open(
        tester,
        server,
        brightness: profile.brightness,
        scale: profile.scale,
        size: profile.size,
        boundary: boundary,
      );
      Future<void> shot(String name) async {
        if (capture == null) return;
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final image = await render.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(capture).create(recursive: true);
          await File('$capture/${profile.name}-$name.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await shot('invited');
      await _choose(tester, 'swarm-general-access', 'Anyone with the link');
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      await shot('link');
      await tester.ensureVisible(find.byKey(const Key('swarm-sharing-people')));
      await tester.tap(find.byKey(const Key('swarm-sharing-people')));
      await tester.pumpAndSettle();
      await shot('people');
      expect(tester.takeException(), isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SwarmSharingDialog), findsNothing);
    });
  }

  testWidgets(
    'join link previews first; explicit Join retries the same receipt',
    (tester) async {
      final requests = <Map<String, dynamic>>[];
      var refuse = true, opened = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => SwarmJoinDialog(
                    link: _link,
                    accountEmail: 'leo@example.com',
                    isCurrent: () => true,
                    onJoined: (id, name) {
                      expect(id, 'tab');
                      expect(name, 'Team');
                      opened = true;
                    },
                    request: (method, path, {body}) async {
                      requests.add({'method': method, 'path': path, ...?body});
                      expect(path, isNot(contains(_token)));
                      if (path.endsWith('/preview')) {
                        return {
                          'id': 'tab',
                          'name': 'Team',
                          'role': 'collaborator',
                          'alreadyMember': false,
                        };
                      }
                      if (refuse) throw TimeoutException('lost reply');
                      return {'id': 'tab', 'role': 'collaborator'};
                    },
                  ),
                ),
                child: const Text('Open link'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open link'));
      await tester.pumpAndSettle();
      expect(requests, hasLength(1));
      expect(requests.single['path'], '/api/super-tabs/tab/join/preview');
      expect(requests.single['token'], _token);
      expect(opened, false);
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      expect(opened, false);
      refuse = false;
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      expect(requests[2]['operationId'], requests[1]['operationId']);
      expect(opened, true);
      expect(find.byType(SwarmJoinDialog), findsNothing);
    },
  );

  testWidgets('revoked links never offer Join or expose a Swarm name', (
    tester,
  ) async {
    var opened = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmJoinDialog(
            link: _link,
            accountEmail: 'leo@example.com',
            isCurrent: () => true,
            onJoined: (_, _) => opened = true,
            request: (_, _, {body}) async => throw const SuperTabFailure(
              'FORBIDDEN',
              'private server text',
              statusCode: 403,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text(
        'This link is unavailable for your account. Ask the owner for an invitation.',
      ),
      findsOneWidget,
    );
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('private server text'), findsNothing);
    expect(opened, false);
  });

  // Scholes, 2026-10-29: joining adds this computer, so only a join that made
  // the person a member says so, with the role; someone already in it, never.
  testWidgets('tells only a new member\'s join, with its role', (tester) async {
    Future<List<String>> join(Map<String, dynamic> preview) async {
      final told = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => SwarmJoinDialog(
                    link: _link,
                    accountEmail: 'leo@example.com',
                    isCurrent: () => true,
                    onJoined: (_, _) {},
                    onNewMember: (id, role) => told.add('$id:$role'),
                    request: (_, path, {body}) async =>
                        path.endsWith('/preview')
                        ? {'id': _link.tabId, 'name': 'Pilot', ...preview}
                        : {'id': _link.tabId},
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      return told;
    }

    expect(await join({'role': 'collaborator'}), [
      '${_link.tabId}:collaborator',
    ]);
    expect(await join({'role': 'viewer'}), ['${_link.tabId}:viewer']);
    expect(
      await join({'role': 'collaborator', 'alreadyMember': true}),
      isEmpty,
    );
  });
}
