import React, { useState } from 'react';
import { Copy, RotateCcw, Sparkles, Check, Video, Download, Key, ImagePlus, X, Maximize2, FileVideo } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

// Labs API proxy URL:
// - Dev: Vite proxy /api/veo → http://localhost:3001
// - Prod: Cloudflare Worker proxy
const labsProxyUrl = process.env.VEO_LABS_PROXY_URL || '';
const LABS_API_BASE = import.meta.env.DEV
  ? '/api/veo'
  : (labsProxyUrl || '/api/veo');

// Gemini AI client for prompt generation (Tạo các cảnh / Tạo cảnh kết)
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// Veo Labs API — calls backend proxy which securely forwards to aisandbox API
const generateVideoWithVeoLabs = async (prompt: string, refImages: { url: string, base64: string, mimeType: string }[]): Promise<string> => {
  // Step 1: Call backend proxy to generate video
  const response = await fetch(`${LABS_API_BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
      videoModelKey: 'veo_3_1_r2v_fast_portrait_ultra_relaxed',
      // We pass the base64 images to the proxy.
      // NOTE: The proxy currently doesn't know how to upload them to Labs.
      // It relies on LABS_REF_IMAGE_IDS env var for now.
      referenceImageBase64List: refImages.map(img => ({
        base64: img.base64,
        mimeType: img.mimeType
      }))
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Labs API error: ${response.status}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || 'Labs API generation failed.');
  }

  // Step 2: If pending, poll for completion
  if (result.status === 'pending' && result.operationName) {
    const maxPollingTime = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxPollingTime) {
      await new Promise(resolve => setTimeout(resolve, 8000));

      const pollResponse = await fetch(`${LABS_API_BASE}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: result.operationName })
      });
      if (!pollResponse.ok) continue;

      const pollData = await pollResponse.json();
      if (!pollData.success) continue;

      // Check if done — look for video URL or completed status
      const opData = pollData.data;
      if (opData?.done || opData?.metadata?.state === 'SUCCEEDED') {
        // Try to extract video URL from response
        const videoUri = opData?.response?.generatedVideos?.[0]?.video?.uri
          || opData?.result?.mediaContents?.[0]?.uri
          || opData?.metadata?.finalVideoUri; // Possible fallback field
        if (videoUri) {
          const videoResponse = await fetch(videoUri);
          if (!videoResponse.ok) throw new Error('Lỗi khi tải video từ Labs API.');
          const blob = await videoResponse.blob();
          return URL.createObjectURL(blob);
        }
        throw new Error('Video hoàn thành nhưng không tìm thấy URL.');
      }
    }
    throw new Error('Labs video generation timed out (10 phút).');
  }

  // Step 3: If response contains video data directly
  const media = result.data?.media?.[0];
  const videoUri = media?.video?.generatedVideo?.uri
    || result.data?.operations?.[0]?.result?.mediaContents?.[0]?.uri;

  if (videoUri) {
    const videoResponse = await fetch(videoUri);
    if (!videoResponse.ok) throw new Error('Lỗi khi tải video từ Labs API.');
    const blob = await videoResponse.blob();
    return URL.createObjectURL(blob);
  }

  // If we got here, return raw data info for debugging
  throw new Error('Labs API: không tìm thấy video URL trong response.');
};

// Video item with source tracking
interface VideoItem {
  url: string;
  source: 'labs';
}

