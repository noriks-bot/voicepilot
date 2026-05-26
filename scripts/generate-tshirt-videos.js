const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const jobDir = '/home/ec2-user/.openclaw/workspace2/launches/uploads/tshirt-job';
const outputDir = path.join(jobDir, 'output');
const videoPath = '/home/ec2-user/.openclaw/workspace2/launches/uploads/video-1771865344468.mp4';
const ffmpeg = '/usr/local/bin/ffmpeg';

// Load translations
const translations = JSON.parse(fs.readFileSync(path.join(jobDir, 'translations.json'), 'utf8'));

// Timing for segments (in centiseconds for ASS format)
const timings = [
  { start: '0:00:00.00', end: '0:00:02.00' },
  { start: '0:00:02.00', end: '0:00:04.00' },
  { start: '0:00:04.00', end: '0:00:06.00' },
  { start: '0:00:06.00', end: '0:00:08.00' },
  { start: '0:00:08.00', end: '0:00:10.00' },
  { start: '0:00:10.00', end: '0:00:12.00' },
  { start: '0:00:12.00', end: '0:00:14.00' }
];

// ASS header template - white box, black text, centered, with fade
const assHeader = `[Script Info]
Title: NORIKS T-shirt Ad
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,72,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,50,0,5,50,50,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const countries = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];

for (const country of countries) {
  console.log(`\n=== Generating ${country} ===`);
  
  const texts = translations[country];
  let assContent = assHeader;
  
  // Add dialogue lines with fade effect
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i].replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
    assContent += `Dialogue: 0,${timings[i].start},${timings[i].end},Default,,0,0,0,,{\\fad(200,200)}${text}\n`;
  }
  
  // Write ASS file
  const assPath = path.join(outputDir, `subtitles-${country}.ass`);
  fs.writeFileSync(assPath, assContent);
  console.log(`Created ${assPath}`);
  
  // Generate video with burned subtitles
  const outputVideo = path.join(outputDir, `NORIKS-TSHIRT-${country}.mp4`);
  const cmd = `${ffmpeg} -y -i "${videoPath}" -vf "ass='${assPath}'" -c:v libx264 -preset fast -crf 23 -c:a copy "${outputVideo}" 2>&1`;
  
  console.log(`Rendering video for ${country}...`);
  try {
    execSync(cmd, { maxBuffer: 50 * 1024 * 1024 });
    console.log(`✓ Created ${outputVideo}`);
  } catch (err) {
    console.error(`Error for ${country}:`, err.message);
  }
}

console.log('\n=== All done! ===');
console.log(`Output files in: ${outputDir}`);
