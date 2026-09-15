import os
from PIL import Image, ImageDraw

def create_icon(size=1024):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Background rounded rectangle
    margin = int(size * 0.06)
    radius = int(size * 0.22)
    bbox = [margin, margin, size - margin, size - margin]

    # Create gradient background mask
    base = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    base_draw = ImageDraw.Draw(base)
    base_draw.rounded_rectangle(bbox, radius=radius, fill=(24, 16, 42, 255))

    # Gradient overlay
    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(grad)
    for y in range(margin, size - margin):
        factor = (y - margin) / (size - 2 * margin)
        # Gradient from vibrant violet (147, 51, 234) to deep indigo purple (79, 70, 229)
        r = int(147 * (1 - factor) + 79 * factor)
        g = int(51 * (1 - factor) + 70 * factor)
        b = int(234 * (1 - factor) + 229 * factor)
        grad_draw.line([(margin, y), (size - margin, y)], fill=(r, g, b, 255))

    # Mask gradient with rounded rectangle
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(bbox, radius=radius, fill=255)

    img.paste(grad, (0, 0), mask)

    # Subtle inner glow / border
    border_draw = ImageDraw.Draw(img)
    border_draw.rounded_rectangle(bbox, radius=radius, outline=(216, 180, 254, 180), width=int(size * 0.02))

    # 2. Sleek Play Triangle
    # Center play symbol with optical center shift (+x by ~4%)
    cx = size * 0.53
    cy = size * 0.50
    h = size * 0.44  # height of triangle
    w = h * 0.86     # width of triangle

    p1 = (cx - w * 0.45, cy - h * 0.5)
    p2 = (cx - w * 0.45, cy + h * 0.5)
    p3 = (cx + w * 0.55, cy)

    # Draw white/silver play triangle with smooth opacity
    triangle_mask = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    t_draw = ImageDraw.Draw(triangle_mask)
    t_draw.polygon([p1, p2, p3], fill=(255, 255, 255, 255))

    # Add a soft neon purple glow under the triangle
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(glow)
    offset = size * 0.015
    g_draw.polygon([p1, p2, p3], fill=(233, 213, 255, 255))
    img = Image.alpha_composite(img, glow)
    img = Image.alpha_composite(img, triangle_mask)

    return img

def main():
    icons_dir = r"d:\PlayOut\src-tauri\icons"
    public_dir = r"d:\PlayOut\public"
    os.makedirs(icons_dir, exist_ok=True)

    master = create_icon(1024)

    sizes = {
        "icon.png": (512, 512),
        "128x128@2x.png": (256, 256),
        "128x128.png": (128, 128),
        "32x32.png": (32, 32),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50),
    }

    for filename, (w, h) in sizes.items():
        resized = master.resize((w, h), Image.Resampling.LANCZOS)
        resized.save(os.path.join(icons_dir, filename), "PNG")
        print(f"Generated {filename} ({w}x{h})")

    # Generate multi-resolution icon.ico
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_images = [master.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_path = os.path.join(icons_dir, "icon.ico")
    ico_images[0].save(ico_path, format="ICO", sizes=ico_sizes, append_images=ico_images[1:])
    print("Generated icon.ico")

    # Generate public/favicon.ico
    fav_sizes = [(16, 16), (32, 32), (48, 48)]
    fav_images = [master.resize(s, Image.Resampling.LANCZOS) for s in fav_sizes]
    fav_path = os.path.join(public_dir, "favicon.ico")
    fav_images[0].save(fav_path, format="ICO", sizes=fav_sizes, append_images=fav_images[1:])
    print("Generated public/favicon.ico")

if __name__ == "__main__":
    main()
