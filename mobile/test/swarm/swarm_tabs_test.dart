import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/swarm/swarm_needs_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_tabs.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A tab's screen that says which it is, whether it is out of sight, and how
/// often it was tapped; [made] records each time one is made.
class _Probe extends StatefulWidget {
  const _Probe(this.tab, this.made);

  final SwarmTab tab;
  final List<SwarmTab> made;

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  var _taps = 0;

  @override
  void initState() {
    super.initState();
    widget.made.add(widget.tab);
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.tab.name;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('$name screen'),
          Text('$name hidden: ${OutOfSight.of(context)}'),
          TextButton(
            onPressed: () => setState(() => _taps++),
            child: Text('$name taps $_taps'),
          ),
          TextButton(
            onPressed: () => showSwarmTab(context, SwarmTab.you),
            child: Text('$name to You'),
          ),
        ],
      ),
    );
  }
}

const _names = {
  SwarmTab.home: 'Home',
  SwarmTab.buddies: 'Buddies',
  SwarmTab.activity: 'Activity',
  SwarmTab.you: 'You',
};

/// All four tabs, each showing a [_Probe].
List<SwarmTabEntry> _probes(
  List<SwarmTab> made, {
  SwarmTabBadge? Function(SwarmSession session)? activity,
}) => [
  for (final tab in SwarmTab.values)
    SwarmTabEntry(
      tab: tab,
      label: _names[tab]!,
      icon: Icons.circle_outlined,
      screen: (_) => _Probe(tab, made),
      badge: tab == SwarmTab.activity ? activity : null,
    ),
];

/// The notices the phone would post.
class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);
}

/// One Swarm with one project, and River asking the person to ship it.
FakeSwarm _asking() {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
    derived: derived,
    agents: [agent('agent-lead', name: 'Lead', displayName: 'River')],
  );
  fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
      changes(cursor: 'c2', derived: derived);
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': [
      {
        'id': 'd1',
        'conversationId': leadChat,
        'askerName': 'River',
        'question': 'Ship it?',
        'options': ['Yes', 'No'],
      },
    ],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  return fake;
}

/// Swarm's own tabs, with a stand-in for the phone's Settings.
const _tabs = SwarmTabsPage(settings: _settings);

Widget _settings(BuildContext context) => const Text('the settings');

