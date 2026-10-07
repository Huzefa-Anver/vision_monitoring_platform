"""HSV seam-colour vote for ONE detected region.

Whole-frame HSV blob scanning was tried first and measured at 25.6 spurious
blobs per frame on real footage - wall stacks are packed with the exact same
seam colours as carried sacks, so an independent colour scan cannot tell "held"
from "stacked" without localization. This instead classifies the crop the
MODEL already localized (its detection polygon), reusing cosmos/hsv3.py's
validated core/edge algorithm almost verbatim - same adaptive saturation gate,
same hue-concentration check, same tan whole-body rule, fitted against 2,699
human-verified instances. Do not retune independently of that file.
"""
import numpy as np, cv2
import core as C

def classify_crop(bgr, poly_xy):
    """poly_xy: Nx2 pixel-space polygon (or a 4-point box) from a model
    detection on this same frame. Returns hsv3-style vote dict, or None if the
    region is too small to judge."""
    pts=np.asarray(poly_xy, np.float32)
    x1,y1=np.floor(pts.min(0)).astype(int); x2,y2=np.ceil(pts.max(0)).astype(int)
    H,W=bgr.shape[:2]
    x1,y1=max(0,x1),max(0,y1); x2,y2=min(W,x2),min(H,y2)
    if x2-x1<24 or y2-y1<24: return None
    sub=cv2.cvtColor(bgr[y1:y2,x1:x2], cv2.COLOR_BGR2HSV_FULL)
    m=np.zeros(sub.shape[:2],np.uint8)
    cv2.fillPoly(m,[(pts-[x1,y1]).astype(np.int32)],255)
    k=max(1,int(min(x2-x1,y2-y1)*0.05)); inset=cv2.erode(m,np.ones((2*k+1,2*k+1),np.uint8))
    k2=max(1,int(min(x2-x1,y2-y1)*0.07)); core=cv2.erode(inset,np.ones((2*k2+1,2*k2+1),np.uint8))
    band=cv2.subtract(inset,core)
    if (band>0).sum()<60 or (core>0).sum()<60: return None
    bp,cp=sub[band>0],sub[core>0]
    satb,csat=bp[:,1].astype(float),cp[:,1].astype(float)
    p50c,p90c=float(np.percentile(csat,50)),float(np.percentile(csat,90))
    ca=np.radians(cp[:,0].astype(float)*360/255)
    core_hue=float(np.degrees(np.arctan2(np.sin(ca).mean(),np.cos(ca).mean()))%360)

    thr=max(22.0, p50c+12.0, p90c+4.0)          # relative to THIS sack's own body
    sel=satb>thr
    col=bp[sel]; frac=float(len(col)/len(bp))
    mh=None; R=0.0
    if len(col)>=15:
        a=np.radians(col[:,0].astype(float)*360/255)
        cx,sy=np.cos(a).mean(),np.sin(a).mean()
        R=float(np.hypot(cx,sy)); mh=float(np.degrees(np.arctan2(sy,cx))%360)

    if p50c>=48 and C.hue_bucket(core_hue)=='tan':
        vote='tan'
    elif mh is not None and frac>0.03 and R>=0.62:
        vote=C.hue_bucket(mh)
    elif mh is not None and frac>0.03:
        vote='mixed'
    elif frac<=0.01:
        vote='none'
    else:
        vote='hidden'
    return dict(vote=vote, hue=mh, frac=round(frac,3), R=round(R,2),
               core_sat=round(p50c,1), core_hue=round(core_hue))
