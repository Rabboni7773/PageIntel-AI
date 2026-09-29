/**
 * PageIntel AI - Background Service Worker (Manifest V3)
 * Orchestrates automatic page scraping, Redis vector indexing,
 * PDF direct extraction for arXiv/papers, and automatic Screenshot OCR backup
 * so that the extension never goes blank of data.
 */

const DEFAULT_BACKEND_URL = 'http://localhost:8000';
let activeDebounceTimer = null;
let lastProcessedUrl = null;

// Context Menus
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'ask-page-intel',
    title: 'Ask PageIntel about this page',
    contexts: ['page'],
  });

  chrome.contextMenus.create({
    id: 'ocr-page-intel',
    title: '📸 Capture & OCR Visible Page',
    contexts: ['page'],
  });

  chrome.contextMenus.create({
    id: 'ask-selection-intel',
    title: 'Ask PageIntel about "%s"',
    contexts: ['selection'],
  });

  // Inject content scripts into all existing open HTTP/HTTPS tabs
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id && !tab.url.includes('chromewebstore.google.com')) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/Readability.js', 'content.js'],
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.debug('[PageIntel Background] Initial script injection skipped:', err.message);
  }

  console.log('[PageIntel Background] Extension initialized with PDF & OCR support.');
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'ocr-page-intel') {
    try {
      const pageInfo = await getOrGeneratePageId(tab.url);
      const storageRes = await chrome.storage.local.get(['lastActivePageId']);
      const prevId = storageRes.lastActivePageId || null;
      
      const screenshot = await captureTabScreenshot(tab.windowId);
      if (screenshot) {
        await syncOcrToBackend(screenshot, pageInfo.page_id, tab.url, tab.title, null, prevId);
      }
    } catch (e) {
      console.warn('[PageIntel Background] Context menu OCR error:', e);
    }
  }
  if (chrome.action && chrome.action.openPopup) {
    chrome.action.openPopup().catch(() => {});
  }
});

/**
 * URL normalization & UUID generation
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return (url || '').split('#')[0];
  }
}

function isPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.pdf') ||
    lower.includes('arxiv.org/pdf/') ||
    lower.includes('arxiv.org/abs/')
  );
}

function generateUUIDv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function getOrGeneratePageId(url) {
  const normUrl = normalizeUrl(url);
  return new Promise((resolve) => {
    chrome.storage.local.get(['page_url_unique_ids'], (res) => {
      const map = res.page_url_unique_ids || {};
      if (map[normUrl]) {
        resolve({ page_id: map[normUrl], isNew: false });
      } else {
        const newId = generateUUIDv4();
        map[normUrl] = newId;
        chrome.storage.local.set({ page_url_unique_ids: map }, () => {
          resolve({ page_id: newId, isNew: true });
        });
      }
    });
  });
}

async function getBackendBaseUrl() {
  const resSettings = await chrome.storage.local.get(['pageIntelSettings']);
  const customBackend = resSettings.pageIntelSettings?.backendUrl;
  let baseUrl = DEFAULT_BACKEND_URL;
  if (customBackend) {
    try {
      const u = new URL(customBackend);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {}
  }
  return baseUrl;
}

/**
 * Capture visible tab as PNG base64 data URL
 */
async function captureTabScreenshot(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId || null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('[PageIntel Background] Capture error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(dataUrl);
      }
    });
  });
}

/**
 * Direct PDF Extraction to Backend
 */
