from PIL import Image, ImageDraw
import os

os.makedirs("icons", exist_ok=True)


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(1, size // 16)
    radius = max(2, size // 5)
    d.rounded_rectangle(
        [pad, pad, size - pad, size - pad], radius=radius, fill=(255, 77, 77, 255)
    )
    s = size
    left = s * 0.34
    top = s * 0.28
    bottom = s * 0.72
    tip = s * 0.72
    mid = s * 0.5
    d.polygon([(left, top), (left, bottom), (tip, mid)], fill=(255, 255, 255, 255))
    d.rounded_rectangle(
        [s * 0.58, s * 0.60, s * 0.90, s * 0.90],
        radius=max(1, size // 10),
        fill=(20, 20, 28, 235),
    )
    for y in (0.68, 0.75, 0.82):
        d.rectangle(
            [s * 0.62, s * y, s * 0.84, s * y + max(1, size // 28)],
            fill=(232, 236, 244, 255),
        )
    return img


for s in (16, 32, 48, 128):
    make(s).save(f"icons/icon{s}.png")

print("icons ok", os.listdir("icons"))
