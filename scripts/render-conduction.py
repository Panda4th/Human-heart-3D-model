"""CPU triangle rasterizer (numpy, Pillow); no browser/GPU required.
Usage: python scripts/render-conduction.py <input.json> <new-output-directory> <record-date>
Preserves viewer mesh geometry; diagnostic colors and face lighting.
"""
import argparse
import json
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
parser = argparse.ArgumentParser(description="Render diagnostic views into a new directory.")
parser.add_argument("input", type=Path)
parser.add_argument("output", type=Path, help="Must not already exist")
parser.add_argument("record_date", type=date.fromisoformat, metavar="YYYY-MM-DD")
args = parser.parse_args()
report = json.loads(args.input.read_text(encoding="utf-8"))
out = args.output
try:
    out.mkdir()
except FileExistsError:
    parser.error(f"Output already exists: {out}. Choose a new directory.")

colors = {
    'aov': (255, 191, 51), 'tv': (217, 166, 76), 'mv': (255, 217, 128),
    'pm': (153, 64, 230), 'av': (255, 155, 177), 'his': (255, 106, 130),
    'bhis': (242, 245, 250), 'rbb': (128, 179, 255), 'lbb': (79, 219, 196),
    'purkinje': (214, 179, 255),
}
meshes=[(m['id'],np.array(m['positions']).reshape(-1,3),np.array(m['indices']).reshape(-1,3)) for m in report['meshes']]
allpoints=np.concatenate([p for _,p,_ in meshes]);center=(allpoints.min(0)+allpoints.max(0))/2
local=np.mean(list(report['anchors'].values()),axis=0)
font = ImageFont.load_default(size=19)
small = ImageFont.load_default(size=16)
valve_font = ImageFont.load_default(size=30)
views={'front':([1,0,0],[0,1,0],[0,0,1],'Anterior (+Z); screen right = body left (+X)'), 'right':([0,0,1],[0,1,0],[-1,0,0],'Body right (-X); screen right = anterior (+Z)'), 'top':([1,0,0],[0,0,-1],[0,1,0],'Superior (+Y); screen right = body left (+X)')}
W,H=1200,1000
PIXELS_PER_MM = {'full': 760 / 140, 'local': 760 / 52}
VALVE_LABELS = {'tv': ('TV', -120, 12), 'aov': ('AoV', 20, -74), 'mv': ('MV', 114, -34)}
PART_NUMBERS = {part: number for number, part in enumerate(colors, start=1)}