async function syncPdfToBackend(url, pageId, title, previousPageId) {
  try {
    const baseUrl = await getBackendBaseUrl();
    const endpoint = `${baseUrl}/api/extract_pdf`;
    console.log(`[PageIntel Background] Syncing PDF to Redis: ${url} (page_id: ${pageId})`);

    const payload = {
      page_id: pageId,
      url: url,
      title: title || 'Research Paper / PDF',
      previous_page_id: previousPageId && previousPageId !== pageId ? previousPageId : null,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    console.log('[PageIntel Background] PDF successfully parsed & indexed into Redis:', result);

    await chrome.storage.local.set({
      lastSyncState: {
        page_id: pageId,
        url: url,
        title: result.title || title,
        chunk_count: result.chunk_count,
        synced_at: Date.now(),
        previous_page_id: previousPageId,
        isPdf: true,
        success: true,
      },
      lastActivePageId: pageId,
    });

    return result;
  } catch (err) {
    console.warn('[PageIntel Background] PDF sync failed:', err.message);
    return null;
  }
}

/**
 * OCR Screenshot Extraction to Backend
 */
async function syncOcrToBackend(imageBase64, pageId, url, title, crop, previousPageId, autoFallback = false) {
  try {
    const baseUrl = await getBackendBaseUrl();
    const endpoint = `${baseUrl}/api/ocr`;
    console.log(`[PageIntel Background] Sending screenshot to OCR: ${url} (page_id: ${pageId})`);

    const payload = {
      image_base64: imageBase64,
      page_id: pageId,
      url: url || '',
      title: title || 'Visual Screenshot',
      crop: crop || null,
      enhance_with_llm: true,
      index_into_redis: true,
      previous_page_id: previousPageId && previousPageId !== pageId ? previousPageId : null,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    console.log('[PageIntel Background] OCR finished & indexed in Redis:', result);

    const syncState = {
      page_id: pageId,
      url: url,
      title: title || 'Visual OCR Content',
      chunk_count: result.chunk_count,
      synced_at: Date.now(),
      previous_page_id: previousPageId,
      isOcr: true,
      isOcrBackup: autoFallback,
      clean_text: result.clean_text,
      success: result.success,
    };

    await chrome.storage.local.set({
      lastSyncState: syncState,
      lastActivePageId: pageId,
      lastOcrResult: {
        ...result,
        page_id: pageId,
        url: url,
        timestamp: Date.now(),
      },
    });

    return result;
  } catch (err) {
    console.warn('[PageIntel Background] OCR sync failed:', err.message);
    return null;
  }
}

/**
 * Send standard extracted HTML page data to Backend
 */
async function syncPageToBackend(pageData, previousPageId) {
  try {
    const baseUrl = await getBackendBaseUrl();
    const endpoint = `${baseUrl}/api/index_page`;
    console.log(`[PageIntel Background] Syncing to Redis: ${pageData.metadata.url} (page_id: ${pageData.unq_id}, prev: ${previousPageId})`);

    const payload = {
      page_id: pageData.unq_id,
      url: pageData.metadata.url || pageData.url,
      title: pageData.title || pageData.metadata?.title || 'Untitled',
      content: pageData.content || '',
      previous_page_id: previousPageId && previousPageId !== pageData.unq_id ? previousPageId : null,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    console.log('[PageIntel Background] Redis Vector Store synced successfully:', result);

    await chrome.storage.local.set({
      lastSyncState: {
        page_id: pageData.unq_id,
        url: pageData.metadata.url,
        title: pageData.title,
        chunk_count: result.chunk_count,
        synced_at: Date.now(),
        previous_page_id: previousPageId,
        success: true,
      },
      lastActivePageId: pageData.unq_id,
    });

    return result;
  } catch (err) {
    console.warn('[PageIntel Background] Sync to backend failed (backend may be offline):', err.message);
    await chrome.storage.local.set({
      lastSyncState: {
        page_id: pageData.unq_id,
        url: pageData.metadata?.url || '',
        synced_at: Date.now(),
        success: false,
        error: err.message,
      },
    });
    return null;
  }
}

/**
 * Core handler when a page change is detected (tab switch or URL navigation)
 */
async function handlePageChange(tabId, url, triggerSource) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return; // Ignore internal chrome://, extension://, about:blank
  }

  const normalized = normalizeUrl(url);
  if (normalized === lastProcessedUrl && triggerSource === 'URL_NAVIGATION') {
    return;
  }

  // Clear pending debounce
  if (activeDebounceTimer) {
    clearTimeout(activeDebounceTimer);
  }

  // Wait 700ms after navigation to allow page DOM to stabilize
  activeDebounceTimer = setTimeout(async () => {
    lastProcessedUrl = normalized;

    try {
      const pageInfo = await getOrGeneratePageId(url);
      const storageRes = await chrome.storage.local.get(['lastActivePageId']);
      const previousPageId = storageRes.lastActivePageId || null;

      // STRATEGY 1: Check if page is an arXiv paper or direct PDF
      if (isPdfUrl(url)) {
        console.log(`[PageIntel Background] Detected PDF document at ${url}. Triggering direct PDF extraction...`);
        const pdfResult = await syncPdfToBackend(url, pageInfo.page_id, null, previousPageId);
        if (pdfResult && pdfResult.success) {
          return;
        }
      }

      // STRATEGY 2: Request extraction from content script
      let extractionResponse = await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_PAGE_DATA' }).catch(() => null);

      if (!extractionResponse || !extractionResponse.success || !extractionResponse.data) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['lib/Readability.js', 'content.js'],
          });
          await new Promise((r) => setTimeout(r, 150));
          extractionResponse = await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_PAGE_DATA' }).catch(() => null);
        } catch (injectErr) {
          console.debug(`[PageIntel Background] Script injection for tab ${tabId} skipped:`, injectErr.message);
        }
      }

      const pageData = extractionResponse?.data;
      const contentText = pageData?.content ? pageData.content.trim() : '';

      // If content was extracted successfully
      if (contentText && contentText.length >= 80 && !contentText.includes('No visible DOM content')) {
        await syncPageToBackend(pageData, previousPageId);
        return;
      }

      // STRATEGY 3: AUTOMATIC OCR BACKUP
      // If content script returned empty text (e.g. PDF viewer, canvas, scanned paper, SPA):
      console.log(`[PageIntel Background] Content is empty on ${url}. Activating Automatic Screenshot OCR Backup!`);
      const screenshot = await captureTabScreenshot();
      if (screenshot) {
        await syncOcrToBackend(
          screenshot,
          pageInfo.page_id,
          url,
          pageData?.title || 'Visual Page Content',
          null,
          previousPageId,
          true // autoFallback flag
        );
      }

    } catch (err) {
      console.error('[PageIntel Background] Error in handlePageChange:', err);
    }
  }, 700);
}

