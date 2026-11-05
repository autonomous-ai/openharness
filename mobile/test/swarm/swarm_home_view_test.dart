import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_home_view_sheet.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// A store whose first [failures] reads fail.
class _FailingStore extends MemoryKeyValueStore {
  _FailingStore(this.failures);
  int failures;

  @override
  Future<String?> read(String key) async {
    if (failures-- > 0) throw StateError('unreadable');
    return super.read(key);
  }
}

/// Home's Sort by and Filter menu on the phone (Tony, 11-02): what each choice
/// does to the Projects list, that it is kept on this phone, and that the menu
/// goes with the account or the Swarms it sorts.
void main() {
  const SwarmProjectNews bold = (bold: true, tags: 0, hasWaitingTag: false);
  const web = 'project-2';
  const webLead = 'group-lead-web';
  final now = DateTime.utc(2030, 1, 2, 12);

  SwarmHomeProject row(
    String id, {
    DateTime? active,
    SwarmProjectNews news = swarmNoProjectNews,
  }) => SwarmHomeProject(
    swarmId: tab,
    project: SuperTabProject.fromJson({
      'id': id,
      'name': id,
      'ownerId': me,
      'leadConversationId': 'lead-$id',
      'visibility': 'public',
      'members': <Object>[],
      'updateMinutes': 5,
    }),
    active: active,
    news: news,
  );

  List<String> ids(List<SwarmHomeProject> list) => [
    for (final p in list) p.project.id,
  ];

  group('The Projects list', () {
    final hour = const Duration(hours: 1);
    final projects = [
      row('old-read', active: now.subtract(hour * 48)),
      row('new-read', active: now.subtract(hour)),
      row('older-unread', active: now.subtract(hour * 3), news: bold),
      row(
        'tagged',
        active: now.subtract(hour * 2),
        news: (bold: true, tags: 2, hasWaitingTag: true),
      ),
      row('pinned-read', active: now.subtract(hour * 72)),
    ];
    final pins = {swarmHomeProjectKey(tab, 'pinned-read')};

    test('Sections folds the quiet ones, as Home always has', () {
      final lists = swarmHomeLists(projects, pins: pins, now: now);
      expect(ids(lists.pinned), ['pinned-read']);
      expect(ids(lists.recent), ['new-read', 'older-unread', 'tagged']);
      expect(ids(lists.quiet), ['old-read']);
    });

    test('Newest to oldest folds nothing, and a pin still holds', () {
      final lists = swarmHomeLists(
        projects,
        pins: pins,
        now: now,
        sort: SwarmHomeSort.newest,
      );
      expect(ids(lists.pinned), ['pinned-read']);
      expect(ids(lists.recent), [
        'new-read',
        'tagged',
        'older-unread',
        'old-read',
      ]);
      expect(lists.quiet, isEmpty);
    });

    test('Move to the top brings what is new first, in the same order among '
        'them, in every list', () {
      final lists = swarmHomeLists(
        [
          ...projects,
          row('pinned-tagged', active: now.subtract(hour * 90), news: bold),
        ],
        pins: {...pins, swarmHomeProjectKey(tab, 'pinned-tagged')},
        now: now,
        unreadsFirst: true,
      );
      expect(ids(lists.pinned), ['pinned-tagged', 'pinned-read']);
      expect(ids(lists.recent), ['older-unread', 'tagged', 'new-read']);
    });

    test('All leaves them; Unread keeps anything new, pinned too; Mentions '
        'keeps only tags', () {
      final lists = swarmHomeLists(
        [
          ...projects,
          row('pinned-unread', active: now.subtract(hour * 90), news: bold),
        ],
        pins: {...pins, swarmHomeProjectKey(tab, 'pinned-unread')},
        now: now,
      );
      expect(
        identical(swarmHomeFiltered(lists, SwarmHomeFilter.all), lists),
        isTrue,
      );
      final unread = swarmHomeFiltered(lists, SwarmHomeFilter.unread);
      expect(ids(unread.pinned), ['pinned-unread']);
      expect(ids(unread.recent), ['older-unread', 'tagged']);
      expect(unread.quiet, isEmpty);
      final mentions = swarmHomeFiltered(lists, SwarmHomeFilter.mentions);
      expect(mentions.pinned, isEmpty);
      expect(ids(mentions.recent), ['tagged']);
    });
  });

  group('Kept on this phone', () {
    Future<void> settle() => Future<void>.delayed(Duration.zero);

    test('each choice reads back; all back to the defaults leaves nothing on '
        'the phone', () async {
      final store = MemoryKeyValueStore();
      final prefs = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(prefs.viewChanged, isFalse);
      prefs
        ..setSort(SwarmHomeSort.newest)
        ..setUnreadsFirst(true)
        ..setFilter(SwarmHomeFilter.mentions);
      await settle();
      expect(prefs.viewChanged, isTrue);
      prefs.dispose();

      final again = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(again.sort, SwarmHomeSort.newest);
      expect(again.unreadsFirst, isTrue);
      expect(again.filter, SwarmHomeFilter.mentions);

      again
        ..setSort(SwarmHomeSort.sections)
        ..setUnreadsFirst(false)
        ..setFilter(SwarmHomeFilter.all);
      await settle();
      expect(store.values['swarm_home.$me'], isNull);
      again.dispose();
    });

    test(
      'each default alone off is still kept: sort, unreads, filter',
      () async {
        for (final choose in <void Function(SwarmHomePrefs)>[
          (p) => p.setSort(SwarmHomeSort.newest),
          (p) => p.setUnreadsFirst(true),
          (p) => p.setFilter(SwarmHomeFilter.unread),
          (p) => p.setFilter(SwarmHomeFilter.mentions),
        ]) {
          final store = MemoryKeyValueStore();
          final prefs = SwarmHomePrefs(accountId: me, store: store);
          await settle();
          choose(prefs);
          await settle();
          expect(store.values['swarm_home.$me'], isNotNull);
          prefs.dispose();
        }
      },
    );

    test('the old filter switch, on, opens as Unread, and Unread still writes '
        'it for an older build; off or unknown reads as the default', () async {
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({
          'pins': ['$tab/$project'],
          'unread': true,
        });
      final old = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(old.filter, SwarmHomeFilter.unread);
      expect(old.pins, {'$tab/$project'});
      old.setSort(SwarmHomeSort.newest);
      await settle();
      expect(
        jsonDecode(store.values['swarm_home.$me']!),
        containsPair('unread', true),
      );
      old.dispose();

      store.values['swarm_home.$me'] = jsonEncode({
        'pins': ['$tab/$project'],
        'filter': 'someday',
        'sort': 'someday',
        'unreadsFirst': 'yes',
      });
      final odd = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(odd.viewChanged, isFalse);
      odd.dispose();
    });

    test('chosen before the choices are back, it stands over what is read, '
        'a default too, and is written', () async {
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({
          'pins': ['$tab/$project'],
          'filter': 'mentions',
          'sort': 'newest',
          'unreadsFirst': true,
        });
      final early = SwarmHomePrefs(accountId: me, store: store)
        ..setFilter(SwarmHomeFilter.all)
        ..setSort(SwarmHomeSort.sections)
        ..setUnreadsFirst(false);
      await settle();
      expect(early.viewChanged, isFalse);
      expect(early.pins, {'$tab/$project'});
      final kept = jsonDecode(store.values['swarm_home.$me']!) as Map;
      expect(kept.containsKey('filter'), isFalse);
      expect(kept.containsKey('sort'), isFalse);
      expect(kept.containsKey('unreadsFirst'), isFalse);
      early.dispose();
    });

    test('a read answering after the session closed changes nothing', () async {
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      final gone = SwarmHomePrefs(accountId: me, store: store)..dispose();
      await settle();
      expect(gone.filter, SwarmHomeFilter.all);
    });

    test('a first read that failed leaves the defaults, and a later choice is '
        'still saved and read back', () async {
      final store = _FailingStore(1);
      final prefs = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(prefs.loaded, isTrue);
      expect(prefs.viewChanged, isFalse);
      prefs.setFilter(SwarmHomeFilter.unread);
      await settle();
      prefs.dispose();

      final again = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      expect(again.filter, SwarmHomeFilter.unread);
      again.dispose();
    });

    test(
      'saved at the pin limit, the choices read back and still save',
      () async {
        final store = MemoryKeyValueStore()
          ..values['swarm_home.$me'] = jsonEncode({
            'pins': [for (var i = 0; i < 60; i++) '$tab/p$i'],
            'filter': 'mentions',
            'unreadsFirst': true,
          });
        final full = SwarmHomePrefs(accountId: me, store: store);
        await settle();
        expect(full.pins, hasLength(SwarmHomePrefs.keptPins));
        expect(full.filter, SwarmHomeFilter.mentions);
        full.setSort(SwarmHomeSort.newest);
        await settle();
        final kept = jsonDecode(store.values['swarm_home.$me']!) as Map;
        expect(kept['pins'], hasLength(SwarmHomePrefs.keptPins));
        expect(kept['sort'], 'newest');
        expect(kept['filter'], 'mentions');
        full.dispose();
      },
    );

    test('one account\'s choices never reach another on the phone', () async {
      final store = MemoryKeyValueStore();
      final mine = SwarmHomePrefs(accountId: me, store: store);
      await settle();
      mine.setFilter(SwarmHomeFilter.mentions);
      await settle();
      mine.dispose();
      final other = SwarmHomePrefs(accountId: 'person-other', store: store);
      await settle();
      expect(other.filter, SwarmHomeFilter.all);
      other.dispose();
    });
  });

  group('Home', () {
    final mobileAt = now.subtract(const Duration(hours: 2));

    /// One Swarm: Mobile, with its project chat unread; and Web, read and quiet for
    /// [webAgo], with what waits in [mentions].
    FakeSwarm backend({
      Duration webAgo = const Duration(hours: 1),
      FutureOr<Object?> Function(Map<String, dynamic>?)? mentions,
    }) {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      final derived = <String, dynamic>{
        'readMarks': {leadChat: 2, 'g1': 1, webLead: 1},
        if (mentions != null) 'mentionsWaiting': 1,
      };
      final changedAt = {
        leadChat: mobileAt.millisecondsSinceEpoch,
        'g1': mobileAt.millisecondsSinceEpoch,
        webLead: now.subtract(webAgo).millisecondsSinceEpoch,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) {
        final read = firstLoad(
          derived: derived,
          head: headData(
            projects: [
              ...headData()['projects'] as List,
              {
                'id': web,
                'name': 'Web',
                'ownerId': me,
                'leadConversationId': webLead,
                'visibility': 'public',
                'members': <Object>[],
                'updateMinutes': 5,
              },
            ],
          ),
          groups: [
            {
              ...groupData(leadChat, title: 'Mobile', lastMessageSequence: 5),
              'lastPersonSequence': 5,
            },
            groupData('g1', title: 'Fix login', lastMessageSequence: 5),
            {
              ...groupData(webLead, title: 'Web', lastMessageSequence: 1),
              'projectId': web,
            },
          ],
        );
        return {
          ...read,
          'groups': [
            for (final part in read['groups'] as List)
              {
                ...part as Map<String, dynamic>,
                'changedAt': changedAt[part['key']],
              },
          ],
        };
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] =
          mentions ?? (_) => {'mentions': <Object>[]};
      fake.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
        'sequence': body?['sequence'],
        'messages': <Object>[],
        'next': null,
      };
      return fake;
    }

    Future<SwarmHost> pump(
      WidgetTester tester,
      FakeSwarm fake, {
      ValueNotifier<String?>? signedIn,
      MemoryKeyValueStore? store,
      bool settle = true,
    }) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = signedIn ?? ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: store ?? MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) => CupertinoPageRoute<void>(
            builder: (_) => SwarmPage(now: () => now),
          ),
        ),
      );
      if (settle) {
        await tester.pumpAndSettle();
      } else {
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }
      return host;
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder project_(String id) => key('swarm-project-$tab-$id');
    Finder inside(Finder of, Finder matching) =>
        find.descendant(of: of, matching: matching);

    /// Home saying a filter is on, where the filter icon's dot was.
    Finder dot() => key('swarm-filter-on');

    /// Sort and filter, from the Swarm switcher in Home's title (anh Dee,
    /// 2026-11-04: no filter icon on Home).
    Future<void> open(WidgetTester tester) async {
      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-switch-view'));
      await tester.pumpAndSettle();
    }

    Future<void> tapRow(WidgetTester tester, String name) async {
      await tester.tap(key(name));
      await tester.pumpAndSettle();
    }

    Future<void> close(WidgetTester tester) async {
      await tester.tapAt(const Offset(195, 40));
      await tester.pumpAndSettle();
    }

    String text(WidgetTester tester, String name) =>
        tester.widget<Text>(key(name)).data!;
    bool ticked(String name) => find
        .descendant(of: key(name), matching: find.byIcon(LucideIcons.check300))
        .evaluate()
        .isNotEmpty;

    testWidgets('the icon opens the menu, not a toggle: each row says what is '
        'on and opens to its options, with a tick on the current one', (
      tester,
    ) async {
      final host = await pump(tester, backend());
      expect(key('swarm-view-sort'), findsNothing);

      await open(tester);

      // Opening the menu changed nothing.
      expect(host.session!.home.viewChanged, isFalse);
      expect(project_(web), findsOneWidget);
      expect(text(tester, 'swarm-view-sort-current'), 'Sections');
      expect(text(tester, 'swarm-view-filter-current'), 'All projects');
      expect(key('swarm-view-sort-sections'), findsNothing);
      expect(key('swarm-view-filter-all'), findsNothing);

      await tapRow(tester, 'swarm-view-sort');
      await tapRow(tester, 'swarm-view-filter');
      expect(ticked('swarm-view-sort-sections'), isTrue);
      expect(ticked('swarm-view-sort-newest'), isFalse);
      expect(ticked('swarm-view-unreads-false'), isTrue);
      expect(ticked('swarm-view-unreads-true'), isFalse);
      expect(ticked('swarm-view-filter-all'), isTrue);
      expect(ticked('swarm-view-filter-unread'), isFalse);
      expect(ticked('swarm-view-filter-mentions'), isFalse);

      await tapRow(tester, 'swarm-view-sort');
      expect(key('swarm-view-sort-sections'), findsNothing);
    });

    testWidgets("the switcher's Sort and filter has a dot, and says in words "
        'what is on, only with something other than the defaults', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final host = await pump(tester, backend());
      Future<void> switcher() async {
        await tester.tap(key('swarm-title-button'));
        await tester.pumpAndSettle();
      }

      Finder rowDot() => key('swarm-switch-view-dot');

      await switcher();
      expect(rowDot(), findsNothing);
      expect(
        find.bySemanticsLabel(
          RegExp(r'^Sort and filter: Sections, All projects$'),
        ),
        findsOneWidget,
      );
      await close(tester);

      for (final change in <void Function()>[
        () => host.session!.home.setSort(SwarmHomeSort.newest),
        () => host.session!.home.setUnreadsFirst(true),
        () => host.session!.home.setFilter(SwarmHomeFilter.unread),
      ]) {
        change();
        await tester.pumpAndSettle();
        await switcher();
        expect(rowDot(), findsOneWidget);
        await close(tester);
        host.session!.home
          ..setSort(SwarmHomeSort.sections)
          ..setUnreadsFirst(false)
          ..setFilter(SwarmHomeFilter.all);
        await tester.pumpAndSettle();
      }
      host.session!.home.setFilter(SwarmHomeFilter.unread);
      await tester.pumpAndSettle();
      await switcher();
      expect(
        find.bySemanticsLabel(RegExp(r'^Sort and filter: Sections, Unread$')),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('Newest to oldest lists the quiet project without the fold; '
        'the row says so and the menu stays open', (tester) async {
      await pump(tester, backend(webAgo: const Duration(hours: 48)));
      expect(key('swarm-other-projects'), findsOneWidget);
      expect(project_(web), findsNothing);

      await open(tester);
      await tapRow(tester, 'swarm-view-sort');
      await tapRow(tester, 'swarm-view-sort-newest');

      expect(key('swarm-view-sort'), findsOneWidget);
      expect(text(tester, 'swarm-view-sort-current'), 'Newest to oldest');
      expect(ticked('swarm-view-sort-newest'), isTrue);
      expect(key('swarm-other-projects'), findsNothing);
      expect(project_(web), findsOneWidget);
    });

    testWidgets('Move to the top brings the unread project over a newer read '
        'one, and the row says so', (tester) async {
      await pump(tester, backend());
      double top(String id) => tester.getTopLeft(project_(id)).dy;
      expect(top(web), lessThan(top(project)));

      await open(tester);
      await tapRow(tester, 'swarm-view-sort');
      await tapRow(tester, 'swarm-view-unreads-true');

      expect(
        text(tester, 'swarm-view-sort-current'),
        'Sections. Unreads on top.',
      );
      expect(top(project), lessThan(top(web)));
    });

    testWidgets('Unread lists what has something new; with nothing it says so '
        'and Show all clears it', (tester) async {
      final host = await pump(tester, backend());
      await open(tester);
      await tapRow(tester, 'swarm-view-filter');
      await tapRow(tester, 'swarm-view-filter-unread');
      expect(text(tester, 'swarm-view-filter-current'), 'Unread');
      await close(tester);
      expect(project_(project), findsOneWidget);
      expect(project_(web), findsNothing);
      expect(
        inside(key('swarm-filter-on'), find.text('Unread only')),
        findsOneWidget,
        reason: 'with no filter icon on Home, the list says a filter is on',
      );

      // Mark all read, in the same sheet (2026-11-03).
      await open(tester);
      await tester.tap(key('swarm-mark-all-read'));
      await tester.pumpAndSettle();
      expect(project_(project), findsNothing);
      expect(key('swarm-filter-none'), findsOneWidget);
      expect(find.text('Nothing unread.'), findsOneWidget);

      await tester.tap(key('swarm-filter-show-all'));
      await tester.pumpAndSettle();
      expect(project_(web), findsOneWidget);
      expect(host.session!.home.filter, SwarmHomeFilter.all);
      expect(key('swarm-filter-on'), findsNothing);
      await tester.pump(const Duration(seconds: 7));
    });

    testWidgets('Home has no Projects caption and no filter icon (anh Dee, '
        "2026-11-04); the switcher's Sort and filter, under the Swarms, opens "
        'the sheet: its options, then Mark all read, then Refresh', (
      tester,
    ) async {
      final host = await pump(tester, backend());
      host.session!.home.pin(tab, project, true);
      await tester.pumpAndSettle();
      expect(key('swarm-home-view'), findsNothing);
      expect(find.text('Projects'), findsNothing);
      expect(find.text('Pinned'), findsNothing);
      expect(key('swarm-mark-all-read'), findsNothing);

      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(key('swarm-switch-$tab')).dy,
        lessThan(tester.getTopLeft(key('swarm-switch-view')).dy),
      );
      expect(
        tester.getSize(key('swarm-switch-view')).height,
        greaterThanOrEqualTo(44),
      );
      await tester.tap(key('swarm-switch-view'));
      await tester.pumpAndSettle();

      expect(key('swarm-switch-$tab'), findsNothing, reason: 'it closed');
      expect(key('swarm-mark-all-read'), findsOneWidget);
      expect(key('swarm-home-refresh'), findsOneWidget);
      expect(
        tester.getTopLeft(key('swarm-view-filter')).dy,
        lessThan(tester.getTopLeft(key('swarm-mark-all-read')).dy),
      );
      expect(
        tester.getTopLeft(key('swarm-mark-all-read')).dy,
        lessThan(tester.getTopLeft(key('swarm-home-refresh')).dy),
      );
    });

    testWidgets('Mark all read in the sheet closes it and marks, with its '
        'Undo; with nothing unread it is greyed and heard as off', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await pump(tester, backend());
      SwarmHomeViewAction mark() =>
          tester.widget<SwarmHomeViewAction>(key('swarm-mark-all-read'));
      await open(tester);
      expect(mark().onTap, isNotNull);

      await tester.tap(key('swarm-mark-all-read'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(key('swarm-view-sort'), findsNothing, reason: 'the sheet closed');
      expect(
        find.textContaining(RegExp(r'^Marked \d+ chats? read$')),
        findsOne,
      );
      expect(find.text('Undo'), findsOneWidget);
      await tester.pump(const Duration(seconds: 7));
      await tester.pumpAndSettle();

      await open(tester);
      expect(mark().onTap, isNull);
      expect(
        tester.getSemantics(key('swarm-mark-all-read')),
        matchesSemantics(
          label: 'Mark all read',
          isButton: true,
          hasEnabledState: true,
          isEnabled: false,
        ),
      );
      handle.dispose();
    });

    testWidgets('Refresh in the sheet closes it, says so, and reads the '
        'Swarms again', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      int lists() =>
          fake.paths.where((p) => p == '/api/super-tabs/list').length;
      final before = lists();
      await open(tester);

      await tester.tap(key('swarm-home-refresh'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(key('swarm-view-sort'), findsNothing, reason: 'the sheet closed');
      expect(find.text('Refreshing…'), findsOneWidget);
      expect(lists(), greaterThan(before));
      await tester.pumpAndSettle();
    });

    Map<String, dynamic> tagInWeb() => {
      'mentions': [
        {
          'id': 'm1',
          'projectId': web,
          'projectName': 'Web',
          'conversationId': webLead,
          'conversationTitle': 'Web',
          'messageId': 'msg-tag',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };

    testWidgets('Mentions lists only where the person is tagged, not what is '
        'merely unread', (tester) async {
      await pump(tester, backend(mentions: (_) => tagInWeb()));
      await open(tester);
      await tapRow(tester, 'swarm-view-filter');
      await tapRow(tester, 'swarm-view-filter-mentions');
      await close(tester);
      expect(project_(web), findsOneWidget);
      expect(project_(project), findsNothing);
      expect(dot(), findsOneWidget);
    });

    testWidgets('Mentions with none says so, only once its read answered: a '
        'skeleton until then, never a false "No mentions"', (tester) async {
      final answer = Completer<Object?>();
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      await pump(
        tester,
        backend(mentions: (_) => answer.future),
        store: store,
        settle: false,
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(project_(project), findsNothing);
      expect(find.text('No mentions.'), findsNothing);

      answer.complete({'mentions': <Object>[]});
      await tester.pumpAndSettle();
      expect(find.text('No mentions.'), findsOneWidget);
      expect(key('swarm-filter-show-all'), findsOneWidget);
    });

    testWidgets('a failed read of the mentions is not none: it says so, keeps '
        'Show all, and a later read that answers brings them', (tester) async {
      var fail = true;
      final fake = backend(
        mentions: (_) {
          if (fail) {
            throw SuperTabFailure('BUSY', 'Busy', statusCode: 503);
          }
          return tagInWeb();
        },
      );
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      // The mentions' skeleton breathes while the read is retried, so the
      // screen never settles until it answers.
      final host = await pump(tester, fake, store: store, settle: false);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Mentions could not be read.'), findsOneWidget);
      expect(find.text('No mentions.'), findsNothing);
      expect(key('swarm-filter-show-all'), findsOneWidget);
      expect(find.textContaining('0 need you'), findsNothing);

      fail = false;
      await host.session!.inbox.asks(tab)!.load();
      await tester.pumpAndSettle();
      expect(project_(web), findsOneWidget);
      expect(find.text('Mentions could not be read.'), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-need-line'),
          matching: find.textContaining('1 need you'),
        ),
        findsOneWidget,
      );
    });

    /// [fake] with a second Swarm, whose mentions [read] answers.
    void secondSwarm(
      FakeSwarm fake,
      FutureOr<Object?> Function(Map<String, dynamic>?) read,
    ) {
      const second = 'tab-2';
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': second, 'name': 'Other Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      const derived = {'mentionsWaiting': 1};
      fake.routes['/api/super-tabs/$second/parts'] = (_) =>
          firstLoad(tabId: second, derived: derived);
      fake.routes['/api/super-tabs/$second/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$second/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$second/mentions?state=waiting'] = read;
    }

    testWidgets('one Swarm\'s mentions failing says so even with another '
        'Swarm\'s mention listed, and goes once it answers', (tester) async {
      var fail = true;
      final fake = backend(mentions: (_) => tagInWeb());
      secondSwarm(fake, (_) {
        if (fail) {
          throw SuperTabFailure('BUSY', 'Busy', statusCode: 503);
        }
        return {'mentions': <Object>[]};
      });
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      final host = await pump(tester, fake, store: store);
      expect(project_(web), findsOneWidget);
      expect(key('swarm-mentions-failed'), findsOneWidget);
      expect(key('swarm-filter-show-all'), findsNothing);

      fail = false;
      await host.session!.inbox.asks('tab-2')!.load();
      await tester.pumpAndSettle();
      expect(project_(web), findsOneWidget);
      expect(key('swarm-mentions-failed'), findsNothing);
    });

    testWidgets('a failed read of a Swarm then taken away does not keep '
        'saying so', (tester) async {
      final fake = backend(mentions: (_) => tagInWeb());
      secondSwarm(
        fake,
        (_) => throw SuperTabFailure('BUSY', 'Busy', statusCode: 503),
      );
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      final host = await pump(tester, fake, store: store);
      expect(key('swarm-mentions-failed'), findsOneWidget);

      host.session!.inbox.reader('tab-2')!.revoke();
      await tester.pump();
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(key('swarm-mentions-failed'), findsNothing);
    });

    testWidgets('a cold start with Mentions saved shows one skeleton, not '
        'two', (tester) async {
      final parts = Completer<Object?>();
      final answer = Completer<Object?>();
      final fake = backend(mentions: (_) => answer.future);
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        await parts.future;
        return load(body);
      };
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      await pump(tester, fake, store: store, settle: false);
      await tester.pump(const Duration(milliseconds: 100));
      expect(key('swarm-mentions-loading'), findsNothing);
      expect(find.byType(SwarmSkeletonRows), findsOneWidget);

      parts.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(key('swarm-mentions-loading'), findsWidgets);
      answer.complete({'mentions': <Object>[]});
      await tester.pumpAndSettle();
    });

    testWidgets('a choice is still there after the app is opened again', (
      tester,
    ) async {
      final store = MemoryKeyValueStore();
      await pump(tester, backend(), store: store);
      await open(tester);
      await tapRow(tester, 'swarm-view-filter');
      await tapRow(tester, 'swarm-view-filter-unread');
      await close(tester);
      await tester.pumpWidget(const SizedBox());

      await pump(tester, backend(), store: store);
      expect(dot(), findsOneWidget);
      expect(project_(web), findsNothing);
      expect(project_(project), findsOneWidget);
    });

    testWidgets('signed out with the menu open: it closes, and nothing is '
        'kept of a tap', (tester) async {
      final account = ValueNotifier<String?>(me);
      final store = MemoryKeyValueStore();
      await pump(tester, backend(), signedIn: account, store: store);
      await open(tester);
      await tapRow(tester, 'swarm-view-filter');
      expect(key('swarm-view-filter-unread'), findsOneWidget);

      account.value = null;
      await tester.pumpAndSettle();

      expect(key('swarm-view-filter'), findsNothing);
      expect(store.values['swarm_home.$me'] ?? '', isNot(contains('unread')));
    });

    testWidgets('another account signing in with the menu open: it closes, '
        'and the new account has its own defaults', (tester) async {
      final account = ValueNotifier<String?>(me);
      final host = await pump(tester, backend(), signedIn: account);
      await open(tester);
      final first = host.session!;
      first.home.setFilter(SwarmHomeFilter.unread);
      await tester.pump();

      account.value = 'person-other';
      await tester.pumpAndSettle();

      expect(key('swarm-view-filter'), findsNothing);
      expect(host.session, isNot(first));
      expect(host.session!.home.filter, SwarmHomeFilter.all);
    });

    testWidgets('the last Swarm gone from the list with the menu open: it '
        'closes', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await open(tester);
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-view-filter'), findsNothing);
    });

    testWidgets('access revoked with a filter on and the menu open: the '
        'project rows go, and the menu shows nothing of the Swarm', (
      tester,
    ) async {
      final host = await pump(tester, backend());
      await open(tester);
      await tapRow(tester, 'swarm-view-filter');
      await tapRow(tester, 'swarm-view-filter-unread');
      expect(project_(project), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(project_(project), findsNothing);
      expect(project_(web), findsNothing);
      expect(find.text('Mobile'), findsNothing);
      expect(find.text('Web'), findsNothing);
    });

    testWidgets('a Swarm id the account does not have changes nothing under a '
        'filter: no row of it, no name', (tester) async {
      final host = await pump(tester, backend());
      host.session!.home.setFilter(SwarmHomeFilter.unread);
      await tester.pump();
      host.session!.home.show('tab-other-not-listed');
      await tester.pumpAndSettle();
      expect(find.byType(SwarmHomeProjectRow), findsOneWidget);
      expect(project_(project), findsOneWidget);
    });

    testWidgets('a tag in a private chat or a Buddy chat does not list its '
        'project under Mentions', (tester) async {
      Map<String, dynamic> tagIn(String chat) => {
        'id': 'm-$chat',
        'projectId': web,
        'projectName': 'Web',
        'conversationId': chat,
        'conversationTitle': 'Secret title',
        'messageId': 'msg-$chat',
        'leadName': 'River',
        'text': 'private',
      };
      final fake = backend(
        mentions: (_) => {
          'mentions': [tagIn('g-private'), tagIn('g-buddy')],
        },
      );
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = await load(body) as Map<String, dynamic>;
        return {
          ...read,
          'groups': [
            ...read['groups'] as List,
            part('g-private', 90, {
              ...groupData(
                'g-private',
                title: 'Secret title',
                audience: [me, 'ken'],
              ),
              'projectId': web,
            }),
            part('g-buddy', 91, {
              ...buddyChatData('g-buddy', owner: me),
              'projectId': web,
            }),
          ],
        };
      };
      final store = MemoryKeyValueStore()
        ..values['swarm_home.$me'] = jsonEncode({'filter': 'mentions'});
      await pump(tester, fake, store: store);
      expect(project_(web), findsNothing);
      expect(find.text('No mentions.'), findsOneWidget);
      expect(find.text('Secret title'), findsNothing);
    });
  });
}
