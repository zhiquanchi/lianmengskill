# Extension Icons

Place your icon files here:

- `icon16.png` - 16x16 pixels
- `icon32.png` - 32x32 pixels  
- `icon48.png` - 48x48 pixels
- `icon128.png` - 128x128 pixels

For development, you can use the provided SVG file and convert it to PNG:
```bash
# Using ImageMagick
convert icon.svg -resize 16x16 icon16.png
convert icon.svg -resize 32x32 icon32.png
convert icon.svg -resize 48x48 icon48.png
convert icon.svg -resize 128x128 icon128.png

# Or using Python with PIL
python -c "
from PIL import Image
import io
with open('icon.svg', 'rb') as f:
    img = Image.open(io.BytesIO(f.read()))
    for size in [16, 32, 48, 128]:
        resized = img.resize((size, size))
        resized.save(f'icon{size}.png')
"
```

Or create simple colored icons using online tools.