const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const framesDir = '/home/ec2-user/.openclaw/workspace2/launches/uploads/scene-analysis';

async function analyzeFrame(framePath, frameNum) {
    const base64 = fs.readFileSync(framePath).toString('base64');
    const timestamp = (frameNum - 1) * 0.5;
    
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
                            text: `Analyze this video frame for a men's underwear ad (NORIKS brand).

Describe in 1-2 sentences:
1. What is shown (product, model, action, setting)
2. Key visual elements (colors, focus, composition)

Also assign a SCENE TYPE from: 
- PRODUCT_SHOT (underwear clearly visible)
- MODEL_WEARING (person wearing the product)
- LIFESTYLE (lifestyle/mood shot)
- DETAIL (close-up of fabric/features)
- ACTION (movement/activity)
- BRANDING (logo/brand elements)
- TRANSITION (blur/movement between scenes)

Return JSON: {"description": "...", "sceneType": "...", "keyElements": ["..."]}`
                        },
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${base64}` }
                        }
                    ]
                }],
                max_tokens: 200
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '{}';
        
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { timestamp, frameNum, ...parsed };
        }
    } catch (e) {
        console.error(`Frame ${frameNum} error:`, e.message);
    }
    
    return { timestamp, frameNum, description: 'Error analyzing', sceneType: 'UNKNOWN' };
}

async function main() {
    console.log('🎬 Analyzing video scenes...\n');
    
    const frames = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort();
    
    console.log(`Found ${frames.length} frames (${frames.length * 0.5}s video)\n`);
    
    const results = [];
    
    // Analyze all frames
    for (let i = 0; i < frames.length; i++) {
        const frameNum = parseInt(frames[i].match(/\d+/)[0]);
        const timestamp = (frameNum - 1) * 0.5;
        console.log(`Analyzing frame ${frameNum} (${timestamp}s)...`);
        
        const result = await analyzeFrame(path.join(framesDir, frames[i]), frameNum);
        results.push(result);
        
        // Small delay to avoid rate limits
        if (i < frames.length - 1) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    // Group into scenes (consecutive frames with same sceneType)
    console.log('\n📊 Detecting scene changes...\n');
    
    const scenes = [];
    let currentScene = null;
    
    for (const frame of results) {
        if (!currentScene || currentScene.sceneType !== frame.sceneType) {
            if (currentScene) {
                currentScene.end = frame.timestamp;
                scenes.push(currentScene);
            }
            currentScene = {
                start: frame.timestamp,
                end: frame.timestamp + 0.5,
                sceneType: frame.sceneType,
                description: frame.description,
                keyElements: frame.keyElements || []
            };
        } else {
            currentScene.end = frame.timestamp + 0.5;
            // Accumulate key elements
            if (frame.keyElements) {
                frame.keyElements.forEach(el => {
                    if (!currentScene.keyElements.includes(el)) {
                        currentScene.keyElements.push(el);
                    }
                });
            }
        }
    }
    
    if (currentScene) {
        scenes.push(currentScene);
    }
    
    // Output results
    console.log('='.repeat(60));
    console.log('📋 SCENE BREAKDOWN');
    console.log('='.repeat(60));
    
    scenes.forEach((scene, i) => {
        console.log(`\n🎬 SCENA ${i + 1}: ${scene.start.toFixed(1)}s - ${scene.end.toFixed(1)}s`);
        console.log(`   Tip: ${scene.sceneType}`);
        console.log(`   Opis: ${scene.description}`);
        if (scene.keyElements.length > 0) {
            console.log(`   Elementi: ${scene.keyElements.join(', ')}`);
        }
    });
    
    console.log('\n' + '='.repeat(60));
    console.log(`Skupaj: ${scenes.length} scen v ${results[results.length-1].timestamp + 0.5}s videu`);
    console.log('='.repeat(60));
    
    // Save to file
    fs.writeFileSync(
        path.join(framesDir, 'scene-analysis.json'),
        JSON.stringify({ frames: results, scenes }, null, 2)
    );
    
    console.log(`\n✅ Analiza shranjena v scene-analysis.json`);
}

main().catch(console.error);
