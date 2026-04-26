/**
 * Cloudflare Worker — CORS Proxy cho Google Labs Veo API
 *
 * Features:
 * - Proxy video generation requests to aisandbox-pa.googleapis.com
 * - Tự động upload ảnh base64 lên Labs để lấy mediaId
 * - All credentials stored as Worker environment variables (never exposed to frontend)
 * - CORS support for allowed origins
 *
 * Environment Variables (set in Cloudflare Dashboard → Worker → Settings → Variables):
 *   LABS_API_KEY          — Google Labs API key
 *   LABS_PROJECT_ID       — Google Labs project UUID
 *   LABS_ACCESS_TOKEN     — (Tùy chọn) Bearer token (ya29.xxx) nếu không dùng Cookie
 *   
 *   Các biến Cookie (Dùng để pass xác thực/reCAPTCHA của Google):
 *   LABS_COOKIE_1PAPISID
 *   LABS_COOKIE_1PSID
 *   LABS_COOKIE_1PSIDCC
 *   LABS_COOKIE_1PSIDTS
 *   LABS_COOKIE_3PAPISID
 *   LABS_COOKIE_3PSID
 *   LABS_COOKIE_3PSIDCC
 *   LABS_COOKIE_3PSIDTS
 *
 * Deploy:
 * 1. Cloudflare Dashboard → Workers & Pages → Create
 * 2. Copy this file content → Deploy
 * 3. Go to Settings → Variables → Add all env vars above
 * 4. Update VEO_LABS_PROXY_URL in your .env with the Worker URL
 */

const AISANDBOX_BASE = 'https://aisandbox-pa.googleapis.com';

const ALLOWED_ORIGINS = [
  'https://ahravay.github.io',
  'https://cypher-runic.io.vn',
  'https://www.cypher-runic.io.vn',
  'http://localhost:3000',
  'http://localhost:5173',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = { ...CORS_HEADERS };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
    },
  });
}

// ==================== Auth & Headers Builder ====================

function getLabsHeaders(env) {
  const headers = {
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

  if (env.LABS_ACCESS_TOKEN) {
    headers['authorization'] = `Bearer ${env.LABS_ACCESS_TOKEN}`;
  }

  // Build Cookie string from env vars
  const cookies = [];
  if (env.LABS_COOKIE_1PAPISID) cookies.push(`__Secure-1PAPISID=${env.LABS_COOKIE_1PAPISID}`);
  if (env.LABS_COOKIE_1PSID) cookies.push(`__Secure-1PSID=${env.LABS_COOKIE_1PSID}`);
  if (env.LABS_COOKIE_1PSIDCC) cookies.push(`__Secure-1PSIDCC=${env.LABS_COOKIE_1PSIDCC}`);
  if (env.LABS_COOKIE_1PSIDTS) cookies.push(`__Secure-1PSIDTS=${env.LABS_COOKIE_1PSIDTS}`);
  if (env.LABS_COOKIE_3PAPISID) cookies.push(`__Secure-3PAPISID=${env.LABS_COOKIE_3PAPISID}`);
  if (env.LABS_COOKIE_3PSID) cookies.push(`__Secure-3PSID=${env.LABS_COOKIE_3PSID}`);
  if (env.LABS_COOKIE_3PSIDCC) cookies.push(`__Secure-3PSIDCC=${env.LABS_COOKIE_3PSIDCC}`);
  if (env.LABS_COOKIE_3PSIDTS) cookies.push(`__Secure-3PSIDTS=${env.LABS_COOKIE_3PSIDTS}`);
  
  if (cookies.length > 0) {
    headers['cookie'] = cookies.join('; ');
  }

  return headers;
}

// ==================== API Callers ====================

async function uploadImageToLabs(base64Data, env) {
  // Extract base64 part if it contains data URI prefix
  const cleanBase64 = base64Data.includes('base64,') 
    ? base64Data.split('base64,')[1] 
    : base64Data;

  const requestBody = {
    clientContext: {
      projectId: env.LABS_PROJECT_ID,
      tool: "PINHOLE"
    },
    imageBytes: cleanBase64
  };

  const headers = getLabsHeaders(env);
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

// ==================== Route Handler ====================

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /generate — Generate video
      if (path === '/generate' && request.method === 'POST') {
        return await handleGenerate(request, env);
      }

      // POST /status — Poll video status
      if (path === '/status' && request.method === 'POST') {
        return await handleStatus(request, env);
      }

      // GET /config — Check if Labs API is configured
      if (path === '/config' && request.method === 'GET') {
        return jsonResponse({
          labsAvailable: !!(env.LABS_ACCESS_TOKEN || env.LABS_COOKIE_1PSID) && !!env.LABS_PROJECT_ID,
        }, 200, request);
      }

      return jsonResponse({ error: 'Not found' }, 404, request);
    } catch (error) {
      return jsonResponse({ success: false, error: error.message }, 500, request);
    }
  },
};

