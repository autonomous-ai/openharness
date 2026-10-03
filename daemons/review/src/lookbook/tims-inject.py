import re, sys
S = sys.argv[1]
page = open(S + '/terminal-creatures.html').read()
sec = open(S + '/tims-section.html').read().replace('__TIMS__', open(S + '/tims.json').read().replace('</', '<\\/'))
if '<!-- tims:start -->' in page:
    page = re.sub(r'  <!-- tims:start -->.*?<!-- tims:end -->\n', lambda m: sec, page, flags=re.S)
else:
    anchor = '  <!-- eggs:start -->'
    assert page.count(anchor) == 1
    page = page.replace(anchor, sec + '\n' + anchor, 1)
open(S + '/terminal-creatures.html', 'w').write(page)
print(len(page))
