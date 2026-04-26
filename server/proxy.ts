/**
 * Express proxy server for Google Labs Veo API
 * Handles CORS issues when calling external APIs from the browser.
 * 
 * In development, Vite's built-in proxy handles this.
 * In production (e.g., Cloud Run), this Express server serves static files
 * and proxies requests to external APIs.
 * 
 * Usage: npx tsx server/proxy.ts
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Load .env file
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Parse JSON bodies (increased limit for base64 images)
app.use(express.json({ limit: '50mb' }));

// ==================== Labs Veo API Proxy ====================

const AISANDBOX_BASE = 'https://aisandbox-pa.googleapis.com';

function getLabsHeaders() {
  const headers: Record<string, string> = {
    'accept': '*/*',
    'accept-language': 'vi',
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'x-browser-channel': 'stable',
    'x-browser-copyright': 'Copyright 2026 Google LLC. All Rights reserved.',
    'x-browser-validation': 'jb22yUkoV3Npo3n6tSAI1eU+2lE=',
    'x-browser-year': '2026',
    'x-client-data': 'CKmdygEIkqHLAQiGoM0BGLGKzwEY1b3PAQ==',
  };

  const labsAccessToken = process.env.LABS_ACCESS_TOKEN || '';
  if (labsAccessToken) {
    headers['authorization'] = `Bearer ${labsAccessToken}`;
  }

  // Build Cookie string from env vars
  const cookies = [];
  if (process.env.LABS_COOKIE_1PAPISID) cookies.push(`__Secure-1PAPISID=${process.env.LABS_COOKIE_1PAPISID}`);
  if (process.env.LABS_COOKIE_1PSID) cookies.push(`__Secure-1PSID=${process.env.LABS_COOKIE_1PSID}`);
  if (process.env.LABS_COOKIE_1PSIDCC) cookies.push(`__Secure-1PSIDCC=${process.env.LABS_COOKIE_1PSIDCC}`);
  if (process.env.LABS_COOKIE_1PSIDTS) cookies.push(`__Secure-1PSIDTS=${process.env.LABS_COOKIE_1PSIDTS}`);
  if (process.env.LABS_COOKIE_3PAPISID) cookies.push(`__Secure-3PAPISID=${process.env.LABS_COOKIE_3PAPISID}`);
  if (process.env.LABS_COOKIE_3PSID) cookies.push(`__Secure-3PSID=${process.env.LABS_COOKIE_3PSID}`);
  if (process.env.LABS_COOKIE_3PSIDCC) cookies.push(`__Secure-3PSIDCC=${process.env.LABS_COOKIE_3PSIDCC}`);
  if (process.env.LABS_COOKIE_3PSIDTS) cookies.push(`__Secure-3PSIDTS=${process.env.LABS_COOKIE_3PSIDTS}`);
  
  if (cookies.length > 0) {
    headers['cookie'] = cookies.join('; ');
  }

  return headers;
}

