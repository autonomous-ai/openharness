/// The visible name of a person's private chat with a project's Product
/// Manager (docs/naming-system.md).
const kChatWithPm = 'Chat with PM';

/// How far a sidebar or tab count goes: from here on it says "99+".
const kCountCap = 100;

/// A count as a badge shows it: "7", or "99+" from [kCountCap] on.
String countText(int count) =>
    count >= kCountCap ? '${kCountCap - 1}+' : '$count';

/// What a PM chat's unread count says: "2 new in Chat with PM".
String pmUnreadLabel(int count) => '${countText(count)} new in $kChatWithPm';
