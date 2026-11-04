import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/local_time_zone.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

/// Huy (11-04): a person's card shows their local time, from the time zone
/// their own app tells the Swarm (River: its IANA name, not an offset).
Iterable<Map> _zoneReports(ConversationServer server) => server.posts
    .map((p) => p['command'] as Map)
    .where((c) => c['type'] == 'member.timeZone');

void main() {
  tearDown(() => superTabLocalTimeZoneOverride = null);

  test('reads a person’s zone', () {
    final person = SuperTabPerson.fromJson({
      'id': 'huy',
      'email': 'huy@example.com',
      'role': 'collaborator',
      'timeZone': 'Asia/Ho_Chi_Minh',
    });
    expect(person.timeZone, 'Asia/Ho_Chi_Minh');
    expect(
      SuperTabPerson.fromJson({
        'id': 'ivy',
        'email': 'ivy@example.com',
        'role': 'collaborator',
      }).timeZone,
      isNull,
    );
  });

  test('a zone is the name after zoneinfo in the localtime link', () {
    expect(
      superTabZoneFromLink('/var/db/timezone/zoneinfo/Asia/Ho_Chi_Minh'),
      'Asia/Ho_Chi_Minh',
    );
    expect(
      superTabZoneFromLink('/usr/share/zoneinfo/America/Argentina/Salta'),
      'America/Argentina/Salta',
    );
    expect(superTabZoneFromLink('/usr/share/zoneinfo/UTC'), 'UTC');
    expect(superTabZoneFromLink('/etc/foo'), isNull);
    expect(superTabZoneFromLink('/usr/share/zoneinfo/'), isNull);
  });

  test('reports the zone once when it differs from the stored one', () async {
    superTabLocalTimeZoneOverride = () => 'Asia/Ho_Chi_Minh';
    final server = ConversationServer();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await pumpEventQueue();
    expect(_zoneReports(server).map((c) => c['timeZone']), [
      'Asia/Ho_Chi_Minh',
    ]);
    await c.refresh();
    await pumpEventQueue();
    expect(
      c.snapshot!.people.firstWhere((p) => p.id == 'owner').timeZone,
      'Asia/Ho_Chi_Minh',
    );
    server.append('Later');
    await c.refresh();
    await pumpEventQueue();
    expect(_zoneReports(server), hasLength(1));
  });

  test('does not report a zone already stored', () async {
    superTabLocalTimeZoneOverride = () => 'Asia/Ho_Chi_Minh';
    final server = ConversationServer();
    ((server.state['people'] as List).first as Map)['timeZone'] =
        'Asia/Ho_Chi_Minh';
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await pumpEventQueue();
    expect(_zoneReports(server), isEmpty);
  });

  test('reports nothing when this computer names no zone', () async {
    superTabLocalTimeZoneOverride = () => null;
    final server = ConversationServer();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await pumpEventQueue();
    expect(_zoneReports(server), isEmpty);
  });

  test('a refused report is not sent again and shows nothing', () async {
    superTabLocalTimeZoneOverride = () => 'Europe/Berlin';
    final server = ConversationServer()
      ..unknownCommand = ((command) => command['type'] == 'member.timeZone');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await pumpEventQueue();
    server.append('Later');
    await c.refresh();
    await pumpEventQueue();
    expect(_zoneReports(server), hasLength(1));
    expect(c.error, isNull);
  });
}
