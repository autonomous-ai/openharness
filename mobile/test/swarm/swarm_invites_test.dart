import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_invites.dart';
import 'package:harness_mobile/swarm/swarm_invites_sheet.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Inviting people and revoking invitations from the phone, as the desktop's
/// Share Swarm does (`desktop/lib/super_tabs/sharing.dart`): only for the
/// Swarm's owner, one receipt per invitation, a revoke behind a confirmation,
/// a note and the join link through the share sheet, and nothing kept or
/// sent once the person may no longer invite.
void main() {
  // 1 November 2026, 09:00 UTC.
  final now = DateTime.utc(2026, 11, 1, 9);
  final day = const Duration(days: 1).inMilliseconds;
  final token = 'A' * 43;
  final joinUrl = 'harness://swarm/join/$tab?token=$token';
  const commands = '/api/super-tabs/$tab/commands';
  const sharing = '/api/super-tabs/$tab/sharing';

  Map<String, dynamic> invitation(
    String id,
    String email, {
    String role = 'collaborator',
    int? expiresAt,
  }) => {
    'id': id,
    'email': email,
    'role': role,
    'conversationId': leadChat,
    'expiresAt': expiresAt ?? now.millisecondsSinceEpoch + 6 * day,
  };

  Map<String, dynamic> head({
    String ownerId = me,
    List<Map<String, dynamic>> invitations = const [],
  }) => {...headData(ownerId: ownerId), 'invitations': invitations};

  /// A Swarm [owner] owns, with [invitations] waiting, General access giving
  /// [link], and every command taken.
  FakeSwarm backend({
    String owner = me,
    List<Map<String, dynamic>> invitations = const [],
    String? link,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': owner},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        head: head(ownerId: owner, invitations: invitations),
      ),
      'members': [
        part(me, 1, person(me, role: owner == me ? 'owner' : 'collaborator')),
        if (owner != me) part(owner, 1, person(owner)),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[commands] = (_) => {'result': {}};
    fake.routes[sharing] = (_) => {
      'revision': 1,
      'access': {'mode': link == null ? 'invited' : 'link', 'role': 'viewer'},
      'joinUrl': link,
    };
    return fake;
  }

  /// The next read of the Swarm brings [data] as its head.
  void nextHead(FakeSwarm fake, Map<String, dynamic> data, {int version = 2}) {
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c$version'),
      'head': part('head', version, data),
    };
  }

  Future<SwarmHost> host(
    FakeSwarm fake, {
    ValueNotifier<String?>? signedIn,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = signedIn ?? ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await host.session!.inbox.refresh();
    await host.session!.inbox.reader(tab)?.refresh();
    return host;
  }

  final shared = <({String text, Rect? origin})>[];
  Future<void> share(String text, {Rect? origin}) async =>
      shared.add((text: text, origin: origin));
  setUp(shared.clear);

  /// The project's leaderboard under the signed-in shell, as a page or as
  /// the sheet its menu opens ([asSheet]).
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    ValueNotifier<String?>? signedIn,
    bool asSheet = false,
  }) async {
    final shell = await host(fake, signedIn: signedIn);
    final board = SwarmLeaderboardPage(
      swarmId: tab,
      projectId: project,
      sheet: asSheet,
      now: () => now,
    );
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: shell, child: child!),
        home: asSheet ? Scaffold(body: board) : board,
      ),
    );
    await tester.pumpAndSettle();
    return shell;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  group('who may invite', () {
    test('the Swarm’s owner alone, and nobody once the read is gone', () async {
      final owned = await host(backend());
      final reader = owned.session!.inbox.reader(tab)!;
      expect(swarmMayInvite(reader), isTrue);
      reader.revoke();
      expect(swarmMayInvite(reader), isFalse);

      final theirs = await host(backend(owner: 'diego'));
      expect(swarmMayInvite(theirs.session!.inbox.reader(tab)), isFalse);
      expect(swarmMayInvite(null), isFalse);
    });

    testWidgets('the leaderboard shows Invite people to the owner only', (
      tester,
    ) async {
      await pump(tester, backend(owner: 'diego'));
      expect(key('swarm-invite-people'), findsNothing);
      await pump(tester, backend(owner: 'diego'), asSheet: true);
      expect(key('swarm-invite-people'), findsNothing);

      await pump(tester, backend());
      expect(key('swarm-invite-people'), findsOneWidget);
      await pump(tester, backend(), asSheet: true);
      expect(key('swarm-invite-people'), findsOneWidget);

      // It opens Share Swarm.
      await tester.tap(key('swarm-invite-people'));
      await tester.runAsync(settle);
      await tester.pumpAndSettle();
      expect(find.text('Share Swarm'), findsOneWidget);
    });

    testWidgets('a first read that fails and then recovers still offers it', (
      tester,
    ) async {
      final fake = backend();
      final answer = fake.routes['/api/super-tabs/$tab/parts']!;
      var fail = true;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => fail
          ? throw const SuperTabFailure(
              'BACKEND_UNAVAILABLE',
              'Could not reach this Swarm.',
              statusCode: 503,
            )
          : answer(body);
      final shell = await pump(tester, fake);
      expect(key('swarm-invite-people'), findsNothing);

      fail = false;
      await tester.runAsync(() => shell.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(key('swarm-invite-people'), findsOneWidget);
    });

    testWidgets(
      'ownership passed on while the leaderboard is up takes it away',
      (tester) async {
        final fake = backend();
        final shell = await pump(tester, fake);
        expect(key('swarm-invite-people'), findsOneWidget);

        nextHead(fake, head(ownerId: 'diego'));
        await tester.runAsync(
          () => shell.session!.inbox.reader(tab)!.refresh(),
        );
        await tester.pumpAndSettle();
        expect(key('swarm-invite-people'), findsNothing);
      },
    );
  });

  group('what an invitation reads as', () {
    test('its access and when it expires, or that it has', () {
      SwarmPendingInvite at(int ms, {String role = 'viewer'}) =>
          SwarmPendingInvite.read(
            invitation('i', 'ana@acme.com', role: role, expiresAt: ms),
          )!;
      final base = now.millisecondsSinceEpoch;
      expect(
        swarmInviteDetail(at(base + 6 * day), now),
        'Can view · Expires in 6 days',
      );
      expect(
        swarmInviteDetail(at(base + day, role: 'collaborator'), now),
        'Can collaborate · Expires in 1 day',
      );
      expect(
        swarmInviteDetail(at(base + 3 * 3600000), now),
        'Can view · Expires in 3 hours',
      );
      expect(swarmInviteDetail(at(base), now), 'Can view · Expired');
      expect(at(base).expired(now), isTrue);
    });

    test('a row that is not an invitation is left out', () {
      expect(SwarmPendingInvite.read({'id': 'i', 'email': 'x'}), isNull);
      expect(
        SwarmPendingInvite.read({
          ...invitation('i', 'a@b.co'),
          'role': 'owner',
        }),
        isNull,
      );
    });

    test('a join link counts only as this Swarm’s', () {
      expect(swarmJoinUrl(joinUrl, tab), joinUrl);
      expect(swarmJoinUrl('harness://swarm/join/$tab', tab), isNotNull);
      expect(
        swarmJoinUrl('harness://swarm/join/other?token=$token', tab),
        isNull,
      );
      expect(
        swarmJoinUrl('harness://swarm/join/$tab?token=short', tab),
        isNull,
      );
      expect(swarmJoinUrl('https://swarm/join/$tab?token=$token', tab), isNull);
      expect(swarmJoinUrl(null, tab), isNull);
    });

    test('the note shared carries no link or secret', () {
      final note = swarmInviteNote(
        'Phone Swarm',
        SwarmPendingInvite.read(invitation('i', 'ana@acme.com'))!,
      );
      expect(note, contains('ana@acme.com'));
      expect(note, contains('Phone Swarm'));
      expect(note, isNot(contains('harness://')));
    });
  });

  group('sending', () {
    Future<(SwarmInvites, FakeSwarm)> invites(FakeSwarm fake) async {
      final shell = await host(fake);
      final session = shell.session!;
      final controller = SwarmInvites(
        session: session,
        reader: session.inbox.reader(tab)!,
      );
      addTearDown(controller.dispose);
      return (controller, fake);
    }

    List<Map<String, dynamic>?> sent(FakeSwarm fake) => [
      for (final call in fake.calls)
        if (call.path == commands) call.body,
    ];

    test(
      'an invitation goes as the desktop sends it, and the Swarm is read again',
      () async {
        final (controller, fake) = await invites(backend());
        fake.calls.clear();
        expect(await controller.invite(' ana@acme.com ', 'viewer'), isTrue);
        expect(fake.commands.single, {
          'type': 'invite.create',
          'email': 'ana@acme.com',
          'role': 'viewer',
          'conversationId': 'lead',
        });
        await settle();
        expect(
          fake.paths.where((p) => p.startsWith('/api/super-tabs/$tab/changes')),
          isNotEmpty,
        );
        expect(controller.busy, isFalse);
      },
    );

    test('an answer that never came is checked under the same receipt, never sent twice', () async {
      final fake = backend();
      var down = true;
      fake.routes[commands] = (_) => down
          ? throw const SuperTabFailure(
              'BACKEND_UNAVAILABLE',
              'Down',
              statusCode: 503,
            )
          : {'result': {}};
      final (controller, _) = await invites(fake);
      expect(await controller.invite('ana@acme.com', 'viewer'), isFalse);
      expect(controller.unconfirmed, isTrue);
      expect(
        controller.error,
        'Could not confirm this invitation. Check it again.',
      );
      // Another invitation waits until this one is known.
      expect(await controller.invite('bo@acme.com', 'viewer'), isFalse);
      expect(sent(fake), hasLength(1));

      down = false;
      expect(await controller.check(), isTrue);
      final bodies = sent(fake);
      expect(bodies, hasLength(2));
      expect(bodies[1]!['operationId'], bodies[0]!['operationId']);
      expect(bodies[1]!['command'], bodies[0]!['command']);
      expect(controller.unconfirmed, isFalse);
    });

    test('a refusal lets the receipt go and says why', () async {
      final fake = backend();
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'ALREADY_MEMBER',
        'This person is already in the Super Tab.',
        statusCode: 409,
      );
      final (controller, _) = await invites(fake);
      expect(await controller.invite('ana@acme.com', 'viewer'), isFalse);
      expect(controller.unconfirmed, isFalse);
      expect(controller.busy, isFalse);
      expect(controller.error, 'This person is already in this Swarm.');
    });

    test(
      'a server without the commands says so, and has no link to share',
      () async {
        final fake = backend();
        fake.routes[commands] = (_) => throw const SuperTabFailure(
          'UNKNOWN_COMMAND',
          'Unknown command',
          statusCode: 400,
        );
        fake.routes[sharing] = (_) => throw const SuperTabFailure(
          'NOT_FOUND',
          'Not found',
          statusCode: 404,
        );
        final (controller, _) = await invites(fake);
        expect(await controller.invite('ana@acme.com', 'viewer'), isFalse);
        expect(
          controller.error,
          'This Swarm’s server can’t send invitations from here.',
        );
        await controller.readLink();
        expect(controller.link, isNull);
        expect(controller.linkFailed, isFalse);
      },
    );

    test('an address the server will not take is told in its words', () async {
      final fake = backend();
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'VALIDATION_ERROR',
        'Invalid email address',
        statusCode: 400,
      );
      final (controller, _) = await invites(fake);
      expect(await controller.invite('ana@acme', 'viewer'), isFalse);
      expect(controller.error, 'Invalid email address');
      expect(controller.unconfirmed, isFalse);
    });

    test(
      'a revoke of an invitation already accepted or revoked sends nothing',
      () async {
        final (controller, fake) = await invites(backend());
        final gone = SwarmPendingInvite.read(invitation('gone', 'x@acme.com'))!;
        expect(await controller.revoke(gone), isFalse);
        expect(fake.commands, isEmpty);
      },
    );

    test('an answer after access ended changes nothing', () async {
      final fake = backend();
      final answer = Completer<Object?>();
      fake.routes[commands] = (_) => answer.future;
      final (controller, _) = await invites(fake);
      final reader = controller.reader;
      final sending = controller.invite('ana@acme.com', 'viewer');
      await settle();
      reader.revoke();
      fake.calls.clear();
      answer.completeError(
        const SuperTabFailure('BACKEND_UNAVAILABLE', 'Down', statusCode: 503),
      );
      expect(await sending, isFalse);
      expect(controller.error, isNull);
      expect(controller.live, isFalse);
      // Nothing more is sent, and nothing read again.
      expect(await controller.check(), isFalse);
      expect(fake.calls, isEmpty);
    });

    test(
      'a link read that lands after the read was replaced is dropped',
      () async {
        final fake = backend(link: joinUrl);
        final answer = Completer<Object?>();
        fake.routes[sharing] = (_) => answer.future;
        final (controller, _) = await invites(fake);
        final reading = controller.readLink();
        await settle();
        controller.reader.revoke();
        answer.complete({
          'revision': 1,
          'access': {'mode': 'link', 'role': 'viewer'},
          'joinUrl': joinUrl,
        });
        await reading;
        expect(controller.link, isNull);
      },
    );

    test('a link read that fails says so, and Try again finds it', () async {
      final fake = backend(link: joinUrl);
      var down = true;
      fake.routes[sharing] = (_) => down
          ? throw const SuperTabFailure(
              'BACKEND_UNAVAILABLE',
              'Down',
              statusCode: 503,
            )
          : {
              'revision': 1,
              'access': {'mode': 'link', 'role': 'viewer'},
              'joinUrl': joinUrl,
            };
      final (controller, _) = await invites(fake);
      await controller.readLink();
      expect(controller.linkFailed, isTrue);
      expect(controller.link, isNull);
      down = false;
      await controller.readLink();
      expect(controller.linkFailed, isFalse);
      expect(controller.link, joinUrl);
    });
  });

  group('Share Swarm', () {
    /// Share Swarm over a blank page, opened by its test button, sharing
    /// through [share].
    Future<SwarmHost> sheet(
      WidgetTester tester,
      FakeSwarm fake, {
      ValueNotifier<String?>? signedIn,
    }) async {
      final shell = await host(fake, signedIn: signedIn);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: shell, child: child!),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                key: const ValueKey('open'),
                onPressed: () => Navigator.of(context).push(
                  swarmTestSheetRoute(
                    context,
                    SwarmInvitesSheet(
                      session: shell.session!,
                      reader: shell.session!.inbox.reader(tab)!,
                      share: share,
                      now: () => now,
                    ),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(key('open'));
      await tester.runAsync(settle);
      await tester.pumpAndSettle();
      return shell;
    }

    testWidgets(
      'invites by email with the access picked, then clears the field',
      (tester) async {
        final fake = backend();
        await sheet(tester, fake);
        expect(find.text('Share Swarm'), findsOneWidget);

        await tester.enterText(key('swarm-invite-email'), 'not an address');
        await tester.pump();
        await tester.tap(key('swarm-invite-send'));
        await tester.pumpAndSettle();
        expect(key('swarm-invite-email-error'), findsOneWidget);
        expect(fake.commands, isEmpty);

        await tester.tap(key('swarm-invite-role'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-invite-role-viewer'));
        await tester.pumpAndSettle();
        expect(find.text('Can view'), findsOneWidget);

        await tester.enterText(key('swarm-invite-email'), 'ana@acme.com');
        await tester.pump();
        await tester.tap(key('swarm-invite-send'));
        await tester.runAsync(settle);
        await tester.pumpAndSettle();
        expect(fake.commands.single, {
          'type': 'invite.create',
          'email': 'ana@acme.com',
          'role': 'viewer',
          'conversationId': 'lead',
        });
        expect(
          tester.widget<TextField>(key('swarm-invite-email')).controller!.text,
          isEmpty,
        );
      },
    );

    testWidgets(
      'lists each invitation with its expiry; an expired one has no Share',
      (tester) async {
        await sheet(
          tester,
          backend(
            invitations: [
              invitation('i1', 'ana@acme.com', role: 'viewer'),
              invitation(
                'i2',
                'bo@acme.com',
                expiresAt: now.millisecondsSinceEpoch - 1,
              ),
            ],
          ),
        );
        expect(find.text('Can view · Expires in 6 days'), findsOneWidget);
        expect(find.text('Can collaborate · Expired'), findsOneWidget);
        expect(key('swarm-invite-share-i1'), findsOneWidget);
        expect(key('swarm-invite-share-i2'), findsNothing);
        expect(key('swarm-invite-revoke-i2'), findsOneWidget);
      },
    );

    testWidgets(
      'Share hands a note with no secret to the share sheet; Share link the join link',
      (tester) async {
        await sheet(
          tester,
          backend(
            invitations: [invitation('i1', 'ana@acme.com')],
            link: joinUrl,
          ),
        );
        await tester.tap(key('swarm-invite-share-i1'));
        await tester.pumpAndSettle();
        expect(
          shared.single.text,
          swarmInviteNote(
            'Phone Swarm',
            SwarmPendingInvite.read(invitation('i1', 'ana@acme.com'))!,
          ),
        );
        expect(shared.single.text, isNot(contains(token)));

        await tester.tap(key('swarm-invite-share-link'));
        await tester.pumpAndSettle();
        expect(shared.last.text, joinUrl);
      },
    );

    testWidgets('no Share link when General access has none', (tester) async {
      final fake = backend(invitations: [invitation('i1', 'ana@acme.com')]);
      await sheet(tester, fake);
      expect(fake.paths, contains(sharing));
      expect(key('swarm-invite-share-link'), findsNothing);
      expect(key('swarm-invite-link-error'), findsNothing);
    });

    testWidgets('Revoke asks first: Cancel sends nothing, Revoke revokes', (
      tester,
    ) async {
      final fake = backend(invitations: [invitation('i1', 'ana@acme.com')]);
      await sheet(tester, fake);
      await tester.tap(key('swarm-invite-revoke-i1'));
      await tester.pumpAndSettle();
      expect(find.text('Revoke invitation?'), findsOneWidget);
      await tester.tap(key('swarm-invite-revoke-cancel'));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty);

      await tester.tap(key('swarm-invite-revoke-i1'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-invite-revoke-confirm'));
      await tester.runAsync(settle);
      await tester.pumpAndSettle();
      expect(fake.commands.single, {'type': 'invite.revoke', 'inviteId': 'i1'});
    });

    testWidgets(
      'access taken away while it asks closes the sheet and its question, and sends nothing',
      (tester) async {
        final fake = backend(
          invitations: [invitation('i1', 'ana@acme.com')],
          link: joinUrl,
        );
        final shell = await sheet(tester, fake);
        await tester.enterText(key('swarm-invite-email'), 'typed@acme.com');
        await tester.tap(key('swarm-invite-revoke-i1'));
        await tester.pumpAndSettle();
        expect(find.text('Revoke invitation?'), findsOneWidget);

        shell.session!.inbox.reader(tab)!.revoke();
        await tester.pumpAndSettle();
        expect(find.text('Revoke invitation?'), findsNothing);
        expect(find.text('Share Swarm'), findsNothing);
        expect(find.text('typed@acme.com'), findsNothing);
        expect(find.text('ana@acme.com'), findsNothing);
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets('ownership passed on closes it', (tester) async {
      final fake = backend(invitations: [invitation('i1', 'ana@acme.com')]);
      final shell = await sheet(tester, fake);
      nextHead(fake, head(ownerId: 'diego'));
      await tester.runAsync(() => shell.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(find.text('Share Swarm'), findsNothing);
      expect(find.text('ana@acme.com'), findsNothing);
    });

    testWidgets('signing out closes it', (tester) async {
      final account = ValueNotifier<String?>(me);
      await sheet(
        tester,
        backend(invitations: [invitation('i1', 'ana@acme.com')]),
        signedIn: account,
      );
      account.value = null;
      await tester.pumpAndSettle();
      expect(find.text('Share Swarm'), findsNothing);
      expect(find.text('ana@acme.com'), findsNothing);
    });

    testWidgets(
      'an invitation answered after the sheet closed changes nothing',
      (tester) async {
        final fake = backend();
        final answer = Completer<Object?>();
        fake.routes[commands] = (_) => answer.future;
        final shell = await sheet(tester, fake);
        await tester.enterText(key('swarm-invite-email'), 'ana@acme.com');
        await tester.pump();
        await tester.tap(key('swarm-invite-send'));
        await tester.pump();
        expect(find.text('Sending…'), findsOneWidget);
        // Still readable, but no longer theirs to invite to.
        nextHead(fake, head(ownerId: 'diego'));
        await tester.runAsync(
          () => shell.session!.inbox.reader(tab)!.refresh(),
        );
        await tester.pumpAndSettle();
        expect(find.text('Share Swarm'), findsNothing);
        fake.calls.clear();
        answer.complete({'result': {}});
        await tester.runAsync(settle);
        await tester.pumpAndSettle();
        // The answer is not taken: nothing is read again for it.
        expect(fake.calls, isEmpty);
      },
    );
  });
}

/// A bottom sheet route as the leaderboard opens Share Swarm in.
Route<void> swarmTestSheetRoute(BuildContext context, Widget sheet) =>
    ModalBottomSheetRoute<void>(
      isScrollControlled: true,
      builder: (_) => sheet,
    );