def render(name, axes, close, hidden=(), suffix='', note='', label_valves=False):
    right,up,toward,caption=axes;basis=np.array([right,up,toward]).T
    focus = local if close else center
    px = PIXELS_PER_MM['local' if close else 'full']
    image=np.full((H,W,3),[9,12,15],dtype=np.uint8);depth=np.full((H,W),-np.inf)
    visible_parts = np.zeros((H, W), dtype=np.uint8) if label_valves else None

    def project(points):
        p=(points-focus)@basis
        return np.column_stack((600+p[:,0]*px,460-p[:,1]*px,p[:,2]))
    for part_id,vertices,indices in meshes:
        if part_id in hidden:
            continue
        projected=project(vertices)
        for idx in indices:
            a,b,c=projected[idx];x0=max(0,int(np.floor(min(a[0],b[0],c[0]))));x1=min(W-1,int(np.ceil(max(a[0],b[0],c[0]))))
            y0=max(65,int(np.floor(min(a[1],b[1],c[1]))));y1=min(870,int(np.ceil(max(a[1],b[1],c[1]))))
            if x0>x1 or y0>y1:continue
            den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(den)<1e-10:continue
            y,x=np.mgrid[y0:y1+1,x0:x1+1];x=x+.5;y=y+.5
            u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
            v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den;w=1-u-v
            z=u*a[2]+v*b[2]+w*c[2];target=depth[y0:y1+1,x0:x1+1]
            mask=(u>=0)&(v>=0)&(w>=0)&(z>target)
            normal=np.cross(vertices[idx[1]]-vertices[idx[0]],vertices[idx[2]]-vertices[idx[0]])
            shade=.4+.6*abs(np.dot(normal,toward))/max(np.linalg.norm(normal),1e-12)
            image[y0:y1+1,x0:x1+1][mask]=np.array(colors[part_id])*shade;target[mask]=z[mask]
            if visible_parts is not None:
                visible_parts[y0:y1+1, x0:x1+1][mask] = PART_NUMBERS[part_id]
    im=Image.fromarray(image);d=ImageDraw.Draw(im)
    d.text((24,18),caption + (' | local' if close else ' | full') + note,font=font,fill='white')
    d.text((24,44),'Proxy labels are overlaid even when occluded; no tissue boundaries identified',font=small,fill='white')
    offsets={'A':(-100,-35),'B':(35,-55),'C':(-65,45)}
    for key,p in report['anchors'].items():
        x,y,_=project(np.array([p]))[0];dx,dy=offsets[key]
        d.line((x,y,x+dx,y+dy),fill='white',width=2);d.ellipse((x-3,y-3,x+3,y+3),outline='white',width=2)
        d.text((x+dx,y+dy),key,font=font,fill='white')
    if visible_parts is not None:
        for part_id, (label, dx, dy) in VALVE_LABELS.items():
            valve_mask = visible_parts == PART_NUMBERS[part_id]
            # Prefer an interior point so the leader does not end on a thin edge.
            interior = Image.fromarray(valve_mask.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(13))
            pixels = np.argwhere(np.asarray(interior))
            if not pixels.size:
                pixels = np.argwhere(valve_mask)
            if not pixels.size:
                raise ValueError(f"No visible pixels for {label} in {name}{suffix}")
            y, x = pixels[np.argmin(np.sum((pixels - pixels.mean(axis=0)) ** 2, axis=1))]
            label_x, label_y = x + dx, y + dy
            d.line((x, y, label_x, label_y), fill='black', width=5)
            d.line((x, y, label_x, label_y), fill='#ffe9a6', width=3)
            d.ellipse((x - 3, y - 3, x + 3, y + 3), fill='#ffe9a6', outline='black')
            d.text((label_x, label_y), label, anchor='mm', font=valve_font,
                   fill='#ffe9a6', stroke_width=2, stroke_fill='black')

    legend = ['A AV proxy | B left-origin proxy | C right-origin proxy']
    anatomy = []
    if any(part_id not in hidden for part_id in VALVE_LABELS):
        anatomy.append('Gold: valves')
    if 'pm' not in hidden:
        anatomy.append('Purple: papillary muscles')
    legend.append(' | '.join([*anatomy, 'Cyan: LBB', 'Blue: RBB']))
    legend.append('Pink: AV | Red: proximal His | White: branching His | Pale purple: Purkinje')
    legend.append('CPU diagnostic rendering of viewer meshes; static; browser materials differ')
    for i, line in enumerate(legend):
        d.text((24, 892 + i * 24), line, font=small, fill='white')
    d.line((990,860,990+10*px,860),fill='white',width=3);d.text((990,865),'10 mm',font=small,fill='white')
    im.save(out / f'conduction-{name}{suffix}-{args.record_date}.png')

for name, axes in views.items():
    render(name, axes, False)
    render(name, axes, True, suffix='-local')
render('front', views['front'], True, hidden=('aov', 'tv', 'mv', 'pm'),
       suffix='-paths', note=' | valves and papillary muscles hidden')
render('front', views['front'], False, hidden=('pm',),
       suffix='-valves', note=' | papillary muscles hidden', label_valves=True)
report.pop('meshes');report['renderer']='CPU barycentric rasterizer; orthographic depth buffer; double-sided face lighting; diagnostic colors'
report['views']={name:dict(zip(['screenRight','screenUp','cameraDirection','caption'],axes)) for name,axes in views.items()}
report['framing']={'size':[W,H],'fullCenter':center.tolist(),'localCenter':local.tolist(),'pixelsPerMm':PIXELS_PER_MM}
(out / f'conduction-figure6a-{args.record_date}.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
