import re, sys
S = sys.argv[1]
page = open(S + '/terminal-creatures.html').read()
sec = open(S + '/eggs-section.html').read().replace('__EGGS__', open(S + '/eggs.json').read().replace('</', '<\\/'))
if '<!-- eggs:start -->' in page:
    page = re.sub(r'  <!-- eggs:start -->.*?<!-- eggs:end -->\n', lambda m: sec, page, flags=re.S)
else:
    anchor = '  <section aria-labelledby="s-hatch">'
    assert page.count(anchor) == 1
    page = page.replace(anchor, sec + '\n' + anchor, 1)
open(S + '/terminal-creatures.html', 'w').write(page)
print(len(page))
