import json, re, sys
S = sys.argv[1]
page = open(S + '/terminal-creatures.html').read()
sec = open(S + '/hurd-section.html').read()
plates = open(S + '/plates.json').read().replace('</', '<\\/')
sec = sec.replace('__PLATES__', plates).replace('__SPRITES__', open(S + '/sprite-cells.json').read() if __import__('os').path.exists(S + '/sprite-cells.json') else '{}').replace('__PALETTE__', open('REPO/daemons/plates/palette.json').read())
if '<!-- hurd:start -->' in page:
    page = re.sub(r'  <!-- hurd:start -->.*?<!-- hurd:end -->\n', lambda m: sec, page, flags=re.S)
else:
    anchor = '  <section aria-labelledby="s-hatch">'
    assert anchor in page
    page = page.replace(anchor, sec + '\n' + anchor, 1)
open(S + '/terminal-creatures.html', 'w').write(page)
print(len(page))
