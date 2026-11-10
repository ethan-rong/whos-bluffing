# Builds the five result-type emblems (bluffer, hot_headed, calibrated, modest, hedger) in Blender and renders them:
# 1024px RGBA masters to brand/emblems/<key>.png and 320px WebP to web/public/img/types/<key>.webp.
# Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P brand/emblems/make_emblems.py [-- --only KEY --contact OUT.png]
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
WEB_DIR = os.path.join(REPO, "web", "public", "img", "types")

MASTER_PX = 1024
WEB_PX = 320
WEB_MAX_BYTES = 40 * 1024
FILL = 0.80          # object's longest side as a share of the frame
CAM_AZ = 35.0        # degrees: camera to the front-right
CAM_EL = 24.0        # degrees above the horizon
SAMPLES = 64

KEYS = ["bluffer", "hot_headed", "calibrated", "modest", "hedger"]
CARDS = {  # key: (light-theme card, dark-theme card)
    "bluffer": ("#B42318", "#FF7A7E"),
    "hot_headed": ("#8A5A00", "#F2C14E"),
    "calibrated": ("#1A7F37", "#3DBE6A"),
    "modest": ("#2F5BFF", "#7A95FF"),
    "hedger": ("#5B6472", "#9AA4B2"),
}
NAVY, CREAM, WHITE = "#111827", "#F5F3EE", "#FFFFFF"
BLUE, LBLUE, RED, GREEN, AMBER = "#2F5BFF", "#7A95FF", "#E5484D", "#2EAF5B", "#FFB020"
TERRACOTTA, PETAL = "#C8663E", "#EDE7FF"


# ---------- colour + materials ----------

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


_MATS = {}


