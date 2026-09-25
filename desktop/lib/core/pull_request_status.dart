/// A PR reported by the owning machine. Only validated GitHub PR URLs become
/// clickable; missing access or a repository without a PR has no badge.
class PullRequestStatus {
  const PullRequestStatus(this.number, this.state, this.url);
  final int number;
  final String state;
  final Uri url;
  String get label => '#$number $state';

  static PullRequestStatus? fromResult(Map<String, dynamic>? result) {
    final number = result?['number'];
    final state = result?['state'];
    final url = Uri.tryParse(result?['url'] is String ? result!['url'] : '');
    if (result?['status'] != 'found' ||
        number is! int ||
        number <= 0 ||
        state is! String ||
        !const ['Draft', 'Open', 'Merged', 'Closed'].contains(state) ||
        url?.scheme != 'https' ||
        url?.host != 'github.com' ||
        url!.userInfo.isNotEmpty ||
        !url.path.endsWith('/pull/$number')) {
      return null;
    }
    return PullRequestStatus(number, state, url);
  }
}
