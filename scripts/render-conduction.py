"""CPU triangle rasterizer (numpy, Pillow); no browser/GPU required.
Usage: python scripts/render-conduction.py /tmp/conduction.json <output-directory>
Preserves viewer mesh geometry; diagnostic colors and face lighting.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
report=json.loads(Path(sys.argv[1]).read_text())
out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
colors={'aov':(255,191,51),'tv':(217,166,76),'mv':(255,217,128),'pm':(153,64,230),'av':(255,189,99),'his':(255,222,145),'bhis':(232,166,92),'rbb':(128,179,255),'lbb':(79,219,196),'purkinje':(214,179,255)}
meshes=[(m['id'],np.array(m['positions']).reshape(-1,3),np.array(m['indices']).reshape(-1,3)) for m in report['meshes']]
allpoints=np.concatenate([p for _,p,_ in meshes]);center=(allpoints.min(0)+allpoints.max(0))/2
local=np.mean(list(report['anchors'].values()),axis=0)
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',19)
small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
views={'front':([1,0,0],[0,1,0],[0,0,1],'Anterior (+Z); screen right = body left (+X)'), 'right':([0,0,1],[0,1,0],[-1,0,0],'Body right (-X); screen right = anterior (+Z)'), 'top':([1,0,0],[0,0,-1],[0,1,0],'Superior (+Y); screen right = body left (+X)')}
W,H=1200,1000

def render(name,axes,close,hide_valves=False):
    right,up,toward,caption=axes;basis=np.array([right,up,toward]).T
    focus=local if close else center;scale=26 if close else 70;px=760/(2*scale)
    image=np.full((H,W,3),[9,12,15],dtype=np.uint8);depth=np.full((H,W),-np.inf)
    def project(points):
        p=(points-focus)@basis
        return np.column_stack((600+p[:,0]*px,460-p[:,1]*px,p[:,2]))
    for id,vertices,indices in meshes:
        if hide_valves and id in ['aov','mv','tv','pm']:continue
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
            image[y0:y1+1,x0:x1+1][mask]=np.array(colors[id])*shade;target[mask]=z[mask]
    im=Image.fromarray(image);d=ImageDraw.Draw(im)
    d.text((24,18),caption+(' | local' if close else ' | full'),font=font,fill='white')
    d.text((24,44),'Proxy labels are overlaid even when occluded; no tissue boundaries identified',font=small,fill='white')
    offsets={'A':(-100,-35),'B':(35,-55),'C':(-65,45)}
    for key,p in report['anchors'].items():
        x,y,_=project(np.array([p]))[0];dx,dy=offsets[key]
        d.line((x,y,x+dx,y+dy),fill='white',width=2);d.ellipse((x-3,y-3,x+3,y+3),outline='white',width=2)
        d.text((x+dx,y+dy),key,font=font,fill='white')
    for i,line in enumerate(['A AV proxy | B left-origin proxy | C right-origin proxy','Gold: valves | Purple: papillary muscles | Cyan: LBB | Blue: RBB','Cream: proximal His | Brown: branching His | Pale purple: Purkinje','CPU diagnostic rendering of viewer meshes; static; browser materials differ']):
        d.text((24,892+i*24),line,font=small,fill='white')
    d.line((990,860,990+10*px,860),fill='white',width=3);d.text((990,865),'10 mm',font=small,fill='white')
    suffix='-paths' if hide_valves else '-local' if close else ''
    im.save(out/f'conduction-{name}{suffix}-2026-11-08.png')
for name,axes in views.items():
    for close in [False,True]:render(name,axes,close)
render('front',views['front'],True,True)
report.pop('meshes');report['renderer']='CPU barycentric rasterizer; orthographic depth buffer; double-sided face lighting; diagnostic colors'
report['views']={name:dict(zip(['screenRight','screenUp','cameraDirection','caption'],axes)) for name,axes in views.items()}
report['framing']={'size':[W,H],'fullCenter':center.tolist(),'localCenter':local.tolist(),'pixelsPerMm':{'full':760/140,'local':760/52}}
(out/'conduction-figure6a-2026-11-08.json').write_text(json.dumps(report,indent=2)+'\n')