void main() {
  late SwarmHost host;
  late _Notices notices;

  /// [child] on a 390-point phone, under the account's Swarm: [fake]'s, or
  /// no Swarm listed yet.
  Future<void> pump(
    WidgetTester tester,
    Widget child, {
    FakeSwarm? fake,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    if (fake == null) {
      fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
    }
    notices = _Notices();
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: notices,
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: child,
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder tabOf(SwarmTab tab) => find.byKey(ValueKey('swarm-tab-${tab.name}'));

  Future<void> open(WidgetTester tester, SwarmTab tab) async {
    await tester.tap(tabOf(tab));
    await tester.pumpAndSettle();
  }

  Finder said(String text) => find.text(text, skipOffstage: false);

  testWidgets('the bar reads Home, Activity and You, and opens on Swarm '
      'Home; Buddies waits for its screen', (tester) async {
    await pump(tester, _tabs);

    const shown = [SwarmTab.home, SwarmTab.activity, SwarmTab.you];
    final xs = [for (final tab in shown) tester.getCenter(tabOf(tab)).dx];
    expect([...xs]..sort(), xs, reason: 'left to right in this order');
    for (final tab in shown) {
      expect(
        find.descendant(of: tabOf(tab), matching: find.text(_names[tab]!)),
        findsOneWidget,
      );
    }
    expect(tabOf(SwarmTab.buddies), findsNothing);
    expect(find.text('Coming soon.', skipOffstage: false), findsNothing);
    expect(find.byType(SwarmPage), findsOneWidget);
    // The open tab's name in the main ink, bold; the others quiet.
    Text label(String text) => tester.widget<Text>(find.text(text));
    expect(label('Home').style!.color, AppPalette.textPrimary);
    expect(label('Home').style!.fontWeight, FontWeight.w600);
    expect(label('Activity').style!.color, AppPalette.textSecondary);
    expect(
      tester.getSemantics(tabOf(SwarmTab.home)),
      matchesSemantics(
        label: 'Home',
        isButton: true,
        hasSelectedState: true,
        isSelected: true,
        hasTapAction: true,
      ),
    );
  });

  testWidgets('a tab tapped shows its screen, and the others stay as they '
      'were, out of sight', (tester) async {
    final made = <SwarmTab>[];
    await pump(tester, SwarmTabsPage(settings: _settings, tabs: _probes(made)));
    await tester.tap(find.text('home taps 0'));
    await tester.pump();

    await open(tester, SwarmTab.activity);

    expect(find.text('activity screen'), findsOneWidget);
    expect(find.text('home screen'), findsNothing, reason: 'out of sight');
    expect(said('home hidden: true'), findsOneWidget);
    expect(said('activity hidden: false'), findsOneWidget);
    expect(
      tester.getSemantics(tabOf(SwarmTab.activity)),
      matchesSemantics(
        label: 'Activity',
        isButton: true,
        hasSelectedState: true,
        isSelected: true,
        hasTapAction: true,
      ),
    );

    await open(tester, SwarmTab.home);

    expect(find.text('home taps 1'), findsOneWidget);
    expect(said('activity hidden: true'), findsOneWidget);
  });

  testWidgets('each screen is made the first time its tab opens, and only '
      'then', (tester) async {
    final made = <SwarmTab>[];
    await pump(tester, SwarmTabsPage(settings: _settings, tabs: _probes(made)));
    expect(made, [SwarmTab.home]);

    await open(tester, SwarmTab.buddies);
    await open(tester, SwarmTab.activity);
    await open(tester, SwarmTab.buddies);
    await open(tester, SwarmTab.home);
    await open(tester, SwarmTab.home);

    expect(made, [SwarmTab.home, SwarmTab.buddies, SwarmTab.activity]);
  });

  testWidgets('a count shows on its tab while there is one, and follows the '
      'Swarm', (tester) async {
    // A count the test can move: the projects pinned.
    SwarmTabBadge? pins(SwarmSession session) =>
        (count: session.home.pins.length, warn: true);
    await pump(
      tester,
      SwarmTabsPage(
        settings: _settings,
        tabs: _probes([], activity: pins),
      ),
    );
    final badge = find.byKey(const ValueKey('swarm-tab-badge-activity'));
    expect(badge, findsNothing, reason: 'none for a count of 0');

    host.session!.home.pin('swarm-1', 'project-1', true);
    host.session!.home.pin('swarm-1', 'project-2', true);
    await tester.pump();

    expect(
      find.descendant(of: badge, matching: find.text('2')),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(tabOf(SwarmTab.activity)),
      matchesSemantics(
        label: 'Activity, 2',
        isButton: true,
        hasSelectedState: true,
        hasTapAction: true,
      ),
    );
    // The badge sits on the glyph, inside the tab.
    final tabBox = tester.getRect(tabOf(SwarmTab.activity));
    expect(tabBox.contains(tester.getCenter(badge)), isTrue);

    host.session!.home.pin('swarm-1', 'project-1', false);
    host.session!.home.pin('swarm-1', 'project-2', false);
    await tester.pump();

    expect(badge, findsNothing);
  });

  testWidgets('every tab takes a thumb: at least 44 points each way, the bar '
      'across the foot, above the home indicator', (tester) async {
    tester.view.padding = const FakeViewPadding(bottom: 34 * 3);
    await pump(tester, SwarmTabsPage(settings: _settings, tabs: _probes([])));

    for (final tab in SwarmTab.values) {
      final size = tester.getSize(tabOf(tab));
      expect(size.width, greaterThanOrEqualTo(44), reason: tab.name);
      expect(size.height, greaterThanOrEqualTo(44), reason: tab.name);
    }
    final bar = tester.getRect(find.byType(SwarmTabBar));
    expect(bar.width, 390);
    expect(bar.bottom, 844);
    expect(
      tester.getRect(tabOf(SwarmTab.home)).bottom,
      lessThanOrEqualTo(844 - 34),
      reason: 'the tabs clear the home indicator',
    );
  });

  for (final count in [3, 4]) {
    testWidgets('$count tabs share the bar alike, each a thumb\'s width or '
        'more, and each opens its own screen', (tester) async {
      final tabs = _probes([]);
      if (count == 3) tabs.removeWhere((e) => e.tab == SwarmTab.buddies);
      await pump(tester, SwarmTabsPage(settings: _settings, tabs: tabs));

      final rects = [for (final e in tabs) tester.getRect(tabOf(e.tab))];
      expect(rects, hasLength(count));
      for (final rect in rects) {
        expect(rect.width, closeTo(390 / count, .5));
        expect(rect.height, greaterThanOrEqualTo(44));
      }
      for (final (i, rect) in rects.indexed.skip(1)) {
        expect(rect.left, closeTo(rects[i - 1].right, .5), reason: 'no gap');
      }
      for (final e in tabs.reversed) {
        await open(tester, e.tab);
        expect(find.text('${e.tab.name} screen'), findsOneWidget);
      }
    });
  }

  testWidgets('back on another tab goes to Home; on Home it is not held', (
    tester,
  ) async {
    await pump(tester, SwarmTabsPage(settings: _settings, tabs: _probes([])));
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    await open(tester, SwarmTab.activity);

    expect(await navigator.maybePop(), isTrue);
    await tester.pumpAndSettle();

    expect(find.text('home screen'), findsOneWidget);
    expect(await navigator.maybePop(), isFalse);
  });

  testWidgets('out of sight under Harness, every tab is out of sight and back '
      'is not held', (tester) async {
    final hidden = ValueNotifier(false);
    await pump(
      tester,
      ValueListenableBuilder(
        valueListenable: hidden,
        builder: (context, value, child) =>
            OutOfSight(hidden: value, child: child!),
        child: SwarmTabsPage(settings: _settings, tabs: _probes([])),
      ),
    );
    await open(tester, SwarmTab.activity);

    hidden.value = true;
    await tester.pump();

    expect(said('activity hidden: true'), findsOneWidget);
    expect(said('home hidden: true'), findsOneWidget);
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    expect(await navigator.maybePop(), isFalse, reason: "Harness's back");

    hidden.value = false;
    await tester.pump();

    expect(said('activity hidden: false'), findsOneWidget);
    expect(said('home hidden: true'), findsOneWidget);
  });

  testWidgets('a screen under the tabs can open another tab; nothing else '
      'can', (tester) async {
    await pump(tester, SwarmTabsPage(settings: _settings, tabs: _probes([])));

    await tester.tap(find.text('home to You'));
    await tester.pumpAndSettle();

    expect(find.text('you screen'), findsOneWidget);
    expect(said('home hidden: true'), findsOneWidget);

    await pump(tester, const SizedBox());
    expect(
      showSwarmTab(tester.element(find.byType(SizedBox)), SwarmTab.home),
      isFalse,
    );
  });

  testWidgets('Activity opens Needs you, as a tab with no way back, and '
      'counts what waits on the person', (tester) async {
    await pump(tester, _tabs, fake: _asking());
    final badge = find.byKey(const ValueKey('swarm-tab-badge-activity'));
    expect(
      find.descendant(of: badge, matching: find.text('1')),
      findsOneWidget,
    );

    await open(tester, SwarmTab.activity);

    expect(find.byType(SwarmNeedsPage), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('swarm-title'))).data,
      'Needs you',
    );
    expect(find.byKey(const ValueKey('tty-back')), findsNothing);
    expect(find.text('Ship it?'), findsOneWidget);
  });

  testWidgets('You opens the phone\'s Settings', (tester) async {
    await pump(tester, _tabs);

    await open(tester, SwarmTab.you);

    expect(find.text('the settings'), findsOneWidget);
  });

  testWidgets('Needs you open on Activity mutes the notices it shows, and '
      'out of sight under Harness mutes none', (tester) async {
    final hidden = ValueNotifier(false);
    await pump(
      tester,
      ValueListenableBuilder(
        valueListenable: hidden,
        builder: (context, value, child) =>
            OutOfSight(hidden: value, child: child!),
        child: _tabs,
      ),
      fake: _asking(),
    );
    await open(tester, SwarmTab.activity);
    final need = host.session!.inbox.needs.single;

    host.session!.announce(need);
    expect(notices.shown, isEmpty, reason: 'on screen already');

    hidden.value = true;
    await tester.pump();
    host.session!.announce(need);

    expect(notices.shown.single.title, 'River asks you');
  });
}
