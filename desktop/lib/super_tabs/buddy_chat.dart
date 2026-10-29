/// The visible name of a person's private chat in a project: their Buddy
/// chat, where the PM's private lines to them land too, since Buddies replaced
/// Chat with PM (docs/naming-system.md).
const kBuddyChat = 'Buddy chat';

/// How far a sidebar or tab count goes: from here on it says "99+".
const kCountCap = 100;

/// A count as a badge shows it: "7", or "99+" from [kCountCap] on.
String countText(int count) =>
    count >= kCountCap ? '${kCountCap - 1}+' : '$count';

/// What the Buddy chats' unread count says: "2 new in your Buddy chat".
String buddyUnreadLabel(int count) =>
    '${countText(count)} new in your $kBuddyChat';
