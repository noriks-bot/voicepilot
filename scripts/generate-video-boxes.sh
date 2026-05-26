#!/bin/bash
# Generate video with white box + black text overlays for HR

INPUT="/home/ec2-user/.openclaw/workspace2/launches/uploads/video-1771851291246.mp4"
OUTPUT="/home/ec2-user/.openclaw/workspace2/launches/uploads/output/video-HR-boxes.mp4"
FONT="/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf"

# Check if font exists, use default if not
if [ ! -f "$FONT" ]; then
    FONT="/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"
fi
if [ ! -f "$FONT" ]; then
    FONT="Sans-Bold"
fi

# Build drawtext filters for each segment
# Format: drawtext=text='TEXT':fontfile=FONT:fontsize=48:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,START,END)'

ffmpeg -y -i "$INPUT" -vf "\
drawtext=text='OVO SU NORIKS BOKSERICE':fontsize=48:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0,3)',\
drawtext=text='5 puta mekše od pamuka':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,3,4.5)',\
drawtext=text='Udobni cijeli dan':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,4.5,7)',\
drawtext=text='Izrađene od mekog modala':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,7,8.5)',\
drawtext=text='Kao da ništa ne nosiš':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,8.5,11)',\
drawtext=text='Reguliraju tjelesnu temperaturu':fontsize=40:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,11,12.5)',\
drawtext=text='Ne skupljaju se':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,12.5,14.5)',\
drawtext=text='Ne blijede':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,14.5,16.5)',\
drawtext=text='Veličine S-4XL':fontsize=44:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,16.5,21.5)',\
drawtext=text='UŠTEDITE DO 40%':fontsize=48:fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2-80:enable='between(t,21.5,23.5)',\
drawtext=text='SAMO OVAJ TJEDAN':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.9:boxborderw=15:x=(w-text_w)/2:y=(h-text_h)/2+80:enable='between(t,21.5,23.5)'\
" -c:a copy "$OUTPUT"

echo "Done! Output: $OUTPUT"