// ==================== /generate ====================

async function handleGenerate(request, env) {
  const body = await request.json();
  const {
    prompt,
    aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT',
    seed,
    videoModelKey = 'veo_3_1_r2v_fast_portrait_ultra_relaxed',
    referenceImageBase64List = [], // Array of { base64, mimeType }
  } = body;

  if (!prompt) {
    return jsonResponse({ success: false, error: 'Prompt is required.' }, 400, request);
  }

  if (!env.LABS_PROJECT_ID) {
    return jsonResponse({ success: false, error: 'LABS_PROJECT_ID chưa được cấu hình.' }, 400, request);
  }

  // 1. Upload all reference images to get mediaIds
  const uploadedMediaIds = [];
  for (const img of referenceImageBase64List) {
    try {
      const mediaId = await uploadImageToLabs(img.base64, env);
      uploadedMediaIds.push(mediaId);
    } catch (err) {
      return jsonResponse({ success: false, error: `Image upload error: ${err.message}` }, 500, request);
    }
  }

  // 2. Build generate request
  const batchId = crypto.randomUUID();
  const sessionId = `;${Date.now()}`;
  const videoSeed = seed ?? Math.floor(Math.random() * 1000);

  const referenceImages = uploadedMediaIds.map((id) => ({
    mediaId: id,
    imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
  }));

  const requestBody = {
    mediaGenerationContext: {
      batchId,
      audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
    },
    clientContext: {
      projectId: env.LABS_PROJECT_ID,
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

  const apiUrl = `${AISANDBOX_BASE}/v1/video:batchAsyncGenerateVideoReferenceImages`;

  const headers = getLabsHeaders(env);
  headers['content-type'] = 'text/plain;charset=UTF-8';

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return jsonResponse(
      { success: false, error: `Labs API error: ${response.status}`, detail: errorText },
      response.status,
      request
    );
  }

  const data = await response.json();

  const operationStatus = data?.operations?.[0]?.status;
  const operationName = data?.operations?.[0]?.operation?.name;

  if (operationStatus === 'MEDIA_GENERATION_STATUS_PENDING' && operationName) {
    return jsonResponse({ success: true, status: 'pending', operationName, data }, 200, request);
  }

  return jsonResponse({ success: true, status: 'complete', data }, 200, request);
}

// ==================== /status ====================

async function handleStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const { operationName } = body;
  
  if (!operationName) {
    return jsonResponse({ success: false, error: 'operationName is required' }, 400, request);
  }

  const apiKey = env.LABS_API_KEY || '';
  const keyParam = apiKey ? `?key=${apiKey}` : '';
  const cleanOperationName = operationName.startsWith('operations/') ? operationName : `operations/${operationName}`;
  const apiUrl = `${AISANDBOX_BASE}/v1/${cleanOperationName}${keyParam}`;

  const headers = getLabsHeaders(env);

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return jsonResponse({ success: false, error: errorText }, response.status, request);
  }

  const data = await response.json();
  return jsonResponse({ success: true, data }, 200, request);
}
