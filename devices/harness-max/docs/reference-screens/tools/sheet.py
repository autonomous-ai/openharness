import sys, os, re
from PIL import Image, ImageDraw, ImageFont
src, out, cols, cell = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
names = sys.argv[5:]
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
imgs = []
for n in names:
    im = Image.open(os.path.join(src, n + '.png')).convert('RGB')
    w = cell; h = round(im.height * cell / im.width)
    imgs.append((n, im.resize((w, h), Image.LANCZOS)))
h = max(i.height for _, i in imgs)
rows = (len(imgs) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (cell + 10) + 10, rows * (h + 32) + 10), (90, 90, 90))
d = ImageDraw.Draw(sheet)
for k, (n, im) in enumerate(imgs):
    x = 10 + (k % cols) * (cell + 10); y = 10 + (k // cols) * (h + 32)
    sheet.paste(im, (x, y)); d.text((x, y + h + 4), n, fill=(255, 255, 255), font=font)
sheet.save(out)
print(out, sheet.size)