def mat(hexcol, rough=0.5):
    key = (hexcol, rough)
    if key in _MATS:
        return _MATS[key]
    m = bpy.data.materials.new(f"{hexcol}_{rough}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*[srgb_to_linear(c) for c in hex_rgb(hexcol)], 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    _MATS[key] = m
    return m


# ---------- geometry helpers ----------

def link(name, data, material, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    if material is not None:
        data.materials.append(material)
    ob.parent = parent
    ob.location, ob.rotation_euler, ob.scale = loc, rot, scale
    return ob


def mesh_from(bm, name):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    return me


def add_bevel(ob, width, segments=4):
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(30)
    mod.harden_normals = True
    return ob


def slab(name, w, h, t, corner, edge, material, parent, **kw):
    """Box w x h x t (normal +Z) with rounded corners of radius `corner` and soft edges `edge`."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * w, v.co.y * h, v.co.z * t))
    vertical = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > 1e-6]
    bmesh.ops.bevel(bm, geom=vertical, offset=corner, segments=10, affect="EDGES", profile=0.5)
    return add_bevel(link(name, mesh_from(bm, name), material, parent, **kw), edge)


def cylinder(name, r, depth, material, parent, r_top=None, edge=0.02, segs=64, **kw):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                          radius1=r, radius2=r if r_top is None else r_top, depth=depth)
    ob = link(name, mesh_from(bm, name), material, parent, **kw)
    return add_bevel(ob, edge) if edge else ob


def sphere(name, r, material, parent, deform=None, **kw):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=r)
    if deform:
        for v in bm.verts:
            v.co = deform(v.co.copy())
    return link(name, mesh_from(bm, name), material, parent, **kw)


def torus(name, major, minor, material, parent, **kw):
    bm = bmesh.new()
    seg_major, seg_minor = 64, 24
    rings = []
    for i in range(seg_major):
        a = 2 * math.pi * i / seg_major
        ring = []
        for j in range(seg_minor):
            b = 2 * math.pi * j / seg_minor
            rr = major + minor * math.cos(b)
            ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), minor * math.sin(b))))
        rings.append(ring)
    for i in range(seg_major):
        for j in range(seg_minor):
            a, b = rings[i], rings[(i + 1) % seg_major]
            bm.faces.new((a[j], b[j], b[(j + 1) % seg_minor], a[(j + 1) % seg_minor]))
    return link(name, mesh_from(bm, name), material, parent, **kw)


def tube(name, points, radius, material, parent, **kw):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 6
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (*co, 1.0)
    return link(name, cu, material, parent, **kw)


def prism(name, outline_xz, thickness, material, parent, **kw):
    """Flat shape in the XZ plane, given thickness along Y."""
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((x, -thickness / 2, z)) for x, z in outline_xz])
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]:
        v.co.y += thickness
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add_bevel(link(name, mesh_from(bm, name), material, parent, **kw), thickness * 0.3, 2)


def catmull(points, per_seg=16):
    pts = [Vector(p) for p in points]
    pts = [pts[0]] + pts + [pts[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for s in range(per_seg):
            t = s / per_seg
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(pts[-2])
    return [tuple(p) for p in out]


def root(name, loc=(0, 0, 0), rot=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.location, ob.rotation_euler = loc, rot
    return ob


def facing(yaw=0.0, lean=0.0):
    """Euler that turns local +Z (a slab's face) toward the camera's azimuth, turned `yaw` and leaned back `lean`."""
    return (math.radians(90 - lean), 0, math.radians(CAM_AZ + yaw))


R = math.radians


# ---------- emblems ----------

def card(name, panel_hex, parent, loc, spin, pip):
    grp = root(name, loc=loc, rot=(0, 0, R(spin)))
    grp.parent = parent
    slab(name + "_body", 1.0, 1.4, 0.05, 0.22, 0.012, mat(CREAM, 0.55), grp)
    slab(name + "_panel", 0.82, 1.22, 0.02, 0.14, 0.006, mat(panel_hex, 0.5), grp, loc=(0, 0, 0.03))
    if pip:
        slab(name + "_pip", 0.38, 0.38, 0.02, 0.065, 0.006, mat(CREAM, 0.5), grp,
             loc=(0, 0, 0.045), rot=(0, 0, R(45)))
    return grp


def chip(name, parent, z, body_hex, stripe_hex):
    r, h = 0.3, 0.1
    cylinder(name, r, h, mat(body_hex, 0.5), parent, edge=0.02, loc=(0, 0, z))
    for i in range(6):
        a = 2 * math.pi * i / 6
        slab(f"{name}_s{i}", 0.04, 0.075, 0.094, 0.01, 0.006, mat(stripe_hex, 0.5), parent,
             loc=(math.cos(a) * (r - 0.016), math.sin(a) * (r - 0.016), z), rot=(0, 0, a))
    return z + h + 0.004


def build_bluffer():
    top = root("bluffer")
    hand = root("hand", rot=facing(yaw=-8, lean=14))
    hand.parent = top
    card("back", BLUE, hand, (-0.24, 0.16, 0.0), 14, pip=False)
    card("front", NAVY, hand, (0.0, 0.0, 0.09), -9, pip=True)
    fwd = Vector((math.sin(R(CAM_AZ)), -math.cos(R(CAM_AZ)), 0))
    right = Vector((math.cos(R(CAM_AZ)), math.sin(R(CAM_AZ)), 0))
    stack = root("chips", loc=tuple(fwd * 0.55 + right * 0.5 + Vector((0, 0, -0.62))))
    stack.parent = top
    z = 0.0
    for i, (body, stripe) in enumerate([(NAVY, CREAM), (AMBER, WHITE), (BLUE, CREAM)]):
        z = chip(f"chip{i}", stack, z, body, stripe)
    cylinder("chip_top_inset", 0.17, 0.012, mat(CREAM, 0.5), stack, edge=0.004, loc=(0, 0, z - 0.004 - 0.05 + 0.004))
    return top


def balloon_shape(co):
    r = 0.8
    z = co.z
    if z < 0:
        k = 1 - 0.42 * (-z / r) ** 1.7
        co.x *= k
        co.y *= k
    co.z *= 1.12
    return co


def build_hot_headed():
    top = root("hot_headed", rot=(0, R(-8), 0))
    sphere("balloon", 0.8, mat(RED, 0.3), top, deform=balloon_shape)
    bottom = -0.8 * 1.12
    cylinder("neck", 0.07, 0.14, mat(RED, 0.3), top, r_top=0.03, edge=0.0, loc=(0, 0, bottom - 0.02))
    torus("knot", 0.06, 0.04, mat(RED, 0.3), top, loc=(0, 0, bottom - 0.1))
    pts = []
    turns, length, radius = 2.0, 0.85, 0.11
    for i in range(121):
        t = i / 120
        a = 2 * math.pi * turns * t
        rr = radius * math.sin(math.pi * min(1.0, t * 1.25))
        pts.append((rr * math.sin(a), rr * (1 - math.cos(a)) * 0.6, bottom - 0.12 - length * t))
    tube("string", pts, 0.045, mat(NAVY, 0.5), top)
    # painted shine, upper-left as seen from the camera
    cam_rot = camera_rotation_matrix()
    n =(cam_rot @ Vector((-0.5, 0.55, 0.75))).normalized()
    surf = Vector((n.x * 0.8, n.y * 0.8, n.z * 0.8 * 1.12)) * 0.985
    rot = n.to_track_quat("Z", "Y").to_euler()
    sphere("shine", 1.0, mat(CREAM, 0.4), top, loc=tuple(surf), rot=tuple(rot), scale=(0.09, 0.2, 0.035))
    return top


def build_calibrated():
    top = root("calibrated")
    board = root("board", rot=facing(yaw=-38, lean=8))
    board.parent = top
    rings = [(1.0, NAVY), (0.8, CREAM), (0.6, RED), (0.4, CREAM), (0.2, RED)]
    z = 0.0
    for i, (r, col) in enumerate(rings):
        depth = 0.2 if i == 0 else 0.03
        zc = 0.0 if i == 0 else z + 0.015 - 0.03 / 2 + 0.015
        cylinder(f"ring{i}", r, depth, mat(col, 0.55), board, edge=0.03 if i == 0 else 0.008, loc=(0, 0, zc))
        z = zc + depth / 2
    dart = root("dart", loc=(0, 0, z - 0.03), rot=(R(-10), R(6), 0))
    dart.parent = board
    cylinder("tip", 0.04, 0.28, mat(WHITE, 0.3), dart, r_top=0.01, edge=0.0, loc=(0, 0, 0.1), rot=(R(180), 0, 0))
    cylinder("barrel", 0.1, 0.46, mat(AMBER, 0.4), dart, edge=0.04, loc=(0, 0, 0.46))
    cylinder("shaft", 0.045, 0.5, mat(NAVY, 0.45), dart, edge=0.012, loc=(0, 0, 0.92))
    fin = [(0.03, 0.0), (0.28, 0.2), (0.28, 0.52), (0.03, 0.52)]
    for i in range(4):
        prism(f"flight{i}", fin, 0.026, mat(BLUE, 0.5), dart, loc=(0, 0, 0.84), rot=(0, 0, R(45 + 90 * i)))
    return top


def build_modest():
    top = root("modest", rot=(0, 0, R(-15)))
    cylinder("pot", 0.42, 0.75, mat(TERRACOTTA, 0.6), top, r_top=0.55, edge=0.03, loc=(0, 0, 0))
    torus("rim", 0.56, 0.1, mat(CREAM, 0.5), top, loc=(0, 0, 0.41))
    cylinder("soil", 0.53, 0.06, mat(NAVY, 0.7), top, edge=0.01, loc=(0, 0, 0.40))
    stem_ctrl = [(0, 0, 0.42), (0.0, 0, 0.9), (0.06, 0, 1.32), (0.26, 0, 1.56), (0.5, 0, 1.52), (0.64, 0, 1.3)]
    pts = catmull(stem_ctrl)
    tube("stem", pts, 0.045, mat(GREEN, 0.5), top)
    for name, ang, side in [("leaf_l", 35, -1), ("leaf_r", -40, 1)]:
        leaf = root(name, loc=(0, 0, 0.62), rot=(0, 0, R(90 + 20 * side)))
        leaf.parent = top
        sphere(name + "_m", 1.0, mat(GREEN, 0.5), leaf, loc=(0.28 * side, 0, 0.12),
               rot=(0, R(ang), 0), scale=(0.3, 0.12, 0.03))
    end, before = Vector(pts[-1]), Vector(pts[-4])
    tangent = (end - before).normalized()
    to_cam = Euler((0, 0, R(15))).to_matrix() @ camera_rotation()[1]   # camera direction in the pot's frame
    axis = (tangent * 0.8 + to_cam).normalized()                         # hangs down, still shows its face
    head = root("flower", loc=tuple(end), rot=tuple(axis.to_track_quat("Z", "Y").to_euler()))
    head.parent = top
    for i in range(5):
        a = 2 * math.pi * i / 5
        sphere(f"petal{i}", 1.0, mat(PETAL, 0.5), head,
               loc=(math.cos(a) * 0.22, math.sin(a) * 0.22, 0.04), rot=(0, R(-15), a),
               scale=(0.23, 0.15, 0.045))
    sphere("centre", 0.1, mat(AMBER, 0.5), head, loc=(0, 0, 0.09))
    return top


def build_hedger():
    top = root("hedger", rot=(0, 0, R(CAM_AZ - 27)))
    body_mat = mat(NAVY, 0.5)
    slab("body", 1.4, 1.2, 1.45, 0.2, 0.07, body_mat, top)
    door = root("door", loc=(0, -0.6, 0.02), rot=(R(90), 0, 0))
    door.parent = top
    slab("door_panel", 1.08, 1.12, 0.1, 0.12, 0.025, mat(CREAM, 0.5), door, loc=(0, 0, 0.02))
    front = 0.07
    dial_xy = (-0.12, 0.17)
    cylinder("dial", 0.21, 0.09, body_mat, door, edge=0.025, loc=(*dial_xy, front + 0.04))
    cylinder("dial_cap", 0.09, 0.05, mat(BLUE, 0.4), door, edge=0.015, loc=(*dial_xy, front + 0.1))
    for i in range(12):
        a = 2 * math.pi * i / 12
        length = 0.07 if i % 3 == 0 else 0.04
        slab(f"tick{i}", 0.022, length, 0.02, 0.006, 0.004, body_mat, door,
             loc=(dial_xy[0] + math.cos(a) * 0.29, dial_xy[1] + math.sin(a) * 0.29, front),
             rot=(0, 0, a - math.pi / 2))
    hub_xy = (0.22, -0.25)
    cylinder("hub", 0.075, 0.1, body_mat, door, edge=0.02, loc=(*hub_xy, front + 0.04))
    for i in range(3):
        a = R(90 + 120 * i)
        mid = (hub_xy[0] + math.cos(a) * 0.1, hub_xy[1] + math.sin(a) * 0.1, front + 0.1)
        cylinder(f"spoke{i}", 0.028, 0.2, body_mat, door, edge=0.0, loc=mid, rot=(0, R(90), a))
        sphere(f"knob{i}", 0.055, mat(AMBER, 0.45), door,
               loc=(hub_xy[0] + math.cos(a) * 0.2, hub_xy[1] + math.sin(a) * 0.2, front + 0.1))
    for zc in (0.32, -0.32):
        cylinder(f"hinge{zc}", 0.045, 0.2, mat(AMBER, 0.45), door, edge=0.01, loc=(-0.555, zc, 0.06), rot=(R(90), 0, 0))
    for sx in (-0.48, 0.48):
        for sy in (-0.38, 0.38):
            cylinder("foot", 0.1, 0.16, body_mat, top, edge=0.03, loc=(sx, sy, -0.725 - 0.05))
    return top


BUILDERS = {"bluffer": build_bluffer, "hot_headed": build_hot_headed, "calibrated": build_calibrated,
            "modest": build_modest, "hedger": build_hedger}


# ---------- scene, camera, lights ----------

def camera_rotation():
    d = Vector((math.sin(R(CAM_AZ)) * math.cos(R(CAM_EL)), -math.cos(R(CAM_AZ)) * math.cos(R(CAM_EL)),
                math.sin(R(CAM_EL))))
    return (-d).to_track_quat("-Z", "Y").to_matrix(), d


def camera_rotation_matrix():
    return camera_rotation()[0]


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MATS.clear()
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.eevee.taa_render_samples = SAMPLES
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = MASTER_PX
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (1, 1, 1, 1)
    bg.inputs["Strength"].default_value = 0.45
    sc.world = world

    rot, d = camera_rotation()
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    cam.matrix_world = Matrix.Translation(d * 30) @ rot.to_4x4()
    cam_data.clip_end = 100
    sc.camera = cam

    for name, local, strength, angle in [("key", (-1.0, 1.1, 0.9), 2.6, 25), ("fill", (1.3, -0.1, 0.9), 0.7, 40),
                                         ("rim", (0.5, 1.0, -1.1), 2.6, 15)]:
        ld = bpy.data.lights.new(name, "SUN")
        ld.energy = strength
        ld.angle = R(angle)
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        direction = (rot @ Vector(local)).normalized()   # from object toward light
        lo.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    return sc, cam


def frame(sc, cam, top):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for ob in sc.objects:
        if ob.type not in {"MESH", "CURVE"}:
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        mw = inv @ ev.matrix_world
        for v in me.vertices:
            p = mw @ v.co
            xs.append(p.x)
            ys.append(p.y)
        ev.to_mesh_clear()
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    cam.data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys)) / FILL
    cam.location = cam.location + cam.matrix_world.to_3x3() @ Vector((cx, cy, 0))


def render(sc, path, px, fmt):
    sc.render.resolution_x = sc.render.resolution_y = px
    s = sc.render.image_settings
    s.file_format = fmt
    s.color_mode = "RGBA"
    if fmt == "PNG":
        s.color_depth = "8"
        s.compression = 90
    else:
        s.quality = 82
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ---------- checks + review sheet ----------

def load_rgba(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)   # bottom row first


def check(key, master, web):
    px = load_rgba(master)
    assert px.shape == (MASTER_PX, MASTER_PX, 4), f"{key}: master size {px.shape}"
    corners = [px[0, 0, 3], px[0, -1, 3], px[-1, 0, 3], px[-1, -1, 3]]
    assert max(corners) == 0.0, f"{key}: corner alpha {corners}"
    ys, xs = np.nonzero(px[:, :, 3] > 0.02)
    assert xs.min() > 0 and ys.min() > 0 and xs.max() < MASTER_PX - 1 and ys.max() < MASTER_PX - 1, f"{key}: touches edge"
    wp = load_rgba(web)
    assert wp.shape == (WEB_PX, WEB_PX, 4), f"{key}: webp size {wp.shape}"
    size = os.path.getsize(web)
    assert size <= WEB_MAX_BYTES, f"{key}: webp {size} bytes"
    span = max(xs.max() - xs.min(), ys.max() - ys.min()) / MASTER_PX
    print(f"CHECK {key}: ok, alpha bbox {span:.0%} of frame, webp {size / 1024:.1f} KB")


def rounded_mask(w, h, r):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    qx = np.maximum(np.abs(xx - w / 2) - (w / 2 - r), 0)
    qy = np.maximum(np.abs(yy - h / 2) - (h / 2 - r), 0)
    return np.clip(r - np.sqrt(qx * qx + qy * qy) + 0.5, 0, 1)


def contact_sheet(out_path, keys):
    tile, gap, emb, rad = 220, 24, 160, 26
    w, h = gap + len(keys) * (tile + gap), gap + 2 * (tile + gap)
    sheet = np.ones((h, w, 4), dtype=np.float32)
    sheet[h // 2:, :, :3] = hex_rgb("#FBFAF7")      # array row 0 = bottom, so upper half = light row
    sheet[:h // 2, :, :3] = hex_rgb("#0B0F17")
    mask = rounded_mask(tile, tile, rad)[..., None]
    for col, key in enumerate(keys):
        px = load_rgba(os.path.join(WEB_DIR, f"{key}.webp"))
        prem = np.concatenate([px[..., :3] * px[..., 3:], px[..., 3:]], axis=2)
        prem = prem.reshape(emb, WEB_PX // emb, emb, WEB_PX // emb, 4).mean(axis=(1, 3))
        for row, card_hex in enumerate(CARDS[key]):
            x0 = gap + col * (tile + gap)
            y0 = h - (gap + row * (tile + gap)) - tile
            cell = np.empty((tile, tile, 3), dtype=np.float32)
            cell[:] = hex_rgb(card_hex)
            o = (tile - emb) // 2
            region = cell[o:o + emb, o:o + emb]
            cell[o:o + emb, o:o + emb] = prem[..., :3] + region * (1 - prem[..., 3:])
            dst = sheet[y0:y0 + tile, x0:x0 + tile, :3]
            sheet[y0:y0 + tile, x0:x0 + tile, :3] = cell * mask + dst * (1 - mask)
    img = bpy.data.images.new("contact", w, h, alpha=True)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = out_path
    img.file_format = "PNG"
    img.save()
    print(f"CONTACT {out_path}")


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = argv[argv.index("--only") + 1].split(",") if "--only" in argv else KEYS
    contact = os.path.abspath(argv[argv.index("--contact") + 1]) if "--contact" in argv else None
    unknown = [k for k in only if k not in BUILDERS]
    assert not unknown, f"unknown keys {unknown}"
    return only, contact


def main():
    only, contact = parse_args()
    os.makedirs(WEB_DIR, exist_ok=True)
    for key in only:
        sc, cam = setup_scene()
        top = BUILDERS[key]()
        frame(sc, cam, top)
        master = os.path.join(HERE, f"{key}.png")
        web = os.path.join(WEB_DIR, f"{key}.webp")
        render(sc, master, MASTER_PX, "PNG")
        render(sc, web, WEB_PX, "WEBP")
        check(key, master, web)
    if contact:
        contact_sheet(contact, KEYS)


main()
