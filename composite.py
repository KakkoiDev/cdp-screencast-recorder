# Composites the click ring and the cursor onto captured screencast frames and
# writes the ffmpeg concat list that stitches them.
#
# The ring is painted onto the frames, never into the page being recorded: the
# footage is evidence about that page and has to be recorded unmodified.
#
# The screencast only emits a frame when something changes on screen, so a
# static hold before a click produces no frames at all. A ring window that
# started inside such a gap would land on nothing. Each frame's displayed span
# is therefore split at the ring boundaries and the piece inside the window is
# written as a ringed copy with its own duration.
#
# The cursor forces a second kind of split. A frame held for seconds while the
# pointer travels across it would freeze the pointer, so a span the cursor moves
# across is subdivided on a fixed step and one copy is drawn per piece. That
# subdivision applies ONLY where the cursor actually moves. A span with the
# cursor at rest keeps its full duration in a single entry, so a long hold is
# still one long frame. See README, "What the cadence actually is".
#
# Input:  <frames dir>/capture.json
#           { "frames":  [{file, t}],
#             "rings":   [{x, y, w, h, t0, t1, label, unstable}],
#             "clicks":  [{t, x, y, label, kind}],
#             "viewport":{w, h},
#             "cursor":  "path/to/cursor.png" | null,
#             "cursorStep": 0.12 }
# Output: <frames dir>/concat.txt, and a JSON report on stdout.
import json, os, sys
from PIL import Image, ImageDraw

FRAMES = sys.argv[1]
cap = json.load(open(os.path.join(FRAMES, 'capture.json')))
frames = cap['frames']
rings = [r for r in cap.get('rings', []) if not r.get('unstable')]
skipped = [r for r in cap.get('rings', []) if r.get('unstable')]
clicks = sorted(cap.get('clicks', []), key=lambda c: c['t'])
step = float(cap.get('cursorStep') or 0.12)
cursor_img = None
if clicks and cap.get('cursor') and os.path.exists(cap['cursor']):
    cursor_img = Image.open(cap['cursor']).convert('RGBA')
vw = cap['viewport']['w']

gaps = [frames[i]['t'] - frames[i - 1]['t'] for i in range(1, len(frames))]
srt = sorted(gaps)
median = srt[len(srt) // 2] if srt else 0.1
spans = [min(max(g, 0.01), 5.0) for g in gaps] + [median]

# Frame pixels can differ from CSS pixels; the ring rect is in CSS pixels.
with Image.open(frames[0]['file']) as im:
    fw, fh = im.size
scale = fw / float(vw)


def ring_at(t):
    for r in rings:
        if r['t0'] <= t < r['t1']:
            return r
    return None


def ease(u):
    # easeInOutCubic: the pointer accelerates away from one target and settles
    # on the next instead of moving at a constant machine speed.
    return 4 * u * u * u if u < 0.5 else 1 - pow(-2 * u + 2, 3) / 2


def cursor_at(t):
    """Position at time t, interpolated between the anchors either side of it.

    Every anchor is a real measured point. Before the first anchor and after the
    last there is nothing measured to interpolate from, so the pointer rests on
    that anchor rather than being sent along an invented approach path.
    """
    if not clicks:
        return None
    if t <= clicks[0]['t']:
        return clicks[0]['x'], clicks[0]['y']
    if t >= clicks[-1]['t']:
        return clicks[-1]['x'], clicks[-1]['y']
    for i in range(len(clicks) - 1):
        a, b = clicks[i], clicks[i + 1]
        if a['t'] <= t < b['t']:
            span = b['t'] - a['t']
            u = 0.0 if span <= 0 else (t - a['t']) / span
            e = ease(min(max(u, 0.0), 1.0))
            return a['x'] + (b['x'] - a['x']) * e, a['y'] + (b['y'] - a['y']) * e
    return clicks[-1]['x'], clicks[-1]['y']


def cursor_moves(t0, t1):
    """True when the pointer is not at rest across [t0, t1]."""
    if cursor_img is None:
        return False
    a, b = cursor_at(t0), cursor_at(t1)
    return abs(a[0] - b[0]) > 0.5 or abs(a[1] - b[1]) > 0.5


def draw(src, r, out, t=None):
    im = Image.open(src).convert('RGB')
    d = ImageDraw.Draw(im, 'RGBA')
    if r is not None:
        x0 = (r['x'] - 6) * scale
        y0 = (r['y'] - 6) * scale
        x1 = (r['x'] + r['w'] + 6) * scale
        y1 = (r['y'] + r['h'] + 6) * scale
        d.rounded_rectangle([x0, y0, x1, y1], radius=10 * scale,
                            outline=(255, 64, 0, 255), width=max(3, int(3 * scale)))
        d.rounded_rectangle([x0 - 3, y0 - 3, x1 + 3, y1 + 3], radius=12 * scale,
                            outline=(255, 160, 0, 140), width=max(2, int(2 * scale)))
    if cursor_img is not None and t is not None:
        pos = cursor_at(t)
        if pos is not None:
            cw = max(18, int(22 * scale))
            cur = cursor_img.resize((cw, cw), Image.LANCZOS)
            # The arrow tip is the hotspot, so the image is placed with its top
            # left corner on the point, matching how a real pointer draws.
            im.paste(cur, (int(pos[0] * scale), int(pos[1] * scale)), cur)
    im.save(out, quality=88)


entries = []
painted = 0
subdivided = 0
for i, f in enumerate(frames):
    t0 = f['t']
    t1 = t0 + spans[i]
    # Every ring boundary that falls strictly inside this frame's displayed span
    # becomes a cut, so the ring can appear and disappear mid-hold.
    bounds = {b for r in rings for b in (r['t0'], r['t1']) if t0 < b < t1}
    if cursor_moves(t0, t1):
        n = int((t1 - t0) / step)
        added = {t0 + k * step for k in range(1, n + 1) if t0 + k * step < t1}
        if added:
            subdivided += 1
        bounds |= added
    cuts = sorted({t0, t1} | bounds)
    for j in range(len(cuts) - 1):
        a, b = cuts[j], cuts[j + 1]
        r = ring_at(a)
        if r is None and cursor_img is None:
            entries.append((f['file'], b - a))
        else:
            out = os.path.join(FRAMES, 'draw-%06d-%d.jpg' % (i, j))
            # The cursor is sampled at the midpoint of the piece it is drawn on,
            # which is the time that piece is actually on screen.
            draw(f['file'], r, out, (a + b) / 2.0)
            entries.append((out, b - a))
            if r is not None:
                painted += 1

with open(os.path.join(FRAMES, 'concat.txt'), 'w') as out:
    for path, dur in entries:
        out.write("file '%s'\nduration %.4f\n" % (path, dur))
    # The concat demuxer drops the last entry's duration, so the final file is
    # repeated without one to give the preceding entry something to run until.
    out.write("file '%s'\n" % entries[-1][0])

print(json.dumps({
    'framesIn': len(frames),
    'entriesOut': len(entries),
    'framesSubdividedForCursorMotion': subdivided,
    'cursorStep': step,
    'ringFramesPainted': painted,
    'ringsDrawn': [r.get('label') for r in rings],
    'cursorAnchors': [
        '%s (%s)' % (c.get('label'), c.get('kind', 'click')) for c in clicks
    ],
    'ringsSkippedNoStableBox': [
        {'label': r.get('label'), 'why': r.get('why')} for r in skipped
    ],
    'frameSize': [fw, fh],
    'cssToFrameScale': round(scale, 4),
}))
