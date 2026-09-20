"""Independent GEOS geometry, stdlib CSV/XML and archive verification.

Run with Shapely 2.0.7 and NumPy 1.26.4. No application geometry code is imported.
"""
import csv
import hashlib
import io
import json
import math
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from shapely.geometry import Polygon, Point, LineString, shape
from shapely.ops import unary_union

root = Path(sys.argv[1])
acceptance = json.loads((root / 'acceptance.json').read_text())
checks = []
for brief in acceptance['results']:
    for delivery in brief['deliveries']:
        directory = Path(delivery['output'])
        data = json.loads(Path(delivery['geometry']).read_text())
        project, settings = data['project'], data['project']['settings']
        boundaries = unary_union([Polygon(a['ring']) for a in project['areas'] if a['kind'] == 'boundary'])
        exclusions = unary_union([Polygon(a['ring']) for a in project['areas'] if a['kind'] == 'exclusion'])
        target = boundaries.difference(exclusions)
        region = boundaries.buffer(-settings['margin'], join_style=2, mitre_limit=2).difference(exclusions.buffer(settings['margin'], join_style=2, mitre_limit=2))
        assert region.is_valid and target.is_valid
        assert abs(target.area - data['area']) < .02
        # Clipper millimeter rounding and GEOS offset implementation can differ by
        # up to a millimeter near corners. The 3 mm tolerance is stated, not hidden.
        allowed = region.buffer(.003)
        for sortie in data['sorties']:
            route = LineString(sortie['path'])
            assert allowed.covers(route), ('route leaves region', brief['title'], delivery['stage'], sortie['id'])
            assert abs(route.length - sortie['distance']) < 1e-6
            assert Point(sortie['path'][0]).distance(Point(project['home'])) < 1e-8
            assert Point(sortie['path'][-1]).distance(Point(project['home'])) < 1e-8
            assert sortie['seconds'] <= settings['usableMinutes'] * 60 * (1 - settings['reservePercent'] / 100) + .001
        # Recompute all ideal footprints using the actual camera and run headings.
        camera = project['camera']
        width = settings['height'] * camera['sensorWidth'] / camera['focalLength']
        along = settings['height'] * camera['sensorHeight'] / camera['focalLength']
        footprints = []
        for photo in data['photos']:
            a = math.radians(photo['heading'])
            u, v = (math.cos(a), math.sin(a)), (-math.sin(a), math.cos(a))
            footprints.append(Polygon([(photo['point'][0] + u[0] * x * along / 2 + v[0] * y * width / 2,
                                        photo['point'][1] + u[1] * x * along / 2 + v[1] * y * width / 2)
                                       for x, y in [(-1,-1),(1,-1),(1,1),(-1,1)]]))
        coverage = target.intersection(unary_union(footprints)).area / target.area
        assert abs(coverage - data['coverage']) < .0001
        geo = json.loads((directory / 'survey.geojson').read_text())
        assert geo['type'] == 'FeatureCollection'
        for feature in geo['features']:
            geom = shape(feature['geometry'])
            assert geom.is_valid, (feature['properties']['name'], 'invalid exported GeoJSON')
            if not geom.is_empty:
                x0,y0,x1,y1 = geom.bounds
                assert -180 <= x0 <= x1 <= 180 and -85 <= y0 <= y1 <= 85
        photo_rows = list(csv.DictReader((directory / 'planned-photos.csv').open()))
        assert len(photo_rows) == len(data['photos'])
        by_id = {f['properties']['photo']: f for f in geo['features'] if f['properties']['kind'] == 'planned-photo'}
        for row in photo_rows:
            point = by_id[int(row['photo'])]['geometry']['coordinates']
            assert point == [float(row['longitude_deg']),float(row['latitude_deg'])]
            assert float(row['height_above_takeoff_m']) == settings['height']
        kml = ET.parse(directory / 'overlay.kml')
        ns = {'k':'http://www.opengis.net/kml/2.2'}
        lines = kml.findall('.//k:LineString',ns)
        assert len(lines) == len(data['sorties'])
        for line, sortie in zip(lines,data['sorties']):
            assert line.find('k:altitudeMode',ns).text == 'clampToGround'
            coords = [tuple(map(float,s.split(','))) for s in line.find('k:coordinates',ns).text.split()]
            assert len(coords) == len(sortie['path']) and all(c[2] == 0 for c in coords)
        archives = list(directory.glob('*-field-kit.zip'))
        assert len(archives) == 1
        with zipfile.ZipFile(archives[0]) as kit:
            assert kit.testzip() is None
            for name in delivery['files']:
                assert kit.read(name) == (directory / name).read_bytes()
            assert 'Tom Wu' in kit.read('LICENSES.txt').decode()
            if project.get('log'):
                raw = kit.read('recorded-source.csv')
                assert raw.decode() == project['log']['raw']
                assert hashlib.sha256(raw).hexdigest() == project['log']['sha256']
                normalized = list(csv.DictReader(io.StringIO(kit.read('recorded-normalized.csv').decode())))
                assert len(normalized) == len(project['log']['records'])
                assert sum(row['capture_event'] == '1' for row in normalized) == sum(row['capture'] is True for row in project['log']['records'])
        checks.append({'title':brief['title'],'stage':delivery['stage'],'routes':len(data['sorties']),'photos':len(data['photos']),'coverage':coverage,'geometryToleranceM':.003})
result = {'reader':'GEOS through Shapely 2.0.7; Python CSV, XML and ZIP','checks':checks,'limits':'This verifies supplied geometry and files. No native GIS/ground-station import, real flight, airspace, terrain or customer trial is claimed.'}
(root / 'independent-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
