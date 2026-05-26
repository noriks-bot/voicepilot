const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const outputDir = '/home/ec2-user/.openclaw/workspace2/launches/uploads/output';
const videoPath = '/home/ec2-user/.openclaw/workspace2/launches/uploads/video-1771851291246.mp4';

const LANGUAGES = {
    'HR': 'Croatian',
    'CZ': 'Czech',
    'PL': 'Polish',
    'GR': 'Greek',
    'IT': 'Italian',
    'HU': 'Hungarian',
    'SK': 'Slovak'
};

// Cleaned up segments (merged duplicates, fixed timing)
const segments = [
    { id: 1, text: "ΑΥΤΑ ΕΙΝΑΙ ΤΑ ΜΠΟΞΕΡ NORIKS", start: 0, end: 3, position: "center" },
    { id: 2, text: "5 φορές πιο μαλακά από το βαμβάκι", start: 3, end: 4.5, position: "center" },
    { id: 3, text: "Άνετα όλη μέρα", start: 4.5, end: 7, position: "center" },
    { id: 4, text: "Κατασκευασμένα από απαλό modal", start: 7, end: 8.5, position: "center" },
    { id: 5, text: "Σαν να μη φοράς τίποτα", start: 8.5, end: 11, position: "center" },
    { id: 6, text: "Ρυθμίζουν τη θερμοκρασία του σώματος", start: 11, end: 12.5, position: "center" },
    { id: 7, text: "Δεν συρρικνώνονται", start: 12.5, end: 14.5, position: "center" },
    { id: 8, text: "Δεν ξεθωριάζουν", start: 14.5, end: 16.5, position: "center" },
    { id: 9, text: "Μεγέθη S-4XL", start: 16.5, end: 21.5, position: "center" },
    { id: 10, text: "ΕΞΟΙΚΟΝΟΜΗΣΕ ΕΩΣ 40%", start: 21.5, end: 23.5, position: "center" },
    { id: 11, text: "ΜΟΝΟ ΑΥΤΗ ΤΗΝ ΕΒΔΟΜΑΔΑ", start: 21.5, end: 23.5, position: "bottom" }
];

function formatSrtTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function generateSrt(segments, translations, lang) {
    let srt = '';
    segments.forEach((seg, i) => {
        const text = lang === 'GR' ? seg.text : (translations[seg.id]?.[lang] || seg.text);
        srt += `${i + 1}\n`;
        srt += `${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n`;
        srt += `${text}\n\n`;
    });
    return srt;
}

async function translateAll(segments) {
    const textsToTranslate = segments.map(s => ({ id: s.id, text: s.text }));
    
    console.log('🌍 Translating to all languages...\n');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a professional marketing translator for NORIKS men's underwear brand. 
Translate short, punchy marketing texts. Keep them concise and impactful.
NORIKS should remain "NORIKS" (brand name).
Maintain the energy and marketing appeal.`
            }, {
                role: 'user',
                content: `Translate these Greek marketing texts to Croatian, Czech, Polish, Italian, Hungarian, and Slovak.

Texts:
${textsToTranslate.map(t => `ID ${t.id}: "${t.text}"`).join('\n')}

Return ONLY valid JSON in this exact format:
{
  "1": {"HR": "...", "CZ": "...", "PL": "...", "IT": "...", "HU": "...", "SK": "..."},
  "2": {"HR": "...", "CZ": "...", "PL": "...", "IT": "...", "HU": "...", "SK": "..."},
  ...
}`
            }],
            max_tokens: 3000
        })
    });
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    
    // Extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Could not parse translations');
}

async function main() {
    console.log('🎬 Video Localization Pipeline\n');
    console.log(`Source: ${videoPath}`);
    console.log(`Output: ${outputDir}\n`);
    
    // 1. Translate
    const translations = await translateAll(segments);
    
    // Add Greek originals
    segments.forEach(s => {
        if (!translations[s.id]) translations[s.id] = {};
        translations[s.id]['GR'] = s.text;
    });
    
    // Save translations
    fs.writeFileSync(
        path.join(outputDir, 'translations.json'),
        JSON.stringify(translations, null, 2)
    );
    console.log('✅ Translations saved\n');
    
    // Print translations
    console.log('📝 Translations:\n');
    for (const seg of segments) {
        console.log(`--- Segment ${seg.id} (${seg.start}s-${seg.end}s) ---`);
        console.log(`GR: ${seg.text}`);
        for (const lang of ['HR', 'CZ', 'PL', 'IT', 'HU', 'SK']) {
            console.log(`${lang}: ${translations[seg.id]?.[lang] || '?'}`);
        }
        console.log('');
    }
    
    // 2. Generate SRT files for each language
    console.log('📄 Generating SRT files...\n');
    for (const lang of Object.keys(LANGUAGES)) {
        const srt = generateSrt(segments, translations, lang);
        const srtPath = path.join(outputDir, `subtitles-${lang}.srt`);
        fs.writeFileSync(srtPath, srt);
        console.log(`   ✅ ${srtPath}`);
    }
    
    // 3. Generate videos with burned-in subtitles
    console.log('\n🎬 Generating localized videos...\n');
    
    for (const lang of Object.keys(LANGUAGES)) {
        const srtPath = path.join(outputDir, `subtitles-${lang}.srt`);
        const outVideo = path.join(outputDir, `video-${lang}.mp4`);
        
        console.log(`   🔄 Generating ${lang} video...`);
        
        // FFmpeg command with styled subtitles
        // White text with black outline, centered
        const cmd = `ffmpeg -y -i "${videoPath}" -vf "subtitles='${srtPath}':force_style='FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=80'" -c:a copy "${outVideo}" 2>/dev/null`;
        
        try {
            execSync(cmd, { stdio: 'pipe' });
            const size = (fs.statSync(outVideo).size / 1024 / 1024).toFixed(1);
            console.log(`   ✅ ${lang}: ${outVideo} (${size} MB)`);
        } catch (e) {
            console.error(`   ❌ ${lang}: Error - ${e.message}`);
        }
    }
    
    console.log('\n🎉 Done! All videos generated.\n');
    console.log('Files:');
    fs.readdirSync(outputDir).forEach(f => {
        console.log(`   📁 ${f}`);
    });
}

main().catch(console.error);