/**
 * Event 1: User switches active tab (chrome.tabs.onActivated)
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      handlePageChange(tab.id, tab.url, 'TAB_SWITCH');
    }
  } catch (err) {
    console.debug('[PageIntel Background] onActivated check skipped:', err.message);
  }
});

/**
 * Event 2: User navigates to a new page (chrome.tabs.onUpdated)
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && tab.url) {
    handlePageChange(tabId, tab.url, 'URL_NAVIGATION');
  }
});

/**
 * Runtime Message Listeners
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // UUID request
  if (request.action === 'GET_OR_GENERATE_PAGE_ID') {
    getOrGeneratePageId(request.url).then((res) => {
      sendResponse({ success: true, unq_id: res.page_id, unique_id: res.page_id, isNew: res.isNew });
    });
    return true;
  }

  // Get active page sync state
  if (request.action === 'GET_PAGE_SYNC_STATUS') {
    chrome.storage.local.get(['lastSyncState', 'lastActivePageId', 'lastOcrResult'], (res) => {
      sendResponse({
        success: true,
        lastSyncState: res.lastSyncState || null,
        lastActivePageId: res.lastActivePageId || null,
        lastOcrResult: res.lastOcrResult || null,
      });
    });
    return true;
  }

  // Manual capture screen screenshot
  if (request.action === 'CAPTURE_VISIBLE_SCREEN') {
    captureTabScreenshot().then((dataUrl) => {
      sendResponse({ success: !!dataUrl, dataUrl });
    });
    return true;
  }

  // Run OCR on screenshot
  if (request.action === 'TRIGGER_OCR') {
    const { imageBase64, pageId, url, title, crop, previousPageId } = request;
    syncOcrToBackend(imageBase64, pageId, url, title, crop, previousPageId).then((result) => {
      sendResponse({ success: !!result && result.success, result });
    });
    return true;
  }

  // Run direct PDF extraction
  if (request.action === 'TRIGGER_PDF_EXTRACT') {
    const { url, pageId, title, previousPageId } = request;
    syncPdfToBackend(url, pageId, title, previousPageId).then((result) => {
      sendResponse({ success: !!result && result.success, result });
    });
    return true;
  }

  // Snipping tool area selected
  if (request.action === 'SNIP_AREA_SELECTED') {
    const { crop, url, title } = request;
    (async () => {
      const pageInfo = await getOrGeneratePageId(url);
      const storageRes = await chrome.storage.local.get(['lastActivePageId']);
      const prevId = storageRes.lastActivePageId || null;
      const screenshot = await captureTabScreenshot();
      if (screenshot) {
        const ocrRes = await syncOcrToBackend(screenshot, pageInfo.page_id, url, title, crop, prevId);
        sendResponse({ success: true, result: ocrRes });
      } else {
        sendResponse({ success: false, error: 'Screenshot capture failed' });
      }
    })();
    return true;
  }

  // Manual trigger from popup
  if (request.action === 'TRIGGER_SYNC_PAGE') {
    const { pageData, previousPageId } = request;
    if (pageData) {
      syncPageToBackend(pageData, previousPageId).then((result) => {
        sendResponse({ success: !!result, result });
      });
      return true;
    }
  }
});
