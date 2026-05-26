const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const framesDir = '/home/ec2-user/.openclaw/workspace2/launches/uploads/analysis';
const outputDir = '/home/ec2-user/.openclaw/workspace2/launches/uploads/output';

async function analyzeFrame(framePath, frameNum) {
    const base64 = fs.readFileSync(framePath).toString('base64');
    const timestamp = (frameNum - 1) * 0.5; // 2 fps = 0.5s per frame
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Analyze this video frame for TEXT OVERLAYS (not text on products/objects).

Extract ONLY text that appears as an overlay/caption/title added in post-production.

For each text found, provide:
1. "text": The exact text content
2. "position": "top", "center", or "bottom" (vertical position)
3. "align": "left", "center", or "right" (horizontal alignment)
4. "style": Brief description (color, size: small/medium/large, bold/normal)

Return JSON array: [{"text": "...", "position": "...", "align": "...", "style": "..."}]
If no overlay text visible, return: []`
                        },
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${base64}` }
                        }
                    ]
                }],
                max_tokens: 500
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const texts = JSON.parse(jsonMatch[0]);
            return { timestamp, frameNum, texts };
        }
    } catch (e) {
        console.error(`Frame ${frameNum} error:`, e.message);
    }
    
    return { timestamp, frameNum, texts: [] };
}

async function main() {
    console.log('🔍 Analyzing video frames for text overlays...\n');
    
    const frames = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort();
    
    console.log(`Found ${frames.length} frames to analyze\n`);
    
    const results = [];
    
    // Analyze frames in batches of 5 to avoid rate limits
    for (let i = 0; i < frames.length; i += 5) {
        const batch = frames.slice(i, i + 5);
        const batchResults = await Promise.all(
            batch.map((f, idx) => {
                const frameNum = parseInt(f.match(/\d+/)[0]);
                console.log(`Analyzing frame ${frameNum} (${((frameNum-1)*0.5).toFixed(1)}s)...`);
                return analyzeFrame(path.join(framesDir, f), frameNum);
            })
        );
        results.push(...batchResults);
        
        // Small delay between batches
        if (i + 5 < frames.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    // Process results to find text segments
    console.log('\n📊 Processing results...\n');
    
    const textSegments = [];
    const activeTexts = new Map(); // text -> {start, position, align, style}
    
    for (const result of results) {
        const currentTexts = new Set(result.texts.map(t => t.text));
        
        // Check for new texts
        for (const t of result.texts) {
            if (!activeTexts.has(t.text)) {
                activeTexts.set(t.text, {
                    start: result.timestamp,
                    position: t.position,
                    align: t.align,
                    style: t.style
                });
            }
        }
        
        // Check for ended texts
        for (const [text, data] of activeTexts.entries()) {
            if (!currentTexts.has(text)) {
                textSegments.push({
                    text,
                    start: data.start,
                    end: result.timestamp,
                    position: data.position,
                    align: data.align,
                    style: data.style
                });
                activeTexts.delete(text);
            }
        }
    }
    
    // Close any remaining active texts
    const lastTimestamp = results[results.length - 1]?.timestamp || 23;
    for (const [text, data] of activeTexts.entries()) {
        textSegments.push({
            text,
            start: data.start,
            end: lastTimestamp + 0.5,
            position: data.position,
            align: data.align,
            style: data.style
        });
    }
    
    // Sort by start time
    textSegments.sort((a, b) => a.start - b.start);
    
    // Output results
    console.log('📝 Found text segments:\n');
    textSegments.forEach((seg, i) => {
        console.log(`${i + 1}. "${seg.text}"`);
        console.log(`   ⏱️  ${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s`);
        console.log(`   📍 Position: ${seg.position}, Align: ${seg.align}`);
        console.log(`   🎨 Style: ${seg.style}\n`);
    });
    
    // Save results
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
        path.join(outputDir, 'text-segments.json'),
        JSON.stringify(textSegments, null, 2)
    );
    
    console.log(`\n✅ Saved to ${outputDir}/text-segments.json`);
}

main().catch(console.error);