async function uploadImageToLabs(base64Data: string) {
  // Extract base64 part if it contains data URI prefix
  const cleanBase64 = base64Data.includes('base64,') 
    ? base64Data.split('base64,')[1] 
    : base64Data;

  const requestBody = {
    clientContext: {
      projectId: process.env.LABS_PROJECT_ID,
      tool: "PINHOLE"
    },
    imageBytes: cleanBase64
  };

  const headers = getLabsHeaders();
  headers['content-type'] = 'text/plain;charset=UTF-8';

  const response = await fetch(`${AISANDBOX_BASE}/v1/flow/uploadImage`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload image failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const mediaId = data?.workflow?.metadata?.primaryMediaId;
  
  if (!mediaId) {
    throw new Error('Upload image succeeded but missing primaryMediaId in response');
  }

  return mediaId;
}

/**
 * POST /api/veo/generate
 * 
 * Proxy to Google Labs aisandbox API for video generation.
 * All credentials are read from environment variables — never from the client.
 */
app.post('/api/veo/generate', async (req, res) => {
  const labsProjectId = process.env.LABS_PROJECT_ID || '';

  if (!labsProjectId) {
    return res.status(400).json({ success: false, error: 'LABS_PROJECT_ID chưa được cấu hình.' });
  }

  const {
    prompt,
    aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT',
    seed,
    videoModelKey = 'veo_3_1_r2v_fast_portrait_ultra_relaxed',
    referenceImageBase64List = [], // Array of { base64, mimeType }
  } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required.' });
  }

  try {
    console.log(`[VeoLabs] Processing request...`);

    // 1. Upload images
    const uploadedMediaIds: string[] = [];
    if (referenceImageBase64List && referenceImageBase64List.length > 0) {
      console.log(`[VeoLabs] Uploading ${referenceImageBase64List.length} images...`);
      for (const img of referenceImageBase64List) {
        const mediaId = await uploadImageToLabs(img.base64);
        uploadedMediaIds.push(mediaId);
        console.log(`[VeoLabs] Uploaded image, mediaId: ${mediaId}`);
      }
    }

    const batchId = randomUUID();
    const sessionId = `;${Date.now()}`;
    const videoSeed = seed ?? Math.floor(Math.random() * 1000);

    const referenceImages = uploadedMediaIds.map((id) => ({
      mediaId: id,
      imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
    }));

    const requestBody: any = {
      mediaGenerationContext: {
        batchId,
        audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
      },
      clientContext: {
        projectId: labsProjectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId,
      },
      requests: [
        {
          aspectRatio,
          seed: videoSeed,
          textInput: {
            structuredPrompt: {
              parts: [{ text: prompt }],
            },
          },
          videoModelKey,
          metadata: {},
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        },
      ],
      useV2ModelConfig: true,
    };

    const url = `${AISANDBOX_BASE}/v1/video:batchAsyncGenerateVideoReferenceImages`;

    const headers = getLabsHeaders();
    headers['content-type'] = 'text/plain;charset=UTF-8';

    // Use AbortController for long timeout (10 minutes)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

    console.log(`[VeoLabs] Generating video... batchId=${batchId}`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VeoLabs] API error ${response.status}:`, errorText);
      return res.status(response.status).json({
        success: false,
        error: `Labs API error: ${response.status}`,
        detail: errorText,
      });
    }

    const data = await response.json();
    console.log(`[VeoLabs] Response received for batchId=${batchId}`);

    const operationStatus = data?.operations?.[0]?.status;
    const operationName = data?.operations?.[0]?.operation?.name;

    if (operationStatus === 'MEDIA_GENERATION_STATUS_PENDING' && operationName) {
      return res.json({
        success: true,
        status: 'pending',
        operationName,
        data,
      });
    }

    return res.json({
      success: true,
      status: 'complete',
      data,
    });

  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('[VeoLabs] Request timed out (10 min)');
      return res.status(504).json({ success: false, error: 'Video generation timed out (10 phút).' });
    }
    console.error('[VeoLabs] Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/veo/status
 * 
 * Poll video generation status using the operation name.
 * Calls aisandbox API to check if the video is ready.
 */
app.post('/api/veo/status', async (req, res) => {
  const { operationName } = req.body;
  const labsApiKey = process.env.LABS_API_KEY || '';

  if (!operationName) {
    return res.status(400).json({ success: false, error: 'operationName is required' });
  }

  try {
    const keyParam = labsApiKey ? `?key=${labsApiKey}` : '';
    // Xử lý trường hợp operationName bị dính tiền tố 'operations/'
    const cleanOperationName = operationName.startsWith('operations/') ? operationName : `operations/${operationName}`;
    const url = `${AISANDBOX_BASE}/v1/${cleanOperationName}${keyParam}`;

    const headers = getLabsHeaders();

    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ success: false, error: errorText });
    }

    const data = await response.json();
    return res.json({ success: true, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/veo/config
 * 
 * Returns non-sensitive configuration info so frontend knows
 * which generation methods are available.
 */
app.get('/api/veo/config', (_req, res) => {
  res.json({
    labsAvailable: !!(process.env.LABS_PROJECT_ID),
  });
});

// Serve static files from dist (production build)
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// SPA fallback — serve index.html for all unmatched routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running at http://localhost:${PORT}`);
  console.log(`   - Static files: ${distPath}`);
  console.log(`   - Veo Labs proxy: /api/veo/* → aisandbox-pa.googleapis.com`);
});
