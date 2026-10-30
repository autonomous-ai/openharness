export type ConversationTurn = { role: 'user' | 'assistant' | 'tool'; text: string };
export type SourceFile = { path: string; content: string; encoding?: 'base64' };
export type HarnessSnapshot = {
  title: string;
  description: string;
  category: string;
  engine: string;
  harnessId?: string;
  harnessName?: string;
  files: SourceFile[];
  viewerPath: string;
  conversation: ConversationTurn[];
  cover?: string;
  forkedFrom?: string;
  credits?: { id: string; authorName: string }[];
};
export type HarnessSummary = {
  id: string;
  title: string;
  description: string;
  category: string;
  engine: string;
  harnessId?: string;
  harnessName?: string;
  authorId: string;
  authorName: string;
  cover?: string;
  createdAt: string;
  example?: boolean;
  recording?: string;
  forkedFrom?: string;
  /** When its author last edited it; a feed from an older backend leaves it out. */
  updatedAt?: string | null;
};
/**
 * `updatedAt`: when its author last edited it. `origin`: the publication it was forked from, by name,
 * or null once that one is no longer published; left out for a fork of a starter and by an older backend.
 */
export type OpenHarness = HarnessSummary & HarnessSnapshot & { updatedAt?: string | null; origin?: { title: string; authorName: string } | null };
export type HarnessComment = { id: string; body: string; authorName: string; createdAt: string; mine: boolean; creator?: boolean; parentId?: string; parentAuthorName?: string };
export type SocialState = {
  likes: number;
  liked: boolean;
  following: boolean;
  /** The latest comments (the backend sends at most 100), oldest first. */
  comments: HarnessComment[];
  signedIn: boolean;
  mine: boolean;
  /** Every comment, and every public fork. A backend older than these counts leaves them out. */
  commentCount?: number;
  forks?: number;
  /** When its author last edited it (null if never); a backend older than it leaves it out. */
  updatedAt?: string | null;
};
/** A creator's page: the name their publications carry, who follows them, and the reader's follow. */
export type Creator = { id: string; name: string; followers: number; following: boolean; mine: boolean; signedIn: boolean };
