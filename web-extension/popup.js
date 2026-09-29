/**
 * PageIntel AI - Popup Script
 * Multi-turn chat interface integrated with Redis Docker Vector Store and FastAPI Backend.
 * Features:
 * 1. Mozilla Readability & structured fallback extraction
 * 2. Direct PDF / arXiv document text extraction via backend
 * 3. Automatic Screenshot OCR fallback when page text is unextractable
 * 4. 1-Click visible screen capture & OCR button
 * 5. Interactive Snipping Tool & in-popup cropper modal for formulas/tables
 */

document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const redisStatusBadge = document.getElementById('redis-status-badge');
  const domainTag = document.getElementById('domain-tag');
  const pageTitle = document.getElementById('page-title');
  const chatContainer = document.getElementById('chat-messages-container');
  const userQueryInput = document.getElementById('user-query');
  const sendBtn = document.getElementById('send-btn');
  const clearChatBtn = document.getElementById('clear-chat-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  const quickChips = document.querySelectorAll('.quick-chip');

  // OCR & Snip Elements
  const ocrScreenBtn = document.getElementById('ocr-screen-btn');
  const snipAreaBtn = document.getElementById('snip-area-btn');
  const cropperModal = document.getElementById('cropper-modal');
  const closeCropperBtn = document.getElementById('close-cropper-btn');
  const cropperPreviewImg = document.getElementById('cropper-preview-img');
  const cropperBox = document.getElementById('cropper-box');
  const cropperCanvasWrap = document.getElementById('cropper-canvas-wrap');
  const cropperDims = document.getElementById('cropper-dims');
  const executeCropBtn = document.getElementById('execute-crop-btn');

  // Settings Elements
  const settingsBtn = document.getElementById('settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsDrawer = document.getElementById('settings-drawer');
  const backendUrlInput = document.getElementById('backend-url-input');
  const groqApiKeyInput = document.getElementById('groq-api-key-input');
  const groqModelInput = document.getElementById('groq-model-input');
  const hfTokenInput = document.getElementById('hf-token-input');
  const tavilyApiKeyInput = document.getElementById('tavily-api-key-input');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const serverHealthText = document.getElementById('server-health-text');

  // Application State
  let activeTab = null;
  let extractedPageData = null;
  let previousPageId = null;
  let isSending = false;

  // Cropper State
  let cropperImgData = null;
  let cropperStart = null;
  let currentCrop = null;

  let settings = {
    backendUrl: 'http://localhost:8000',
    groqApiKey: '',
    groqModel: 'openai/gpt-oss-120b',
    hfToken: '',
    tavilyApiKey: '',
  };

  // Load Settings
  chrome.storage.local.get(['pageIntelSettings', 'lastActivePageId'], (res) => {
    if (res.pageIntelSettings) {
      settings = { ...settings, ...res.pageIntelSettings };
      backendUrlInput.value = settings.backendUrl || 'http://localhost:8000';
      groqApiKeyInput.value = settings.groqApiKey || '';
      groqModelInput.value = settings.groqModel || 'openai/gpt-oss-120b';
      hfTokenInput.value = settings.hfToken || '';
      if (tavilyApiKeyInput) tavilyApiKeyInput.value = settings.tavilyApiKey || '';
    }
    previousPageId = res.lastActivePageId || null;
  });

  // Check for any background snip OCR results
  chrome.storage.local.get(['lastOcrResult'], (res) => {
    if (res.lastOcrResult && (Date.now() - res.lastOcrResult.timestamp < 15000)) {
      appendOcrCard(res.lastOcrResult);
      chrome.storage.local.remove(['lastOcrResult']);
    }
  });

  // Initialize
  init();

  function isRestrictedUrl(url) {
    if (!url) return true;
    const lower = url.toLowerCase();
    return (
      lower.startsWith('chrome://') ||
      lower.startsWith('chrome-extension://') ||
      lower.startsWith('edge://') ||
      lower.startsWith('brave://') ||
      lower.startsWith('about:') ||
      lower.startsWith('data:') ||
      lower.startsWith('view-source:') ||
      lower.includes('chromewebstore.google.com') ||
      lower.includes('chrome.google.com/webstore')
    );
  }

  function isPdfPage(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      lower.endsWith('.pdf') ||
      lower.includes('arxiv.org/pdf/') ||
      lower.includes('arxiv.org/abs/')
    );
  }

  /**
   * In-page direct DOM extractor fallback
   */
  function inPageDirectExtractor() {
    try {
      const root = document.body || document.documentElement;
      if (!root) {
        return {
          success: true,
          data: {
            unq_id: (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'page-' + Date.now()),
            title: document.title || 'Untitled Page',
            content: '',
            metadata: { url: window.location.href, title: document.title },
            stats: { wordCount: 0, charCount: 0 }
          }
        };
      }

      const clone = root.cloneNode(true);
      const junkSelectors = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'template', 'nav', 'header', 'footer'];
      junkSelectors.forEach((sel) => {
        clone.querySelectorAll(sel).forEach((el) => {
          try { el.remove(); } catch(e){}
        });
      });

      // Extract tables as simple markdown
      clone.querySelectorAll('table').forEach((tbl) => {
        const rows = Array.from(tbl.querySelectorAll('tr'));
        if (rows.length) {
          const md = rows.map((r) => Array.from(r.querySelectorAll('th, td')).map((c) => (c.innerText || c.textContent || '').trim()).join(' | ')).join('\n');
          const div = document.createElement('div');
          div.textContent = '\n' + md + '\n';
          tbl.parentNode?.replaceChild(div, tbl);
        }
      });

      const raw = clone.innerText || clone.textContent || '';
      const cleanContent = raw.split('\n').map((l) => l.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();

      const url = window.location.href;
      const pageId = (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'page-' + Date.now());

      return {
        success: true,
        data: {
          unq_id: pageId,
          unique_id: pageId,
          title: document.title || url,
          content: cleanContent,
          metadata: {
            url: url,
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content || '',
          },
          stats: {
            wordCount: cleanContent.split(/\s+/).filter(Boolean).length,
            charCount: cleanContent.length,
          }
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tab;

      if (!tab || !tab.id) {
        showStatus('No Tab', 'error');
        domainTag.textContent = 'Unavailable';
        return;
      }

      if (isRestrictedUrl(tab.url)) {
        domainTag.textContent = 'Protected Page';
        pageTitle.textContent = 'Internal browser and web store pages cannot be scripted.';
        showStatus('Protected Page', 'error');
        appendMessage('assistant', '⚠️ **Browser Security Policy:** Chrome disables extension scripting on internal pages.');
        return;
      }

      try {
        const urlObj = new URL(tab.url);
        domainTag.textContent = urlObj.hostname || 'Web Page';
      } catch {
        domainTag.textContent = 'Web Page';
      }
      pageTitle.textContent = tab.title || 'Untitled Page';

      await triggerPageExtraction(tab.id);
      checkBackendHealth();
    } catch (err) {
      console.error('Initialization error:', err);
      showStatus('Init Error', 'error');
    }
  }

  function showStatus(text, type = 'ready') {
    redisStatusBadge.textContent = text;
    redisStatusBadge.className = 'redis-status-badge';
    if (type === 'syncing') redisStatusBadge.classList.add('syncing');
    if (type === 'error') redisStatusBadge.classList.add('error');
  }

  /**
   * Direct PDF extraction for arXiv or PDF documents
   */
  async function handleDirectPdfExtraction(url, pageId) {
    showStatus('⏳ Ingesting PDF Paper...', 'syncing');
    domainTag.innerHTML = `<span class="pdf-badge">📄 arXiv PDF</span>`;

    const baseUrl = settings.backendUrl.replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/extract_pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId,
          url: url,
          title: activeTab?.title || 'Research Paper',
          previous_page_id: previousPageId && previousPageId !== pageId ? previousPageId : null,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.success) {
        showStatus(`⚡ Ready (${data.chunk_count} chunks)`, 'ready');
        extractedPageData = {
          unq_id: pageId,
          unique_id: pageId,
          title: data.title || activeTab.title,
          content: `Paper title: ${data.title}\nParsed ${data.num_pages} pages into Redis vector store.`,
          metadata: { url: url, title: data.title },
          stats: { wordCount: data.word_count, charCount: data.char_count, isPdf: true },
        };

        appendMessage(
          'assistant',
          `📄 **Research Paper Ingested into Redis!**\n\n` +
          `• **Title:** ${data.title}\n` +
          `• **Extracted:** ${data.num_pages} pages (${data.chunk_count} vector chunks)\n\n` +
          `Ask questions about the paper, or use **📸 Capture Screen** / **✂️ Snip Area** to analyze specific equations or figures visually.`
        );
        return true;
      }
    } catch (err) {
      console.warn('[PageIntel Popup] Direct PDF extraction failed:', err);
    }
    return false;
  }

  /**
   * Request content extraction with Automatic PDF and Screenshot OCR backup
   */
  async function triggerPageExtraction(tabId) {
    showStatus('⏳ Scraping Page...', 'syncing');

    if (!activeTab || !activeTab.url) {
      showStatus('No Tab URL', 'error');
      return;
    }

    if (isRestrictedUrl(activeTab.url)) {
      showStatus('Protected Page', 'error');
      appendMessage('assistant', '⚠️ Chrome strictly disables extension script injection on this page.');
      return;
    }

    // Generate or fetch persistent page UUID
    const pageIdRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_OR_GENERATE_PAGE_ID', url: activeTab.url }, resolve);
    });
    const pageId = pageIdRes?.unq_id || ('page-' + Date.now());

    // 1. STRATEGY 1: Check if page is an arXiv paper or direct PDF
    if (isPdfPage(activeTab.url)) {
      const pdfSuccess = await handleDirectPdfExtraction(activeTab.url, pageId);
      if (pdfSuccess) return;
    }

    // 2. STRATEGY 2: Content script extraction
    let res = null;
    let injectionErrorDetail = null;

    try {
      res = await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_PAGE_DATA' }).catch(() => null);
    } catch (e) {
      console.debug('Standard message attempt threw:', e);
    }

    if (!res || !res.success || !res.data) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['lib/Readability.js', 'content.js'],
        });
        await new Promise((r) => setTimeout(r, 150));
        res = await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_PAGE_DATA' }).catch(() => null);
      } catch (injectErr) {
        injectionErrorDetail = injectErr.message || String(injectErr);
      }
    }

    if (!res || !res.success || !res.data) {
      try {
        const [execResult] = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: inPageDirectExtractor,
        });
        if (execResult?.result?.success && execResult?.result?.data) {
          res = execResult.result;
        }
      } catch (funcErr) {
        if (!injectionErrorDetail) injectionErrorDetail = funcErr.message || String(funcErr);
      }
    }

    const contentText = res?.data?.content ? res.data.content.trim() : '';

    // If valid text was extracted
    if (contentText && contentText.length >= 80 && !contentText.includes('No visible DOM content')) {
      extractedPageData = res.data;
      await checkRedisIndexStatus(extractedPageData.unq_id || pageId);
      return;
    }

    // 3. STRATEGY 3: AUTOMATIC OCR BACKUP
    // When text is unextractable (e.g. PDF viewer plugin, Canva, scanned document, or dynamic canvas)
    console.log('[PageIntel Popup] Empty DOM text detected. Initiating Automatic Screenshot OCR Backup...');
    showStatus('📸 OCR Backup...', 'syncing');
    domainTag.innerHTML = `<span class="ocr-tag">📸 Visual OCR Mode</span>`;

    const ocrSucceeded = await handleScreenCaptureAndOcr(null, null, true);
    if (!ocrSucceeded) {
      showStatus('Scrape Error', 'error');
      appendMessage('assistant', `⚠️ **Could not extract text:** Could not scrape DOM or run visual OCR. Ensure backend is running at ${settings.backendUrl}.`);
    }
  }

  /**
   * Visual Screen Capture & OCR Processing
   */
  async function handleScreenCaptureAndOcr(crop = null, imageBase64 = null, isAutoFallback = false) {
    showStatus('📸 Processing OCR...', 'syncing');
    const thinking = appendThinkingIndicator(
      '📸 Tesseract OCR & LaTeX Formatting',
      'Capturing visible screen and formatting equations & tables with Groq...'
    );

    try {
      let b64 = imageBase64;
      if (!b64) {
        const capRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_SCREEN' }, resolve);
        });
        if (!capRes || !capRes.dataUrl) {
          throw new Error('Screenshot capture failed. Ensure tab is visible.');
        }
        b64 = capRes.dataUrl;
      }

      const baseUrl = settings.backendUrl.replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
      const pageId = extractedPageData?.unq_id || (await new Promise((r) => {
        chrome.runtime.sendMessage({ action: 'GET_OR_GENERATE_PAGE_ID', url: activeTab.url }, (res) => r(res.unq_id));
      }));

      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: b64,
          page_id: pageId,
          url: activeTab?.url || '',
          title: activeTab?.title || 'Visual Page Screenshot',
          crop: crop,
          enhance_with_llm: true,
          index_into_redis: true,
          previous_page_id: previousPageId && previousPageId !== pageId ? previousPageId : null,
          groq_api_key: settings.groqApiKey || null,
          groq_model: settings.groqModel || null,
        }),
      });

      thinking.remove();

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const ocrResult = await response.json();

      if (!ocrResult.success || !ocrResult.clean_text) {
        if (!isAutoFallback) {
          appendMessage('assistant', `⚠️ **No text detected:** ${ocrResult.error || 'Please make sure text or figures are clearly displayed.'}`);
        }
        showStatus('⚡ Redis Ready', 'ready');
        return false;
      }

      // Update extractedPageData
      if (!extractedPageData) {
        extractedPageData = {
          unq_id: pageId,
          unique_id: pageId,
          title: activeTab?.title || 'Visual Document Content',
          content: ocrResult.clean_text,
          metadata: { url: activeTab?.url || '', title: activeTab?.title },
          stats: { wordCount: ocrResult.word_count, charCount: ocrResult.char_count, isOcr: true },
        };
      } else {
        extractedPageData.content = `${extractedPageData.content}\n\n${ocrResult.clean_text}`;
      }

      showStatus(`📸 OCR Active (${ocrResult.chunk_count} chunks)`, 'ready');
      domainTag.innerHTML = `<span class="ocr-tag">📸 OCR Active</span>`;

      // Render OCR Result Card in Chat
      appendOcrCard(ocrResult, b64, isAutoFallback);
      return true;

    } catch (err) {
      if (thinking) thinking.remove();
      console.error('OCR Error:', err);
      if (!isAutoFallback) {
        appendMessage('assistant', `⚠️ **OCR Failed:** ${err.message}`);
      }
      showStatus('OCR Error', 'error');
      return false;
    }
  }

  /**
   * Append Rich OCR Card in Chat
   */
  function appendOcrCard(ocrResult, imageBase64, isAutoFallback = false) {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'chat-message assistant';

    const cleanSnippet = ocrResult.clean_text || '';
    const words = ocrResult.word_count || cleanSnippet.split(/\s+/).length;

    let thumbHtml = '';
    if (imageBase64) {
      thumbHtml = `<img src="${imageBase64}" class="ocr-thumb" alt="Captured view" title="Screenshot region captured for OCR" />`;
    }

    const titlePrefix = isAutoFallback ? '📸 Automatic OCR Fallback' : '📸 Visual Screen OCR';

    cardDiv.innerHTML = `
      <div class="message-bubble ocr-card">
        <div class="ocr-tag">${titlePrefix}</div>
        ${thumbHtml}
        <div>${formatMarkdown(cleanSnippet)}</div>
        <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">
          Extracted <strong>${words} words</strong> (${ocrResult.chunk_count || 1} chunks indexed in Redis)
        </div>
      </div>
      <div class="message-meta">PageIntel AI • Vision OCR</div>
    `;

    chatContainer.appendChild(cardDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  /**
   * In-Popup Cropper Interaction (Safe fallback when DOM injection is restricted)
   */
  async function openInPopupCropper() {
    showStatus('📸 Capturing Screen...', 'syncing');
    const capRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_SCREEN' }, resolve);
    });

    if (!capRes || !capRes.dataUrl) {
      appendMessage('assistant', '⚠️ Could not capture screen for snipping.');
      return;
    }

    cropperImgData = capRes.dataUrl;
    cropperPreviewImg.src = cropperImgData;
    cropperBox.style.display = 'none';
    currentCrop = null;
    cropperDims.textContent = 'Drag a box over the formula, table, or section';
    cropperModal.style.display = 'flex';
  }

  // Cropper Mouse Events
  let isCropping = false;
  let cropStartX = 0, cropStartY = 0;

  cropperCanvasWrap.addEventListener('mousedown', (e) => {
    isCropping = true;
    const rect = cropperCanvasWrap.getBoundingClientRect();
    cropStartX = e.clientX - rect.left;
    cropStartY = e.clientY - rect.top;
    cropperBox.style.display = 'block';
    cropperBox.style.left = `${cropStartX}px`;
    cropperBox.style.top = `${cropStartY}px`;
    cropperBox.style.width = '0px';
    cropperBox.style.height = '0px';
  });

  cropperCanvasWrap.addEventListener('mousemove', (e) => {
    if (!isCropping) return;
    const rect = cropperCanvasWrap.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    const left = Math.min(cropStartX, currentX);
    const top = Math.min(cropStartY, currentY);
    const width = Math.abs(currentX - cropStartX);
    const height = Math.abs(currentY - cropStartY);

    cropperBox.style.left = `${left}px`;
    cropperBox.style.top = `${top}px`;
    cropperBox.style.width = `${width}px`;
    cropperBox.style.height = `${height}px`;

    cropperDims.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
  });

  cropperCanvasWrap.addEventListener('mouseup', () => {
    if (!isCropping) return;
    isCropping = false;

    // Calculate normalized crop coordinates relative to original image resolution
    const wrapRect = cropperCanvasWrap.getBoundingClientRect();
    const imgRect = cropperPreviewImg.getBoundingClientRect();
    const boxRect = cropperBox.getBoundingClientRect();

    if (boxRect.width < 15 || boxRect.height < 15) {
      cropperBox.style.display = 'none';
      currentCrop = null;
      return;
    }

    const scaleX = cropperPreviewImg.naturalWidth / imgRect.width;
    const scaleY = cropperPreviewImg.naturalHeight / imgRect.height;

    const relLeft = (boxRect.left - imgRect.left) * scaleX;
    const relTop = (boxRect.top - imgRect.top) * scaleY;
    const relWidth = boxRect.width * scaleX;
    const relHeight = boxRect.height * scaleY;

    currentCrop = {
      x: Math.max(0, Math.round(relLeft)),
      y: Math.max(0, Math.round(relTop)),
      width: Math.round(relWidth),
      height: Math.round(relHeight),
    };
  });

  closeCropperBtn.addEventListener('click', () => {
    cropperModal.style.display = 'none';
  });

  executeCropBtn.addEventListener('click', async () => {
    if (!currentCrop) {
      cropperDims.textContent = 'Please drag a selection box first.';
      return;
    }
    cropperModal.style.display = 'none';
    await handleScreenCaptureAndOcr(currentCrop, cropperImgData);
  });

  /**
   * Handle Snip Area Button Click
   */
  async function handleSnipAreaClick() {
    // Attempt sending START_SNIPPING to active tab
    try {
      const res = await chrome.tabs.sendMessage(activeTab.id, { action: 'START_SNIPPING' }).catch(() => null);
      if (res && res.success) {
        window.close(); // Close popup so user can drag selection on webpage
        return;
      }
    } catch {}

    // Fallback: Open in-popup cropper modal
    openInPopupCropper();
  }

  // Connect OCR toolbar buttons
  ocrScreenBtn.addEventListener('click', () => handleScreenCaptureAndOcr());
  snipAreaBtn.addEventListener('click', () => handleSnipAreaClick());

  /**
   * Check if page is indexed in Redis backend
   */
  async function checkRedisIndexStatus(pageId) {
    const baseUrl = settings.backendUrl.replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/page_status/${pageId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.is_indexed && data.meta) {
          showStatus('⚡ Redis Ready', 'ready');
          loadChatHistory(pageId);
          return;
        }
      }
      showStatus('⚡ Redis Ready', 'ready');
    } catch {
      showStatus('⚡ Redis Ready', 'ready');
    }
  }

  /**
   * Load prior multi-turn chat history
   */
  async function loadChatHistory(pageId) {
    const baseUrl = settings.backendUrl.replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/chat_history/${pageId}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.history && data.history.length > 0) {
        chatContainer.innerHTML = '';
        data.history.forEach((turn) => {
          appendMessage(turn.role, turn.content);
        });
      }
    } catch (e) {
      console.debug('Could not load chat history:', e);
    }
  }

  /**
   * Send User Message
   */
  async function handleSendMessage(queryText) {
    const query = (queryText || userQueryInput.value).trim();
    if (!query || isSending) return;

    if (!extractedPageData) {
      appendMessage('assistant', '⚠️ Page data is still loading. Please wait a moment or click **📸 Capture Screen**.');
      return;
    }

    appendMessage('user', query);
    userQueryInput.value = '';
    userQueryInput.style.height = 'auto';

    isSending = true;
    sendBtn.disabled = true;
    const thinkingIndicator = appendThinkingIndicator('🔍 Redis Vector Search', 'Searching Redis vector store for relevant chunks...');

    try {
      const baseUrl = settings.backendUrl.replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
      const endpoint = `${baseUrl}/api/ask/stream`;

      showStatus('⚡ Querying Redis...', 'syncing');

      const payload = {
        page_id: extractedPageData.unq_id,
        url: extractedPageData.metadata.url || activeTab.url,
        title: extractedPageData.title || extractedPageData.metadata.title || activeTab.title,
        content: extractedPageData.content,
        query: query,
        previous_page_id: previousPageId && previousPageId !== extractedPageData.unq_id ? previousPageId : null,
        groq_api_key: settings.groqApiKey || null,
        groq_model: settings.groqModel || null,
        tavily_api_key: settings.tavilyApiKey || null,
      };

      let finalData = null;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line.trim());
              // Step / progress updates
              if (event.stage === 'retrieval' || event.stage === 'generation' || event.event === 'step') {
                thinkingIndicator.update(
                  event.tool || event.step || 'Processing',
                  event.message || event.detail || ''
                );
              }
              // Final answer event
              if (event.stage === 'done' || event.event === 'done') {
                finalData = event.data || event;
              } else if (event.answer) {
                finalData = event;
              } else if (event.event === 'error' || event.error) {
                throw new Error(event.message || event.error || 'Stream processing error');
              }
            } catch (jsonErr) {
              console.warn('NDJSON parse error:', jsonErr);
            }
          }
        }

        // Flush any remaining buffer text
        if (buffer && buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim());
            if (event.stage === 'done' || event.event === 'done' || event.answer) {
              finalData = event.data || event;
            }
          } catch (e) {}
        }
      } catch (streamErr) {
        console.warn('Streaming failed, falling back to standard POST /api/ask:', streamErr);
        thinkingIndicator.update('⚡ Falling back to direct API', 'Retrieving answer...');

        const fallbackResp = await fetch(`${baseUrl}/api/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!fallbackResp.ok) {
          const errDetail = await fallbackResp.text();
          throw new Error(`HTTP ${fallbackResp.status}: ${errDetail}`);
        }
        finalData = await fallbackResp.json();
      }

      thinkingIndicator.remove();

      if (finalData && finalData.answer) {
        appendMessage('assistant', finalData.answer, {
          sources: finalData.sources || [],
          tool_used: finalData.tool_used,
          strategy: finalData.strategy,
          retrieved_count: finalData.retrieved_count,
        });
        showStatus('⚡ Redis Ready', 'ready');
      } else {
        appendMessage('assistant', '⚠️ Could not generate an answer. Please verify backend connection.');
        showStatus('Error', 'error');
      }

    } catch (err) {
      thinkingIndicator.remove();
      console.error('Query error:', err);
      appendMessage('assistant', `⚠️ **Query failed:** ${err.message}. Ensure backend is running.`);
      showStatus('Server Offline', 'error');
    } finally {
      isSending = false;
      sendBtn.disabled = false;
    }
  }

  /**
   * Append Chat Message
   */
  function appendMessage(role, text, meta = {}) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (role === 'user') {
      bubble.textContent = text;
    } else {
      let html = '';
      if (meta.tool_used) {
        let toolLabel = '📄 Redis Document Match';
        let toolColor = 'rgba(99, 102, 241, 0.2)';
        if (meta.tool_used === 'web_search') {
          toolLabel = '🌐 Tavily Live Web Search';
          toolColor = 'rgba(6, 182, 212, 0.2)';
        } else if (meta.tool_used === 'direct_llm') {
          toolLabel = '💡 Groq Direct Synthesis';
          toolColor = 'rgba(16, 185, 129, 0.2)';
        }
        html += `<div class="tool-used-tag" style="background: ${toolColor};"><strong>Route:</strong> ${toolLabel}</div>`;
      }

      html += formatMarkdown(text);

      if (meta.sources && meta.sources.length > 0) {
        const sourcesCount = meta.sources.length;
        const srcItems = meta.sources
          .map((s, idx) => {
            if (s.source_type === 'web') {
              return `<div class="source-item"><strong>[Web #${idx + 1}]</strong> <a href="${escapeHtml(s.url)}" target="_blank" style="color:#38bdf8;">${escapeHtml(s.title || s.url)}</a></div>`;
            }
            return `<div class="source-item"><strong>[Chunk #${s.chunk_index !== undefined ? s.chunk_index : idx}]</strong> ${escapeHtml(s.snippet || s.content?.slice(0, 150) || '')}</div>`;
          })
          .join('');

        html += `
          <div class="sources-details">
            <div class="sources-summary" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'flex' : 'none'">
              📚 Retrieved ${sourcesCount} context chunk${sourcesCount > 1 ? 's' : ''} (Click to inspect)
            </div>
            <div class="sources-list" style="display: none;">${srcItems}</div>
          </div>
        `;
      }

      bubble.innerHTML = html;
    }

    msgDiv.appendChild(bubble);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';
    metaDiv.textContent = role === 'user' ? 'You' : 'PageIntel AI';
    msgDiv.appendChild(metaDiv);

    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  /**
   * Append Thinking / Step Indicator
   */
  function appendThinkingIndicator(initialPill = 'Searching', initialStatus = 'Thinking...') {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message assistant';

    const bubble = document.createElement('div');
    bubble.className = 'thinking-bubble';
    bubble.innerHTML = `
      <div class="thinking-top-row">
        <div class="dots-flurry">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <span class="tool-badge-pill" id="live-tool-pill">${escapeHtml(initialPill)}</span>
      </div>
      <div class="tool-status-text" id="live-tool-text">${escapeHtml(initialStatus)}</div>
    `;

    msgDiv.appendChild(bubble);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    const pillEl = bubble.querySelector('#live-tool-pill');
    const textEl = bubble.querySelector('#live-tool-text');

    return {
      update: (pill, status) => {
        if (pillEl) pillEl.textContent = pill;
        if (textEl) textEl.textContent = status;
        chatContainer.scrollTop = chatContainer.scrollHeight;
      },
      remove: () => {
        msgDiv.remove();
      }
    };
  }

  /**
   * Safe Markdown Formatter
   */
  function formatMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // LaTeX blocks: $$...$$
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, '<pre style="background:rgba(99,102,241,0.1); border-left:3px solid #6366f1; padding:6px 10px;"><code>$1</code></pre>');

    // Inline LaTeX: $...$
    html = html.replace(/\$([^\$\n]+)\$/g, '<code style="color:#a5b4fc; background:rgba(99,102,241,0.15);">$1</code>');

    // Code blocks: ```language\ncode```
    html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Bullet lists: * item or - item
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Markdown tables: | col | col |
    const tableRegex = /((?:\|[^\n]+\|\r?\n)+)/g;
    html = html.replace(tableRegex, (match) => {
      const rows = match.trim().split('\n');
      if (rows.length < 2) return match;
      let tableHtml = '<table style="border-collapse:collapse; width:100%; margin:8px 0; font-size:11.5px;">';
      rows.forEach((r, idx) => {
        if (r.includes('---')) return; // separator
        const cells = r.split('|').filter((_, cIdx, arr) => cIdx > 0 && cIdx < arr.length - 1);
        const tag = idx === 0 ? 'th' : 'td';
        const style = idx === 0 ? 'border:1px solid #374151; padding:4px 6px; background:#1f2937;' : 'border:1px solid #374151; padding:4px 6px;';
        tableHtml += `<tr>${cells.map(c => `<${tag} style="${style}">${c.trim()}</${tag}>`).join('')}</tr>`;
      });
      tableHtml += '</table>';
      return tableHtml;
    });

    // Paragraphs
    const paragraphs = html.split(/\n\n+/);
    return paragraphs
      .map((p) => {
        if (p.startsWith('<pre>') || p.startsWith('<ul>') || p.startsWith('<table')) return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Event Listeners
   */
  sendBtn.addEventListener('click', () => handleSendMessage());

  userQueryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  userQueryInput.addEventListener('input', () => {
    userQueryInput.style.height = 'auto';
    userQueryInput.style.height = `${Math.min(userQueryInput.scrollHeight, 80)}px`;
  });

  quickChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        userQueryInput.value = prompt;
        handleSendMessage(prompt);
      }
    });
  });

  clearChatBtn.addEventListener('click', () => {
    chatContainer.innerHTML = `
      <div class="chat-message assistant">
        <div class="message-bubble">
          <p><strong>Chat Cleared.</strong></p>
          <p>Ask any questions about this page to search the Redis vector store.</p>
        </div>
        <div class="message-meta">PageIntel AI</div>
      </div>
    `;
  });

  refreshBtn.addEventListener('click', async () => {
    if (activeTab && activeTab.id) {
      await triggerPageExtraction(activeTab.id);
    }
  });

  settingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.add('open');
    checkBackendHealth();
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.remove('open');
  });

  saveSettingsBtn.addEventListener('click', () => {
    settings.backendUrl = backendUrlInput.value.trim() || 'http://localhost:8000';
    settings.groqApiKey = groqApiKeyInput.value.trim();
    settings.groqModel = groqModelInput.value.trim() || 'openai/gpt-oss-120b';
    settings.hfToken = hfTokenInput.value.trim();
    settings.tavilyApiKey = tavilyApiKeyInput ? tavilyApiKeyInput.value.trim() : '';

    chrome.storage.local.set({ pageIntelSettings: settings }, () => {
      saveSettingsBtn.textContent = 'Saved!';
      setTimeout(() => {
        saveSettingsBtn.textContent = 'Save Settings';
        settingsDrawer.classList.remove('open');
      }, 1000);
    });
  });

  async function checkBackendHealth() {
    const baseUrl = (settings.backendUrl || 'http://localhost:8000').replace(/\/api\/ask\/?$/, '').replace(/\/+$/, '');
    serverHealthText.textContent = `Connecting to ${baseUrl}...`;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'healthy') {
        serverHealthText.innerHTML = `
          <span style="color: var(--accent-emerald);">● Online</span> • Redis Connected<br>
          <span style="color: var(--text-muted);">Index: ${data.vector_index} (${data.indexed_documents_count} docs)</span><br>
          <span style="color: #818cf8; font-size:10px;">OCR: Tesseract 5.3 + LaTeX Active</span>
        `;
      } else {
        serverHealthText.innerHTML = `<span style="color: var(--accent-amber);">● Degraded</span>: ${data.error || 'Check Redis'}`;
      }
    } catch (err) {
      serverHealthText.innerHTML = `<span style="color: var(--accent-rose);">● Offline</span> (${err.message})<br><span style="color: var(--text-muted);">Start FastAPI backend on localhost:8000</span>`;
    }
  }
});
