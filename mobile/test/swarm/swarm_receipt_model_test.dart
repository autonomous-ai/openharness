import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// Which recipient's copy a message's receipt speaks of, read as the desktop's
/// model reads it (super_tab_receipt_test): one agent's cancelled copy is not
/// the receipt while another recipient got the message (10-30), and one still
/// waiting keeps the receipt waiting.
void main() {
  Map<String, dynamic> row(String agentId, String status) => {
    'id': 'delivery-$agentId',
    'agentId': agentId,
    'status': status,
  };
  String? receipt(List<Map<String, dynamic>> deliveries) =>
      SuperTabMessage.fromJson({
        'id': 'm1',
        'conversationId': 'g1',
        'text': '@Lead @Builder please start',
        'sequence': 1,
        'author': {'kind': 'person', 'id': 'me', 'name': 'tony'},
        'deliveries': deliveries,
      }).receiptDelivery?.status;

  test('one copy cancelled while another arrived is not the receipt', () {
    for (final arrived in ['delivered', 'confirmed', 'answered']) {
      final rows = [
        row('agent-lead', arrived),
        row('agent-builder', 'cancelled'),
      ];
      expect(receipt(rows), arrived);
      expect(receipt(rows.reversed.toList()), arrived);
    }
  });

  test('every copy cancelled is still the receipt', () {
    expect(receipt([row('agent-builder', 'cancelled')]), 'cancelled');
  });

  test('a copy still waiting keeps the receipt waiting', () {
    expect(
      receipt([row('agent-lead', 'queued'), row('agent-builder', 'cancelled')]),
      'queued',
    );
    expect(
      receipt([
        row('agent-builder', 'cancelled'),
        row('agent-lead', 'claimed'),
      ]),
      'claimed',
    );
    expect(
      receipt([
        row('agent-lead', 'answered'),
        row('agent-builder', 'uncertain'),
      ]),
      'uncertain',
    );
  });
}
