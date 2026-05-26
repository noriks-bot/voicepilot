/**
 * ElevenLabs Voiceover Module
 * Generates TTS audio from .ass subtitles and mixes into video
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'ff5070a28c04b3fd0122f71f068f1ea4937ddc194e5918152481b4ef4bd5fbab';
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const FFMPEG = '/usr/local/bin/ffmpeg';

// Voice settings for consistent, professional sound
const VOICE_SETTINGS = {
    stability: 0.95,
    similarity_boost: 0.9,
    style: 0.0,
    use_speaker_boost: false
};

/**
 * Parse .ass subtitle file and extract dialogue lines
 * Returns array of { start, end, text } (times in seconds)
 */
function parseAssSubtitles(assPath) {
    const content = fs.readFileSync(assPath, 'utf8');
    const lines = content.split('\n');
    const dialogues = [];

    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) continue;

        const parts = line.split(',');
        if (parts.length < 10) continue;

        const startStr = parts[1].trim();
        const endStr = parts[2].trim();
        // Text is everything after 9th comma, strip ASS tags
        const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim();

        if (!text) continue;

        const start = parseAssTime(startStr);
        const end = parseAssTime(endStr);

        dialogues.push({ start, end, text });
    }

    return dialogues;
}

/**
 * Parse ASS time format "H:MM:SS.CS" to seconds
 */
function parseAssTime(timeStr) {
    const parts = timeStr.match(/(\d+):(\d+):(\d+)\.(\d+)/);
    if (!parts) return 0;
    return parseInt(parts[1]) * 3600 + parseInt(parts[2]) * 60 + parseInt(parts[3]) + parseInt(parts[4]) / 100;
}

/**
 * Generate TTS audio clip using ElevenLabs
 */
async function generateTTSClip(text, outputPath, voiceId) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || DEFAULT_VOICE_ID}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
            text,
            model_id: ELEVENLABS_MODEL,
            voice_settings: VOICE_SETTINGS
        })
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
}

/**
 * Normalize audio clip to target loudness (EBU R128, 2-pass)
 */
function normalizeClip(inputPath, outputPath, targetLUFS = -16) {
    // Pass 1: measure
    const measureOutput = execSync(
        `${FFMPEG} -i "${inputPath}" -af "loudnorm=I=${targetLUFS}:LRA=7:TP=-1.5:print_format=json" -f null /dev/null 2>&1`,
        { encoding: 'utf8' }
    );

    // Extract measured values
    const jsonMatch = measureOutput.match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
    if (!jsonMatch) {
        // Fallback: simple volume normalization
        execSync(`${FFMPEG} -y -i "${inputPath}" -af "loudnorm=I=${targetLUFS}:LRA=7:TP=-1.5" "${outputPath}" 2>/dev/null`);
        return;
    }

    const measured = JSON.parse(jsonMatch[0]);

    // Pass 2: apply with measured values
    execSync(
        `${FFMPEG} -y -i "${inputPath}" -af "loudnorm=I=${targetLUFS}:LRA=7:TP=-1.5:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:linear=true" "${outputPath}" 2>/dev/null`
    );
}

/**
 * Add voiceover to a video using its .ass subtitle for timing
 * 
 * @param {string} videoPath - Path to the video (with subtitles burned in)
 * @param {string} assPath - Path to the .ass subtitle file
 * @param {string} outputPath - Output video path
 * @param {object} options - { voiceId, originalVolume, voiceoverVolume }
 */
async function addVoiceover(videoPath, assPath, outputPath, options = {}) {
    const {
        voiceId = DEFAULT_VOICE_ID,
        originalVolume = 0.12,
        voiceoverVolume = 3.0,
        targetLUFS = -16
    } = options;

    const dialogues = parseAssSubtitles(assPath);
    if (dialogues.length === 0) {
        console.log('[Voiceover] No dialogues found in subtitle file');
        // Just copy the video as-is
        fs.copyFileSync(videoPath, outputPath);
        return;
    }

    const workDir = path.join(path.dirname(outputPath), '_voiceover_tmp');
    fs.mkdirSync(workDir, { recursive: true });

    try {
        console.log(`[Voiceover] Generating ${dialogues.length} TTS clips...`);

        // Generate and normalize all clips
        for (let i = 0; i < dialogues.length; i++) {
            const d = dialogues[i];
            console.log(`[Voiceover]   [${i}] "${d.text}" @ ${d.start}s`);

            const rawPath = path.join(workDir, `clip_${i}_raw.mp3`);
            const normPath = path.join(workDir, `clip_${i}.mp3`);

            await generateTTSClip(d.text, rawPath, voiceId);
            normalizeClip(rawPath, normPath, targetLUFS);
        }

        // Build ffmpeg filter to mix all clips at correct timestamps
        let inputs = '';
        let filter = '';
        let amixInputs = '';

        for (let i = 0; i < dialogues.length; i++) {
            const d = dialogues[i];
            const clipPath = path.join(workDir, `clip_${i}.mp3`);
            inputs += ` -i "${clipPath}"`;

            const delayMs = Math.round(d.start * 1000);
            filter += `[${i + 1}:a]adelay=${delayMs}|${delayMs},volume=${voiceoverVolume}[a${i}];`;
            amixInputs += `[a${i}]`;
        }

        // Mix all voiceover clips together
        filter += `${amixInputs}amix=inputs=${dialogues.length}:duration=longest[voiceover];`;
        // Duck original audio and mix with voiceover
        filter += `[0:a]volume=${originalVolume}[orig];[orig][voiceover]amix=inputs=2:duration=first:weights=1 ${voiceoverVolume}[final]`;

        const cmd = `${FFMPEG} -y -i "${videoPath}"${inputs} -filter_complex "${filter}" -map 0:v -map "[final]" -c:v copy -c:a aac -b:a 192k "${outputPath}" 2>&1`;

        console.log(`[Voiceover] Mixing audio...`);
        execSync(cmd, { maxBuffer: 50 * 1024 * 1024 });
        console.log(`[Voiceover] Done: ${outputPath}`);

    } finally {
        // Cleanup temp files
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

module.exports = {
    addVoiceover,
    parseAssSubtitles,
    generateTTSClip,
    normalizeClip,
    DEFAULT_VOICE_ID
};