const VideoBlock = ({ prompt, label, refImages }: { prompt: string, label: string, refImages: { url: string, base64: string, mimeType: string }[] }) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateVideo = async () => {
    if (!prompt) return;
    setIsGenerating(true);
    setError(null);
    try {
      // Generate a single video using exclusively Labs API
      const generateSingleVideo = async (): Promise<VideoItem> => {
        try {
          const labsUrl = await generateVideoWithVeoLabs(prompt, refImages);
          return { url: labsUrl, source: 'labs' };
        } catch (labsError: any) {
          console.error('[Labs API Error]', labsError.message);
          throw new Error(`Google Labs API thất bại: ${labsError.message}`);
        }
      };

      const promises = Array(4).fill(null).map(() => generateSingleVideo());
      const results = await Promise.allSettled(promises);

      const successfulVideos = results
        .filter((r): r is PromiseFulfilledResult<VideoItem> => r.status === 'fulfilled')
        .map(r => r.value);

      if (successfulVideos.length === 0) {
        const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
        throw firstError || new Error("Không thể tạo video nào bằng Google Labs API.");
      }

      setVideos(successfulVideos);
      const labsCount = successfulVideos.filter(v => v.source === 'labs').length;

      if (successfulVideos.length < 4) {
        setError(`Tạo thành công ${successfulVideos.length}/4 video từ Google Labs.`);
      }

    } catch (err: any) {
      console.error(err);
      if (err.message?.includes("Requested entity was not found")) {
        setError("API Key không hợp lệ hoặc hết hạn. Vui lòng chọn lại.");
        if (window.aistudio) {
          await window.aistudio.openSelectKey();
        }
      } else {
        setError(err.message || "Có lỗi xảy ra khi tạo video.");
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-700 flex flex-col gap-3">
      {videos.length === 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-between gap-y-2">
            {[1, 2, 3, 4].map(num => (
              <div key={num} className="w-[168px] h-[298px] bg-slate-800 rounded border border-slate-700 flex items-center justify-center text-slate-500 text-sm shrink-0">
                {isGenerating ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <Video size={20} className="opacity-50" />
                )}
              </div>
            ))}
          </div>
          <button
            onClick={handleGenerateVideo}
            disabled={isGenerating || !prompt}
            className="self-start flex items-center gap-2 px-3 py-1.5 bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[0.8rem] font-semibold rounded hover:bg-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <div className="w-3 h-3 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Video size={14} />
            )}
            {isGenerating ? 'Đang tạo 4 video...' : 'Tạo 4 Video (Google Labs)'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-between gap-y-2">
            {videos.map((videoItem, idx) => (
              <div key={idx} className="flex flex-col gap-1 w-[168px] shrink-0">
                <div className="relative group">
                  <video
                    id={`video-${label}-${idx}`}
                    src={videoItem.url}
                    controls
                    className="w-[168px] h-[298px] rounded border border-slate-700 bg-black object-cover"
                  />
                  <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase rounded bg-purple-500/80 text-white">
                    Labs
                  </span>
                  <button
                    onClick={() => {
                      const video = document.getElementById(`video-${label}-${idx}`) as HTMLVideoElement;
                      if (video) {
                        if (video.requestFullscreen) video.requestFullscreen();
                        else if ((video as any).webkitRequestFullscreen) (video as any).webkitRequestFullscreen();
                        else if ((video as any).msRequestFullscreen) (video as any).msRequestFullscreen();
                      }
                    }}
                    className="absolute top-2 right-2 p-1.5 bg-black/60 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                    title="Phóng to"
                  >
                    <Maximize2 size={14} />
                  </button>
                </div>
                <a
                  href={videoItem.url}
                  download={`scene-${label}-${idx + 1}.mp4`}
                  className="flex items-center justify-center gap-1 px-2 py-1 bg-slate-700 text-white text-[0.7rem] font-medium rounded hover:bg-slate-600 transition-colors"
                >
                  <Download size={10} />
                  Tải
                </a>
              </div>
            ))}
            {Array(4 - videos.length).fill(null).map((_, idx) => (
              <div key={`failed-${idx}`} className="w-[168px] h-[298px] bg-slate-800/50 rounded border border-slate-700/50 flex flex-col items-center justify-center text-slate-500 text-xs text-center p-2 shrink-0">
                <span className="text-red-400/70">Lỗi tạo video</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <div className="text-red-400 text-xs mt-1">{error}</div>}
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'analysis' | 'scene' | 'ending'>('analysis');

  // Tab Analysis state
  const [analysisVideoFile, setAnalysisVideoFile] = useState<File | null>(null);
  const [analysisVideoUrl, setAnalysisVideoUrl] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisScenePrompts, setAnalysisScenePrompts] = useState<string[]>([]);
  const [isGeneratingScenesFromAnalysis, setIsGeneratingScenesFromAnalysis] = useState(false);
  const [geminiFileUri, setGeminiFileUri] = useState<string | null>(null);

  // Tab 1 state
  const [scenePrompt, setScenePrompt] = useState('');
  const [vocabulary, setVocabulary] = useState('');
  const [sceneResults, setSceneResults] = useState<string[]>(['', '', '', '']);
  const [isGeneratingScenes, setIsGeneratingScenes] = useState(false);
  const [refImages, setRefImages] = useState<{ url: string, base64: string, mimeType: string }[]>([]);

  // Tab 2 state
  const [endingPrompt, setEndingPrompt] = useState('');
  const [endingResult, setEndingResult] = useState('');
  const [isGeneratingEnding, setIsGeneratingEnding] = useState(false);

  // Copy state
  const [copiedIndex, setCopiedIndex] = useState<number | string | null>(null);

  const handleReset = () => {
    setScenePrompt('');
    setVocabulary('');
    setSceneResults(['', '', '', '']);
    setEndingPrompt('');
    setEndingResult('');
    setRefImages([]);
    setAnalysisVideoFile(null);
    setAnalysisVideoUrl(null);
    setGeminiFileUri(null);
    setAnalysisResult('');
    setAnalysisScenePrompts([]);
  };

  const uploadVideoToGemini = async (file: File) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Chưa cấu hình GEMINI_API_KEY');

    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': file.size.toString(),
        'X-Goog-Upload-Header-Content-Type': file.type,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { displayName: file.name } })
    });

    if (!initRes.ok) throw new Error('Khởi tạo upload thất bại');
    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('Không lấy được URL upload');

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
      },
      body: file
    });

    if (!uploadRes.ok) throw new Error('Upload video thất bại');
    const fileInfo = await uploadRes.json();
    return fileInfo.file;
  };

  const pollVideoProcessingState = async (fileName: string) => {
    const apiKey = process.env.GEMINI_API_KEY;
    let state = 'PROCESSING';
    while (state === 'PROCESSING') {
      await new Promise(r => setTimeout(r, 5000));
      const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${fileName.split('/').pop()}?key=${apiKey}`);
      if (!checkRes.ok) throw new Error('Lỗi kiểm tra trạng thái video');
      const checkData = await checkRes.json();
      state = checkData.state;
      if (state === 'FAILED') throw new Error('Xử lý video thất bại');
    }
  };

  const analyzeVideo = async () => {
    if (!analysisVideoFile) return;
    if (!ai) {
      alert('Chưa cấu hình API Key. Vui lòng thiết lập GEMINI_API_KEY.');
      return;
    }
    setIsAnalyzing(true);
    setAnalysisResult('');
    setAnalysisScenePrompts([]);
    try {
      let currentFileUri = geminiFileUri;

      if (!currentFileUri) {
        const uploadedFile = await uploadVideoToGemini(analysisVideoFile);
        await pollVideoProcessingState(uploadedFile.name);
        currentFileUri = uploadedFile.uri;
        setGeminiFileUri(currentFileUri);
      }


      const prompt = `Hãy phân tích chi tiết video này để tôi có thể tạo ra các video có phong cách và nội dung tương tự. Vui lòng cung cấp: 1. Mô tả chi tiết ngoại hình, trang phục, và đặc điểm nhận dạng của các nhân vật chính để có thể tái tạo lại một cách nhất quán. 2. Tóm tắt nội dung, bối cảnh, cốt truyện, và phong cách hình ảnh (art style, lighting, camera angles) của video. 3. Phân tích cách video triển khai nội dung để tạo điểm nhấn thu hút người xem (hook, pacing, trend). 4. Đưa ra các chỉ dẫn cụ thể để xây dựng prompt tái hiện lại cảm giác và chất lượng của video gốc.`;
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: currentFileUri, mimeType: analysisVideoFile.type } },
              { text: prompt }
            ]
          }
        ]
      });

      if (response.text) {
        setAnalysisResult(response.text);
      }
    } catch (error: any) {
      console.error('Error analyzing video:', error);
      alert(error.message || 'Có lỗi xảy ra khi phân tích video. Vui lòng thử lại.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const generateScenePromptsFromAnalysis = async () => {
    if (!analysisResult) return;
    if (!ai) {
      alert('Chưa cấu hình API Key. Vui lòng thiết lập GEMINI_API_KEY.');
      return;
    }
    setIsGeneratingScenesFromAnalysis(true);
    try {
      const prompt = `Dựa vào nội dung phân tích dưới đây, hãy tạo ra các prompt chi tiết cho trình tạo video AI (Veo 3.1) để tạo ra các video mang phong cách, nội dung và chất lượng tương tự như video gốc. Mỗi prompt mô tả một cảnh ngắn (2-3 giây) để tái hiện lại các phân cảnh nổi bật hoặc xây dựng một câu chuyện có cùng vibe. Trả về kết quả dưới dạng một mảng JSON chứa các chuỗi prompt.
      
      Nội dung phân tích:
      ${analysisResult}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING
            }
          }
        }
      });

      if (response.text) {
        const results = JSON.parse(response.text);
        if (Array.isArray(results)) {
          setAnalysisScenePrompts(results);
        }
      }
    } catch (error) {
      console.error('Error generating scenes from analysis:', error);
      alert('Có lỗi xảy ra khi tạo prompt. Vui lòng thử lại.');
    } finally {
      setIsGeneratingScenesFromAnalysis(false);
    }
  };

  const handleAnalysisVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalysisVideoFile(file);
    setAnalysisVideoUrl(URL.createObjectURL(file));
    setGeminiFileUri(null);
    setAnalysisResult('');
    setAnalysisScenePrompts([]);
  };

  const handleRemoveAnalysisVideo = () => {
    setAnalysisVideoFile(null);
    setAnalysisVideoUrl(null);
    setGeminiFileUri(null);
    setAnalysisResult('');
    setAnalysisScenePrompts([]);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64String = (event.target?.result as string).split(',')[1];
        setRefImages(prev => {
          if (prev.length >= 2) return prev; // max 2
          return [...prev, { url: URL.createObjectURL(file), base64: base64String, mimeType: file.type }];
        });
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeImage = (index: number) => {
    setRefImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleCopy = async (text: string, id: string | number) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(id);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };



  const generateScenes = async () => {
    if (!scenePrompt) return;
    if (!ai) {
      alert('Chưa cấu hình API Key. Vui lòng thiết lập GEMINI_API_KEY.');
      return;
    }
    setIsGeneratingScenes(true);
    try {
      const prompt = `Tôi muốn tạo 4 cảnh video ngắn khác nhau dựa trên chủ đề '${scenePrompt}' và sử dụng các từ vựng này: '${vocabulary}'. Mỗi cảnh nên dài 1-2 giây. Hãy tạo ra các prompt chi tiết cho một trình tạo video AI cho từng cảnh. Trả về kết quả dưới dạng một mảng JSON chứa 4 string prompt.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING
            }
          }
        }
      });

      if (response.text) {
        const results = JSON.parse(response.text);
        if (Array.isArray(results) && results.length >= 4) {
          setSceneResults(results.slice(0, 4));
        } else if (Array.isArray(results)) {
          const padded = [...results, '', '', '', ''].slice(0, 4);
          setSceneResults(padded);
        }
      }
    } catch (error) {
      console.error('Error generating scenes:', error);
      alert('Có lỗi xảy ra khi tạo prompt. Vui lòng thử lại.');
    } finally {
      setIsGeneratingScenes(false);
    }
  };

  const generateEnding = async () => {
    if (!endingPrompt) return;
    if (!ai) {
      alert('Chưa cấu hình API Key. Vui lòng thiết lập GEMINI_API_KEY.');
      return;
    }
    setIsGeneratingEnding(true);
    try {
      const prompt = `Tôi muốn tạo 1 cảnh kết thúc video dựa trên chủ đề '${endingPrompt}'. Cảnh nên dài 2-3 giây. Hãy tạo ra một prompt chi tiết cho một trình tạo video AI cho cảnh này. Trả về kết quả dưới dạng text prompt.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });

      if (response.text) {
        setEndingResult(response.text);
      }
    } catch (error) {
      console.error('Error generating ending:', error);
      alert('Có lỗi xảy ra khi tạo prompt. Vui lòng thử lại.');
    } finally {
      setIsGeneratingEnding(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F0F4F8] text-slate-800 font-sans p-6">
      <div className="max-w-[1024px] mx-auto flex flex-col h-full">
        {/* Header */}
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-[42px] h-[42px] bg-slate-800 text-white flex items-center justify-center font-extrabold text-[1.2rem] rounded-lg tracking-[-1px]">
              CR
            </div>
            <h1 className="text-[1.5rem] font-bold tracking-[-0.02em]">Prompt Render</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (window.aistudio) {
                  await window.aistudio.openSelectKey();
                } else {
                  alert("Tính năng chọn API Key chỉ hoạt động trong môi trường AI Studio.");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-[0.9rem] font-medium text-slate-800 bg-transparent border border-[#CBD5E1] rounded-md hover:bg-[#E2E8F0] transition-colors"
            >
              <Key size={16} />
              Chọn API Key (Veo)
            </button>
            <button
              id="resetBtn"
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 text-[0.9rem] font-medium text-slate-800 bg-transparent border border-[#CBD5E1] rounded-md hover:bg-[#E2E8F0] transition-colors"
            >
              <RotateCcw size={16} />
              Reset
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="flex gap-2 mb-5">
          <button
            className={`px-6 py-2.5 text-[1rem] font-semibold rounded-t-lg transition-all border ${activeTab === 'analysis'
              ? 'bg-sky-100 text-blue-500 border-blue-500 border-b-2 active-tab'
              : 'bg-white text-slate-500 border-[#E2E8F0] hover:bg-gray-50'
              }`}
            onClick={() => setActiveTab('analysis')}
          >
            Phân tích
          </button>
          <button
            className={`px-6 py-2.5 text-[1rem] font-semibold rounded-t-lg transition-all border ${activeTab === 'scene'
              ? 'bg-sky-100 text-blue-500 border-blue-500 border-b-2 active-tab'
              : 'bg-white text-slate-500 border-[#E2E8F0] hover:bg-gray-50'
              }`}
            onClick={() => setActiveTab('scene')}
          >
            Tạo Scene
          </button>
          <button
            className={`px-6 py-2.5 text-[1rem] font-semibold rounded-t-lg transition-all border ${activeTab === 'ending'
              ? 'bg-sky-100 text-blue-500 border-blue-500 border-b-2 active-tab'
              : 'bg-white text-slate-500 border-[#E2E8F0] hover:bg-gray-50'
              }`}
            onClick={() => setActiveTab('ending')}
          >
            Tạo Kết
          </button>
        </div>

        {/* Tab Content */}
        <div className="bg-white rounded-b-xl rounded-tr-xl shadow-[0_4px_6px_-1px_rgba(0,0,0,0.1)] p-6 flex-1 flex flex-col">
          <div className="mb-5 pb-5 border-b border-slate-100">
            <label className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500 mb-2 block">
              Ảnh nhân vật (Tối đa 2 ảnh)
            </label>
            <div className="flex gap-3">
              {refImages.map((img, idx) => (
                <div key={idx} className="relative w-24 h-24 rounded-lg border-2 border-blue-500 overflow-hidden group">
                  <img src={img.url} alt={`Ref ${idx}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeImage(idx)}
                    className="absolute top-1 right-1 bg-black/60 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {refImages.length < 2 && (
                <label className="w-24 h-24 rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 hover:bg-slate-50 hover:border-blue-400 hover:text-blue-500 cursor-pointer transition-colors">
                  <ImagePlus size={24} className="mb-1" />
                  <span className="text-[0.65rem] font-medium uppercase">Thêm ảnh</span>
                  <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageUpload} />
                </label>
              )}
            </div>
          </div>

          {activeTab === 'analysis' ? (
            <div className="flex flex-col flex-1">
              <div className="mb-5 pb-5 border-b border-slate-100">
                <label className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500 mb-2 block">
                  Video cần phân tích
                </label>
                <div className="flex gap-3">
                  {analysisVideoUrl ? (
                    <div className="relative w-48 h-32 rounded-lg border-2 border-blue-500 overflow-hidden group bg-black flex items-center justify-center">
                      <video src={analysisVideoUrl} className="w-full h-full object-contain" controls />
                      <button
                        onClick={handleRemoveAnalysisVideo}
                        className="absolute top-1 right-1 bg-black/60 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <label className="w-48 h-32 rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 hover:bg-slate-50 hover:border-blue-400 hover:text-blue-500 cursor-pointer transition-colors">
                      <FileVideo size={24} className="mb-2" />
                      <span className="text-[0.75rem] font-medium uppercase">Tải video lên</span>
                      <input type="file" accept="video/*" className="hidden" onChange={handleAnalysisVideoUpload} />
                    </label>
                  )}
                </div>
              </div>

              <div className="flex justify-end items-center mb-6">
                <button
                  onClick={analyzeVideo}
                  disabled={isAnalyzing || !analysisVideoFile}
                  className="flex items-center gap-2 px-7 py-3 bg-blue-500 text-white text-[1rem] font-semibold rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                >
                  {isAnalyzing ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {isAnalyzing ? 'Đang phân tích...' : 'Phân tích Video'}
                </button>
              </div>

              <div className="flex flex-col gap-2 mb-5">
                <div className="flex items-center justify-between">
                  <label htmlFor="analysisResultInput" className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500">
                    Kết quả phân tích (có thể chỉnh sửa)
                  </label>
                  <button
                    onClick={() => handleCopy(analysisResult, 'analysisResult')}
                    disabled={!analysisResult}
                    className="flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[0.7rem] font-medium rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    {copiedIndex === 'analysisResult' ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                    {copiedIndex === 'analysisResult' ? 'Đã copy' : 'Copy'}
                  </button>
                </div>
                <textarea
                  id="analysisResultInput"
                  value={analysisResult}
                  onChange={(e) => setAnalysisResult(e.target.value)}
                  placeholder="Kết quả phân tích video sẽ hiển thị ở đây..."
                  className="w-full h-48 p-3 border-[1.5px] border-[#E2E8F0] rounded-lg text-[0.95rem] focus:ring-0 focus:border-blue-500 outline-none resize-none transition-colors"
                />
              </div>

              <div className="flex justify-center items-center mb-6 pt-4 border-t border-slate-100">
                <button
                  onClick={generateScenePromptsFromAnalysis}
                  disabled={isGeneratingScenesFromAnalysis || !analysisResult.trim()}
                  className="flex items-center gap-2 px-7 py-3 bg-indigo-500 text-white text-[1rem] font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isGeneratingScenesFromAnalysis ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {isGeneratingScenesFromAnalysis ? 'Đang tạo...' : 'Tạo nhân vật và prompt'}
                </button>
              </div>

              {analysisScenePrompts.length > 0 && (
                <div className="grid grid-cols-1 gap-4 flex-1">
                  {analysisScenePrompts.map((prompt, index) => (
                    <div key={index} className="bg-slate-900 rounded-lg p-4 flex flex-col relative">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[#94A3B8] text-[0.75rem] font-semibold uppercase">
                          Prompt Cảnh {index + 1}
                        </span>
                        <button
                          onClick={() => handleCopy(prompt, `analysisScene${index}`)}
                          className="flex items-center gap-1 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-[#CBD5E1] text-[0.7rem] rounded cursor-pointer transition-colors"
                        >
                          {copiedIndex === `analysisScene${index}` ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                          {copiedIndex === `analysisScene${index}` ? 'Đã copy' : 'Copy'}
                        </button>
                      </div>
                      <div className="text-[#F8FAFC] font-mono text-[0.85rem] leading-relaxed break-all overflow-y-auto max-h-[150px] mb-3">
                        {prompt}
                      </div>
                      <VideoBlock prompt={prompt} label={`analysis-scene-${index}`} refImages={refImages} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'scene' ? (
            <div className="flex flex-col flex-1">
              <div className="flex flex-col md:flex-row gap-5 mb-5">
                <div className="flex flex-col gap-2 flex-[0.7]">
                  <label htmlFor="scenePromptInput" className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500">
                    Prompt mô tả gốc
                  </label>
                  <textarea
                    id="scenePromptInput"
                    value={scenePrompt}
                    onChange={(e) => setScenePrompt(e.target.value)}
                    placeholder="Ví dụ: Một cuộc rượt đuổi bằng xe cảnh sát trên đường phố thành phố vào ban đêm, với đèn neon lấp lánh và mưa nhẹ..."
                    className="w-full h-32 p-3 border-[1.5px] border-[#E2E8F0] rounded-lg text-[0.95rem] focus:ring-0 focus:border-blue-500 outline-none resize-none transition-colors"
                  />
                </div>
                <div className="flex flex-col gap-2 flex-[0.3]">
                  <label htmlFor="vocabularyInput" className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500">
                    Từ vựng cần sử dụng
                  </label>
                  <textarea
                    id="vocabularyInput"
                    value={vocabulary}
                    onChange={(e) => setVocabulary(e.target.value)}
                    placeholder="Ví dụ: xe cảnh sát, đêm, đường phố, rượt đuổi, neon, mưa..."
                    className="w-full h-32 p-3 border-[1.5px] border-[#E2E8F0] rounded-lg text-[0.95rem] focus:ring-0 focus:border-blue-500 outline-none resize-none transition-colors"
                  />
                </div>
              </div>

              <div className="flex justify-end items-center mb-6">
                <button
                  id="createScenesBtn"
                  onClick={generateScenes}
                  disabled={isGeneratingScenes || !scenePrompt.trim()}
                  className="flex items-center gap-2 px-7 py-3 bg-blue-500 text-white text-[1rem] font-semibold rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                >
                  {isGeneratingScenes ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {isGeneratingScenes ? 'Đang tạo...' : 'Tạo các cảnh'}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 flex-1">
                {[1, 2, 3, 4].map((num, index) => (
                  <div key={num} className="bg-slate-900 rounded-lg p-4 flex flex-col relative">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[#94A3B8] text-[0.75rem] font-semibold uppercase">
                        Prompt Cảnh {num}
                      </span>
                      <button
                        onClick={() => handleCopy(sceneResults[index], `scene${num}`)}
                        disabled={!sceneResults[index]}
                        className="flex items-center gap-1 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-[#CBD5E1] text-[0.7rem] rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {copiedIndex === `scene${num}` ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                        {copiedIndex === `scene${num}` ? 'Đã copy' : 'Copy'}
                      </button>
                    </div>
                    <div
                      id={`sceneResult${num}`}
                      className="text-[#F8FAFC] font-mono text-[0.85rem] leading-relaxed break-all overflow-y-auto h-[80px]"
                    >
                      {sceneResults[index] || <span className="text-slate-500 italic">Chưa có dữ liệu...</span>}
                    </div>
                    <VideoBlock prompt={sceneResults[index]} label={`scene-${num}`} refImages={refImages} />
                  </div>
                ))}
              </div>
            </div>
        ) : (
        <div className="flex flex-col flex-1">
          <div className="flex flex-col gap-2 mb-5">
            <label htmlFor="endingPromptInput" className="text-[0.85rem] font-semibold uppercase tracking-[0.05em] text-slate-500">
              Prompt mô tả cảnh kết thúc
            </label>
            <textarea
              id="endingPromptInput"
              value={endingPrompt}
              onChange={(e) => setEndingPrompt(e.target.value)}
              placeholder="Ví dụ: Cảnh hoàng hôn trên biển, logo Cypher Runic hiện ra, kèm theo thông tin liên hệ..."
              className="w-full h-32 p-3 border-[1.5px] border-[#E2E8F0] rounded-lg text-[0.95rem] focus:ring-0 focus:border-blue-500 outline-none resize-none transition-colors"
            />
          </div>

          <div className="flex justify-end items-center mb-6">
            <button
              id="createEndingBtn"
              onClick={generateEnding}
              disabled={isGeneratingEnding || !endingPrompt.trim()}
              className="flex items-center gap-2 px-7 py-3 bg-blue-500 text-white text-[1rem] font-semibold rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isGeneratingEnding ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Sparkles size={16} />
              )}
              {isGeneratingEnding ? 'Đang tạo...' : 'Tạo cảnh kết'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 flex-1">
            <div className="bg-slate-900 rounded-lg p-4 flex flex-col relative">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[#94A3B8] text-[0.75rem] font-semibold uppercase">
                  Prompt Cảnh Kết
                </span>
                <button
                  onClick={() => handleCopy(endingResult, 'ending')}
                  disabled={!endingResult}
                  className="flex items-center gap-1 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-[#CBD5E1] text-[0.7rem] rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {copiedIndex === 'ending' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  {copiedIndex === 'ending' ? 'Đã copy' : 'Copy'}
                </button>
              </div>
              <div
                id="endingResult"
                className="text-[#F8FAFC] font-mono text-[0.85rem] leading-relaxed break-all overflow-y-auto h-[180px]"
              >
                {endingResult || <span className="text-slate-500 italic">Chưa có dữ liệu...</span>}
              </div>
              <VideoBlock prompt={endingResult} label="ending" refImages={refImages} />
            </div>
          </div>
        </div>
          )}
      </div>
    </div>
    </div >
  );
}
