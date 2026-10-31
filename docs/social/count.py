# Count a draft the way X does: a link counts as 23, emoji and CJK as 2.
# Usage: python3 -I docs/social/count.py docs/social/drafts/DATE.txt
import re,sys,unicodedata
t=open(sys.argv[1]).read().rstrip('\n')
# X weighting: URLs count 23; CJK/emoji count 2; others 1
url=re.compile(r'(https?://\S+|\b[\w-]+\.(?:com|ai|io|dev|org)(?:/\S*)?)')
n=0; pos=0
for m in url.finditer(t):
    n+=sum(2 if ord(c)>0x10FF else 1 for c in t[pos:m.start()]); n+=23; pos=m.end()
n+=sum(2 if ord(c)>0x10FF else 1 for c in t[pos:])
print(n, 'weighted chars;', len(t),'raw')
