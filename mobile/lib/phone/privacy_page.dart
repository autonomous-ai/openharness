import 'package:flutter/material.dart';

import '../shared/widgets/product_feedback.dart';
import 'privacy_shared_fields.dart';

typedef UsagePreferenceRequest = Future<Map<String, dynamic>> Function({
  bool? enabled,
});

/// Account-wide privacy control, available without a connected computer.
class PrivacyPage extends StatefulWidget {
  const PrivacyPage({super.key, required this.request, this.feedback});
  final UsagePreferenceRequest request;
  final ProductFeedbackRequest? feedback;

  @override
  State<PrivacyPage> createState() => _PrivacyPageState();
}

class _PrivacyPageState extends State<PrivacyPage> {
  bool? _enabled;
  bool _busy = true, _details = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read({bool? enabled}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.request(enabled: enabled);
      if (!mounted) return;
      if (result['enabled'] is! bool) throw const FormatException();
      setState(() {
        _enabled = result['enabled'] as bool;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = enabled == null ? 'Couldn’t load this setting. Try again.' : 'Couldn’t confirm the change. Reload to check your saved setting.';
          if (enabled != null) _enabled = null;
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Privacy')),
    // Not a lazy list: the feedback below the shared fields must keep its answer when scrolled away.
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_enabled == null)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Share product usage data'),
              subtitle: Text(
                _busy
                    ? 'Checking your saved preference…'
                    : 'Setting unavailable',
              ),
            )
          else
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Share product usage data'),
              subtitle: const Text(
                'Help improve Harness by sharing usage counts and duration statistics. '
                'Your prompts, code, files, and conversations are never included.',
              ),
              value: _enabled!,
              onChanged: _busy ? null : (value) => _read(enabled: value),
            ),
          if (_busy) const LinearProgressIndicator(),
          const SizedBox(height: 12),
          const Text(
            'Applies to every computer and app signed in to this account. '
            'Turning this off stops new product usage reports. Essential service and security records are separate.',
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!),
            TextButton(
              onPressed: _busy ? null : () => _read(),
              child: const Text('Reload'),
            ),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              onPressed: () => setState(() {
                _details = !_details;
              }),
              child: Text(
                _details ? 'Hide shared fields' : 'See what’s shared',
              ),
            ),
          ),
          if (_details) const PrivacySharedFields(),
          if (_enabled == true && widget.feedback != null) ...[
            const SizedBox(height: 12),
            const Divider(),
            ProductFeedback(send: widget.feedback!),
          ],
        ],
      ),
    ),
  );
}
