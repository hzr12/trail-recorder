"""
Generate all Android launcher icon resources for the 途刻 app.
Run this after `cap add android` to replace default icons with custom ones.

Usage: python scripts/generate_android_icons.py [android_res_dir]
"""
import os
import sys
import math
from PIL import Image, ImageDraw

# If no path given, detect it
if len(sys.argv) > 1:
    RES_DIR = sys.argv[1]
else:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    RES_DIR = os.path.join(project_root, 'native', 'android', 'app', 'src', 'main', 'res')

# ---------- 尺寸表 ----------
LAUNCHER_SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

FOREGROUND_SIZES = {
    'mipmap-mdpi': 108,
    'mipmap-hdpi': 162,
    'mipmap-xhdpi': 216,
    'mipmap-xxhdpi': 324,
    'mipmap-xxxhdpi': 432,
}

# ---------- 颜色 ----------
BG_COLOR = (15, 23, 42)        # #0F172A
START_COLOR = (59, 130, 246)   # #3B82F6
END_COLOR = (16, 185, 129)     # #10B981
MIDDLE_COLOR = (6, 182, 212)   # #06B6D4
WHITE = (255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def _draw_trail_icon(img_size, transparent_bg=False):
    """
    绘制轨迹图标。设计空间为 108x108，按比例缩放到目标尺寸。
    """
    img = Image.new('RGBA', (img_size, img_size),
                    TRANSPARENT if transparent_bg else BG_COLOR)
    draw = ImageDraw.Draw(img)
    scale = img_size / 108.0

    def s(v):
        return v * scale

    def circle(cx, cy, r, fill):
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    def ring(cx, cy, r, outline, width):
        draw.ellipse([cx - r, cy - r, cx + r, cy + r],
                    outline=outline, width=width)

    # 起点
    sx, sy = s(30), s(72)
    circle(sx, sy, s(6), START_COLOR)
    ring(sx, sy, s(10), START_COLOR, max(1, int(s(1.5))))

    # 贝塞尔曲线近似
    def bezier_point(t, p0, p1, p2):
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
        return (x, y)

    # 第一段 (蓝)
    pts1 = [bezier_point(i / 19.0, (s(30), s(72)), (s(42), s(72)), (s(54), s(48)))
            for i in range(20)]
    # 第二段 (青)
    pts2 = [bezier_point(i / 19.0, (s(54), s(48)), (s(66), s(44)), (s(82), s(28)))
            for i in range(20)]

    thickness = max(2, int(s(7)))

    # 绘制第一段
    for i in range(len(pts1) - 1):
        draw.line([pts1[i], pts1[i + 1]], fill=START_COLOR, width=thickness)
    circle(pts1[0][0], pts1[0][1], thickness / 2, START_COLOR)
    circle(pts1[-1][0], pts1[-1][1], thickness / 2, START_COLOR)

    # 绘制第二段
    for i in range(len(pts2) - 1):
        draw.line([pts2[i], pts2[i + 1]], fill=MIDDLE_COLOR, width=thickness)
    circle(pts2[0][0], pts2[0][1], thickness / 2, MIDDLE_COLOR)
    circle(pts2[-1][0], pts2[-1][1], thickness / 2, MIDDLE_COLOR)

    # 中间节点
    circle(s(54), s(48), s(4), MIDDLE_COLOR)

    # 终点
    ex, ey = s(82), s(28)
    circle(ex, ey, s(10), END_COLOR)
    circle(ex, ey, s(5), WHITE)

    # 装饰粒子
    circle(s(38), s(60), s(2), START_COLOR)
    circle(s(66), s(38), s(2.5), END_COLOR)
    circle(s(74), s(32), s(1.5), MIDDLE_COLOR)

    return img


def _remove_conflicts(res_dir, name, extensions=None):
    """删除与指定资源同名但后缀不同的文件，避免 Duplicate Resources。"""
    if extensions is None:
        extensions = ['.png', '.webp', '.jpg', '.xml']
    for root, dirs, files in os.walk(res_dir):
        for f in files:
            base, ext = os.path.splitext(f)
            if base == name and ext in extensions:
                path = os.path.join(root, f)
                os.remove(path)
                print(f"  清理冲突: {os.path.relpath(path, res_dir)}")


def _write_adaptive_xmls(res_dir):
    """写入 adaptive icon 的 XML 配置。"""
    v26_dir = os.path.join(res_dir, 'mipmap-anydpi-v26')
    os.makedirs(v26_dir, exist_ok=True)

    # drawable 目录中可能有 Capacitor 默认 PNG 与我们的 XML 冲突
    drawable_dir = os.path.join(res_dir, 'drawable')
    _remove_conflicts(drawable_dir, 'splash', ['.png', '.webp', '.jpg'])
    _remove_conflicts(drawable_dir, 'ic_tracking', ['.png', '.webp', '.jpg'])
    _remove_conflicts(drawable_dir, 'ic_launcher_background', ['.png', '.webp', '.jpg'])

    drawable24_dir = os.path.join(res_dir, 'drawable-v24')
    _remove_conflicts(drawable24_dir, 'ic_launcher_foreground', ['.png', '.webp', '.jpg'])

    # ic_launcher.xml
    xml_content = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>'''
    with open(os.path.join(v26_dir, 'ic_launcher.xml'), 'w', encoding='utf-8') as f:
        f.write(xml_content)

    # ic_launcher_round.xml
    with open(os.path.join(v26_dir, 'ic_launcher_round.xml'), 'w', encoding='utf-8') as f:
        f.write(xml_content)

    # values/ic_launcher_background.xml (颜色资源)
    values_dir = os.path.join(res_dir, 'values')
    os.makedirs(values_dir, exist_ok=True)
    color_xml = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0F172A</color>
</resources>'''
    with open(os.path.join(values_dir, 'ic_launcher_background.xml'), 'w', encoding='utf-8') as f:
        f.write(color_xml)

    # drawable/ic_launcher_background.xml (背景 drawable)
    drawable_dir = os.path.join(res_dir, 'drawable')
    os.makedirs(drawable_dir, exist_ok=True)
    bg_xml = '''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportHeight="108"
    android:viewportWidth="108">
    <path
        android:fillColor="#0F172A"
        android:pathData="M0,0h108v108h-108z" />
</vector>'''
    with open(os.path.join(drawable_dir, 'ic_launcher_background.xml'), 'w', encoding='utf-8') as f:
        f.write(bg_xml)

    # drawable-v24/ic_launcher_foreground.xml (前景矢量)
    drawable24_dir = os.path.join(res_dir, 'drawable-v24')
    os.makedirs(drawable24_dir, exist_ok=True)
    fg_xml = '''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <!-- 起点 -->
    <path
        android:fillColor="#3B82F6"
        android:pathData="M30,72m-6,0a6,6 0,1 1,12 0a6,6 0,1 1,-12 0" />

    <!-- 起点外圈 -->
    <path
        android:fillColor="#00000000"
        android:strokeColor="#3B82F6"
        android:strokeWidth="1.5"
        android:pathData="M30,72m-10,0a10,10 0,1 1,20 0a10,10 0,1 1,-20 0" />

    <!-- 轨迹曲线第一段 -->
    <path
        android:fillColor="#00000000"
        android:strokeColor="#3B82F6"
        android:strokeWidth="7"
        android:strokeLineCap="round"
        android:pathData="M30,72 C42,72 42,52 54,48" />

    <!-- 轨迹曲线第二段 -->
    <path
        android:fillColor="#00000000"
        android:strokeColor="#06B6D4"
        android:strokeWidth="7"
        android:strokeLineCap="round"
        android:pathData="M54,48 C66,44 76,32 82,28" />

    <!-- 终点节点 -->
    <path
        android:fillColor="#10B981"
        android:pathData="M82,28m-10,0a10,10 0,1 1,20 0a10,10 0,1 1,-20 0" />

    <!-- 终点内圆 -->
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M82,28m-5,0a5,5 0,1 1,10 0a5,5 0,1 1,-10 0" />

    <!-- 中间节点 -->
    <path
        android:fillColor="#06B6D4"
        android:pathData="M54,48m-4,0a4,4 0,1 1,8 0a4,4 0,1 1,-8 0" />

    <!-- 装饰粒子 -->
    <path
        android:fillColor="#3B82F6"
        android:alpha="0.7"
        android:pathData="M38,60m-2,0a2,2 0,1 1,4 0a2,2 0,1 1,-4 0" />

    <path
        android:fillColor="#10B981"
        android:alpha="0.7"
        android:pathData="M66,38m-2.5,0a2.5,2.5 0,1 1,5 0a2.5,2.5 0,1 1,-5 0" />

    <path
        android:fillColor="#06B6D4"
        android:alpha="0.8"
        android:pathData="M74,32m-1.5,0a1.5,1.5 0,1 1,3 0a1.5,1.5 0,1 1,-3 0" />
</vector>'''
    with open(os.path.join(drawable24_dir, 'ic_launcher_foreground.xml'), 'w', encoding='utf-8') as f:
        f.write(fg_xml)

    # splash.xml (启动页)
    with open(os.path.join(drawable_dir, 'splash.xml'), 'w', encoding='utf-8') as f:
        f.write('''<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <shape android:shape="rectangle">
            <gradient
                android:angle="135"
                android:startColor="#0F172A"
                android:endColor="#1E3A5F"
                android:type="linear" />
        </shape>
    </item>
    <item
        android:drawable="@drawable/ic_launcher_foreground"
        android:gravity="center" />
</layer-list>''')

    # 通知图标 ic_tracking.xml
    with open(os.path.join(drawable_dir, 'ic_tracking.xml'), 'w', encoding='utf-8') as f:
        f.write('''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,18m-1.5,0a1.5,1.5 0,1 1,3 0a1.5,1.5 0,1 1,-3 0" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,6m-1.5,0a1.5,1.5 0,1 1,3 0a1.5,1.5 0,1 1,-3 0" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M17,12m-1.5,0a1.5,1.5 0,1 1,3 0a1.5,1.5 0,1 1,-3 0" />
    <path
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="1.5"
        android:strokeLineCap="round"
        android:pathData="M4,18 C4,12 8,12 8,8" />
    <path
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="1.5"
        android:strokeLineCap="round"
        android:pathData="M8,8 C8,4 15,6 17,12" />
</vector>''')


def main():
    if not os.path.isdir(RES_DIR):
        print(f"错误: res 目录不存在: {RES_DIR}")
        sys.exit(1)

    print(f"目标目录: {RES_DIR}")
    print()

    # 0. 预清理：删除 Capacitor 默认资源中与我们生成的文件同名但后缀不同的文件
    print("--- 预清理冲突资源 ---")
    for density_dir in ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi',
                        'mipmap-xxhdpi', 'mipmap-xxxhdpi']:
        d = os.path.join(RES_DIR, density_dir)
        for name in ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']:
            _remove_conflicts(d, name, ['.png', '.webp', '.jpg', '.xml'])

    for name in ['splash', 'ic_tracking', 'ic_launcher_background']:
        _remove_conflicts(os.path.join(RES_DIR, 'drawable'), name,
                          ['.png', '.webp', '.jpg', '.xml'])

    for name in ['ic_launcher_foreground']:
        _remove_conflicts(os.path.join(RES_DIR, 'drawable-v24'), name,
                          ['.png', '.webp', '.jpg', '.xml'])

    for name in ['ic_launcher', 'ic_launcher_round']:
        _remove_conflicts(os.path.join(RES_DIR, 'mipmap-anydpi-v26'), name,
                          ['.png', '.webp', '.jpg'])

    # 同时删除 Capacitor 默认的 web 相关 drawable 资源
    for d in ['drawable-land-mdpi', 'drawable-land-hdpi', 'drawable-land-xhdpi',
              'drawable-land-xxhdpi', 'drawable-land-xxxhdpi',
              'drawable-port-mdpi', 'drawable-port-hdpi', 'drawable-port-xhdpi',
              'drawable-port-xxhdpi', 'drawable-port-xxxhdpi']:
        _remove_conflicts(os.path.join(RES_DIR, d), 'splash',
                          ['.png', '.webp', '.jpg'])

    print()

    # 1. 生成 PNG 图标
    for dirname in LAUNCHER_SIZES:
        out_dir = os.path.join(RES_DIR, dirname)
        os.makedirs(out_dir, exist_ok=True)

        launcher_size = LAUNCHER_SIZES[dirname]
        fg_size = FOREGROUND_SIZES[dirname]

        # 启动图标 (含背景)
        icon = _draw_trail_icon(launcher_size, transparent_bg=False)
        icon.save(os.path.join(out_dir, 'ic_launcher.png'), 'PNG')
        print(f"  OK  {dirname}/ic_launcher.png ({launcher_size}x{launcher_size})")

        # 圆形图标
        icon.save(os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG')
        print(f"  OK  {dirname}/ic_launcher_round.png ({launcher_size}x{launcher_size})")

        # Adaptive 前景 (透明背景)
        fg = _draw_trail_icon(fg_size, transparent_bg=True)
        fg.save(os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG')
        print(f"  OK  {dirname}/ic_launcher_foreground.png ({fg_size}x{fg_size})")

    # 2. 写入 XML 配置
    _write_adaptive_xmls(RES_DIR)
    print()
    print("  OK  mipmap-anydpi-v26/ic_launcher.xml")
    print("  OK  mipmap-anydpi-v26/ic_launcher_round.xml")
    print("  OK  values/ic_launcher_background.xml")
    print("  OK  drawable/ic_launcher_background.xml")
    print("  OK  drawable-v24/ic_launcher_foreground.xml")
    print("  OK  drawable/splash.xml")
    print("  OK  drawable/ic_tracking.xml")

    # 3. 更新 strings.xml 中的应用名
    values_dir = os.path.join(RES_DIR, 'values')
    strings_path = os.path.join(values_dir, 'strings.xml')
    if os.path.exists(strings_path):
        with open(strings_path, 'r', encoding='utf-8') as f:
            content = f.read()
        content = content.replace(
            '<string name="app_name">App</string>',
            '<string name="app_name">途刻</string>'
        )
        content = content.replace(
            '<string name="title_activity_main">MainActivity</string>',
            '<string name="title_activity_main">途刻</string>'
        )
        with open(strings_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print("  OK  values/strings.xml (应用名已更新)")

    print()
    print("=== 所有 Android 图标资源已生成 ===")


if __name__ == '__main__':
    main()
