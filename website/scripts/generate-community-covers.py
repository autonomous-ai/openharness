"""Regenerate the authored starter covers. All artwork is local and original."""
from pathlib import Path
from html import escape
import math

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'open-harnesses'

def text(x, y, value, size=28, color='#242424', family='Arial, sans-serif', extra=''):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-family="{family}" {extra}>{escape(value)}</text>'

def rect(x, y, w, h, fill, extra=''):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" {extra}/>'

def circle(x, y, r, fill):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}"/>'

def cover(slug, bg, shapes):
    (ROOT / slug / 'cover.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">{rect(0,0,900,600,bg)}{shapes}</svg>\n')

phone = rect(0, 0, 220, 416, '#353043', 'rx="46"') + rect(11, 12, 198, 392, '#fcfaff', 'rx="35"')
phone += rect(78, 24, 62, 8, '#353043', 'rx="4"') + text(30, 94, 'Your balance', 17, '#81768b') + text(29, 143, '$2,840.00', 30, '#29243c')
for i,h in enumerate([45,72,59,105,90,136]): phone += rect(30+i*27,320-h,18,h,'#a991da','rx="4"')
phone += rect(30,344,160,8,'#ebe5f5','rx="4"') + rect(30,366,115,8,'#ebe5f5','rx="4"')
cover('pocket-film', '#e5def6', text(62,82,'MEET POCKET.',22,'#29243c',extra='letter-spacing="4"') + ''.join(text(60,315+i*75,line,80,'#29243c',extra='font-weight="700" letter-spacing="-4"') for i,line in enumerate(['Small app.','Big','possibilities.'])) + f'<g transform="translate(570 77) rotate(10 110 208)">{phone}</g>')

game = text(60,84,'MOONLIGHT',30,'#eee3c5','monospace', 'letter-spacing="5"') + circle(760,104,45,'#e4daba')
for i in range(10): game += f'<path d="M{i*110-70} 575L{i*110} {250+i%3*28}L{i*110+70} 575Z" fill="#253a4e"/>'
game += rect(0,548,900,52,'#436c58')+rect(0,548,900,10,'#91b27f')
for x,y,w in [(235,441,155),(500,332,125),(685,440,135)]: game += rect(x,y,w,15,'#91b27f') + rect(x,y+15,w,16,'#436c58') + circle(x+w/2,y-40,7,'#e6c572')
game += rect(106,492,34,45,'#f2b552','rx="5"')+rect(130,503,6,6,'#192b42')
cover('moonlight','#192b42',game)

report = rect(72,116,756,377,'#fff')+text(115,177,'THE QUARTER IN FOCUS',18,'#73877c')+text(758,177,'Q3',18,'#73877c')+text(115,254,'A good kind of up.',51,'#294a3c',extra='letter-spacing="-2"')
report += '<path d="M115 438L180 424L245 433L310 391L375 409L440 374L505 387L570 342L635 357L700 313L783 295L783 461L115 461Z" fill="#e6f1e9"/><path d="M115 438L180 424L245 433L310 391L375 409L440 374L505 387L570 342L635 357L700 313L783 295" fill="none" stroke="#739781" stroke-width="5"/>'
cover('sales-story','#e6eeea',report)

lamp = '<ellipse cx="450" cy="490" rx="176" ry="25" fill="#c9bdac"/>' + rect(440,290,20,174,'#706550')+'<ellipse cx="450" cy="467" rx="93" ry="16" fill="#9f8f74"/>'
for i in range(34):
    left=270+i*360/34; right=left+360/34; tl=345+i*210/34; tr=tl+210/34
    lamp += f'<path d="M{tl:.1f} 130L{tr:.1f} 130L{right:.1f} 355Q{(left+right)/2:.1f} 370 {left:.1f} 355Z" fill="{["#dba363","#f2c68c"][i%2]}"/>'
cover('pleat','#e8dfd2',lamp+text(45,553,'PLEAT / A STUDY IN LIGHT',17,'#716550','monospace'))

planner=rect(0,0,696,390,'#fffdf8')+text(43,55,'SUNDAY',14,'#a18974',extra='letter-spacing="3"')+text(43,111,'A little room to breathe.',38,'#584338','Georgia,serif')
for i,(task,day) in enumerate([('Sketch the new collection','MON'),('Take the long way home','TUE'),('Make something just for fun','WED')]):
    y=180+i*66; planner+=circle(51,y-5,5,'none').replace('fill="none"','fill="none" stroke="#cab19b"')+text(71,y,task,20,'#695244')+text(604,y,day,12,'#aa927f')+rect(44,y+23,607,1,'#ede5da')
cover('sunday','#f2dccc',f'<g transform="translate(104 100) rotate(-3 348 195)">{planner}</g>')

orbits='<g transform="translate(450 300) rotate(-20)">'
for r in [140,250,350]: orbits+=f'<ellipse cx="0" cy="0" rx="{r}" ry="{r*.53}" fill="none" stroke="#33445e" stroke-width="2"/>'
orbits+=circle(0,0,35,'#efbb75')+circle(-130,83,14,'#90b5b7')+circle(240,-60,20,'#b67e71')+circle(-265,-116,9,'#92a0c0')+'</g>'+text(45,551,'ORBIT / A LITTLE PERSPECTIVE',16,'#9faec7','monospace')
cover('orbit','#131d32',orbits)

music=text(177,251,'BLUE',151,'#f5edcc',extra='font-weight="700" letter-spacing="-12"')+text(177,381,'HOUR.',151,'#f5edcc',extra='font-weight="700" letter-spacing="-12"')
for i in range(24):
    h=30+(math.sin(i*1.7)+1)*36; music+=rect(189+i*20,452-h/2,9,h,'#f5edcc','rx="4"')
cover('blue-hour','#315be4',music+text(45,551,'AN EIGHT-STEP INSTRUMENT',17,'#f5edcc','monospace'))

book=rect(15,8,279,403,'#c4aa84')+rect(7,0,279,399,'#fff9ef')+rect(0,0,279,399,'#8b4239')+text(33,50,'FIELD NOTES',14,'#f3dcc8',extra='letter-spacing="3"')
for i,word in enumerate(['On','paying','attention.']): book+=text(32,154+i*56,word,48,'#f3dcc8','Georgia,serif', 'letter-spacing="-2"')
cover('field-notes','#eddbc2',f'<g transform="translate(300 94) rotate(-9 140 200)">{book}</g>'+text(45,551,'WORDS TO SOMETHING YOU CAN HOLD',16,'#85664d','monospace'))

poster=circle(356,251,214,'#f7bc75')
for i,word in enumerate(['make','some','space.']): poster+=text(255,214+i*111,word,138,'#281b1a','Georgia,serif', 'letter-spacing="-8"')
cover('make-space','#f0633c',poster+text(45,551,'A LITTLE ROOM FOR YOUR OWN WORDS',16,'#281b1a','monospace'))
