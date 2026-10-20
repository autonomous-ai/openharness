/// A read in one of its three states. Kept apart so "loading" and "answered
/// with nothing" never render the same.
sealed class FinderLoad<T> {
  const FinderLoad();
}

class FinderLoading<T> extends FinderLoad<T> {
  const FinderLoading();
}

class FinderLoaded<T> extends FinderLoad<T> {
  const FinderLoaded(this.value);
  final T value;
}

class FinderFailed<T> extends FinderLoad<T> {
  const FinderFailed(this.message);
  final String message;
}
