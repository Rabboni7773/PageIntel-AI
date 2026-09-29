/**
 * PageIntel AI - Content Script Extraction Engine
 * Features:
 * 1. Primary: Mozilla Readability for article/long-form content
 * 2. Fallback: Intelligent Structured Extractor for Dashboards, E-commerce & Web Apps
 * 3. JSON-LD / Schema.org metadata parser (e-commerce specs, prices, ratings)
 * 4. User selection detection
 * 5. Markdown table & list formatter
 */

(() => {
  // Prevent multiple injections within the same extension runtime context
  const currentRuntimeId = chrome.runtime?.id;
  if (window.__PAGE_INTEL_LOADED__ && window.__PAGE_INTEL_RUNTIME_ID__ === currentRuntimeId) {
    return;
  }
  window.__PAGE_INTEL_LOADED__ = true;
  window.__PAGE_INTEL_RUNTIME_ID__ = currentRuntimeId;

  /**
   * Extract basic page metadata (title, canonical URL, meta description, OG tags)
   */
  function extractMetadata() {
    const getMeta = (selector) => {
      const el = document.querySelector(selector);
      return el ? (el.getAttribute('content') || el.getAttribute('value') || '').trim() : '';
    };

    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const canonical = canonicalEl ? canonicalEl.href : window.location.href;

    return {
      title: document.title || getMeta('meta[property="og:title"]') || '',
      url: window.location.href,
      canonical,
      description: getMeta('meta[name="description"]') || getMeta('meta[property="og:description"]'),
      siteName: getMeta('meta[property="og:site_name"]') || window.location.hostname,
      author: getMeta('meta[name="author"]') || getMeta('meta[property="article:author"]'),
      language: document.documentElement.lang || 'en',
    };
  }

  /**
   * Extract Schema.org JSON-LD structured data (Product, Article, Organization, Recipe, etc.)
   * Especially valuable for e-commerce pages (Price, Currency, Stock, Rating, Specs).
   */
  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const items = [];

    scripts.forEach((script) => {
      try {
        const raw = script.textContent.trim();
        if (!raw) return;
        const parsed = JSON.parse(raw);

        // Normalize single object or array
        const objects = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);

        objects.forEach((obj) => {
          if (!obj || typeof obj !== 'object') return;
          const type = obj['@type'] || '';

          // E-commerce Product
          if (type.includes('Product')) {
            const offer = Array.isArray(obj.offers) ? obj.offers[0] : (obj.offers || {});
            const rating = obj.aggregateRating || {};
            items.push({
              type: 'Product',
              name: obj.name || '',
              description: obj.description || '',
              brand: obj.brand?.name || obj.brand || '',
              sku: obj.sku || obj.productID || '',
              price: offer.price || offer.lowPrice || '',
              priceCurrency: offer.priceCurrency || '',
              availability: offer.availability || '',
              ratingValue: rating.ratingValue || '',
              reviewCount: rating.reviewCount || rating.ratingCount || '',
            });
          }
          // Article / NewsArticle / BlogPosting
          else if (type.includes('Article') || type.includes('BlogPosting')) {
            items.push({
              type: 'Article',
              headline: obj.headline || obj.name || '',
              author: obj.author?.name || obj.author || '',
              datePublished: obj.datePublished || '',
              description: obj.description || '',
            });
          }
          // FAQPage
          else if (type === 'FAQPage' && Array.isArray(obj.mainEntity)) {
            const faqs = obj.mainEntity.slice(0, 10).map((qa) => ({
              q: qa.name || '',
              a: qa.acceptedAnswer?.text || '',
            }));
            items.push({ type: 'FAQ', items: faqs });
          }
        });
      } catch {
        // Skip invalid JSON-LD silently
      }
    });

    return items;
  }

  /**
   * Attempt primary extraction using Mozilla Readability
   */
  function tryReadability() {
    try {
      const ReadabilityClass = window.Readability || globalThis.Readability;
      if (typeof ReadabilityClass !== 'function') {
        return { success: false, reason: 'Readability library not available' };
      }

      // Clone document to prevent modifying live page
      const docClone = document.cloneNode(true);
      const reader = new ReadabilityClass(docClone, {
        charThreshold: 200,
        classesToPreserve: ['code', 'pre', 'table'],
      });

      const article = reader.parse();

      // Validate extraction quality
      if (!article || !article.textContent) {
        return { success: false, reason: 'Readability returned empty article' };
      }

      const text = article.textContent.replace(/\s+/g, ' ').trim();

      // If text is suspiciously short for an article (< 250 characters), treat as non-article page
      if (text.length < 250) {
        return { success: false, reason: 'Extracted text below article threshold (<250 chars)', length: text.length };
      }

      return {
        success: true,
        strategy: 'readability',
        title: article.title || document.title,
        byline: article.byline || '',
        siteName: article.siteName || '',
        excerpt: article.excerpt || '',
        content: formatCleanText(article.textContent),
        length: text.length,
      };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  /**
   * Converts HTML <table> element into readable Markdown Table format
   */
  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';

    const matrix = rows.map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) =>
        (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
      )
    ).filter(r => r.length > 0 && r.some(cell => cell.length > 0));

    if (!matrix.length) return '';

    const numCols = Math.max(...matrix.map((r) => r.length));
    if (numCols === 0) return '';

    const lines = [];
    // Header row (first row or ths)
    const headerRow = matrix[0];
    while (headerRow.length < numCols) headerRow.push('');
    lines.push(`| ${headerRow.join(' | ')} |`);
    lines.push(`| ${new Array(numCols).fill('---').join(' | ')} |`);

    // Data rows
    for (let i = 1; i < matrix.length; i++) {
      const row = matrix[i];
      while (row.length < numCols) row.push('');
      lines.push(`| ${row.join(' | ')} |`);
    }

    return `\n\n${lines.join('\n')}\n\n`;
  }

  /**
   * Fallback Structured Extractor:
   * Specially crafted for Non-Article Pages (Dashboards, E-commerce, Portals, Search Results, Web Apps).
   * Prunes unwanted UI chrome while preserving:
   * - Tables (converted to Markdown)
   * - Key-value definitions (<dl>, spec sheets)
   * - Headings hierarchy
   * - Interactive metrics / cards
   * - Product prices, labels, and stock info
   */
  function extractFallback() {
    const root = document.body || document.documentElement;
    if (!root) {
      return {
        strategy: 'fallback-empty',
        content: document.title || 'No readable content found on page.',
        length: (document.title || '').length,
      };
    }
    const clone = root.cloneNode(true);

    // 1. Remove non-content elements and boilerplate
    const junkSelectors = [
      'script',
      'style',
      'noscript',
      'svg',
      'canvas',
      'iframe',
      'template',
      // Navigations & menus
      'nav',
      'header',
      '[role="navigation"]',
      '.navbar',
      '#navbar',
      '.site-header',
      '.menu-container',
      // Footers
      'footer',
      '[role="contentinfo"]',
      '.site-footer',
      '#footer',
      // Ads, banners, trackers
      '[aria-hidden="true"]',
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[id*="consent" i]',
      '[class*="consent" i]',
      '[class*="advertisement" i]',
      '[class*="ad-container" i]',
      '.ad-banner',
      '#banner',
      // Popups & modals
      '.modal',
      '.dialog',
      '.toast',
    ];

    clone.querySelectorAll(junkSelectors.join(', ')).forEach((el) => {
      try {
        el.remove();
      } catch {}
    });

    // 2. Process and replace <table> elements with Markdown representations
    const tables = clone.querySelectorAll('table');
    tables.forEach((table) => {
      const md = tableToMarkdown(table);
      if (md) {
        const placeholder = document.createElement('div');
        placeholder.textContent = md;
        table.parentNode?.replaceChild(placeholder, table);
      }
    });

    // 3. Process definition lists (<dl>, <dt>, <dd>) for spec sheets & dashboards
    clone.querySelectorAll('dl').forEach((dl) => {
      const items = [];
      const dts = dl.querySelectorAll('dt');
      dts.forEach((dt) => {
        const dd = dt.nextElementSibling && dt.nextElementSibling.tagName === 'DD' ? dt.nextElementSibling : null;
        if (dd) {
          const key = (dt.innerText || dt.textContent || '').trim();
          const val = (dd.innerText || dd.textContent || '').trim();
          if (key && val) items.push(`${key}: ${val}`);
        }
      });
      if (items.length) {
        const div = document.createElement('div');
        div.textContent = `\n${items.join('\n')}\n`;
        dl.parentNode?.replaceChild(div, dl);
      }
    });

    // 4. Highlight price & e-commerce indicators
    clone.querySelectorAll('[itemprop="price"], [class*="price" i], [id*="price" i]').forEach((el) => {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt && !txt.startsWith('Price:')) {
        el.textContent = ` [Price: ${txt}] `;
      }
    });

    // 5. Build structured text representation
    const rawText = clone.innerText || clone.textContent || '';
    const cleanedText = formatCleanText(rawText);

    return {
      strategy: 'fallback-structured',
      content: cleanedText,
      length: cleanedText.length,
    };
  }

  /**
   * Cleans and normalizes text layout
   */
  function formatCleanText(raw) {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Detects if the current page is an e-commerce, dashboard, or application page
   * that requires structured fallback extraction rather than standard article parsing.
   */
  function isNonArticlePage(jsonLd) {
    // 1. Definite E-commerce indicator: Schema.org Product
    if (jsonLd && jsonLd.some((item) => item.type === 'Product')) {
      return true;
    }

    // 2. Strong E-commerce DOM indicators (price tags + add to cart / buy now)
    const hasCartOrCheckout = !!document.querySelector(
      '[class*="add-to-cart" i], [id*="add-to-cart" i], [class*="buy-now" i], [id*="buy-now" i], form[action*="cart" i], [class*="product-wrapper" i]'
    );
    const hasPriceElement = !!document.querySelector('[itemprop="price"], [class*="price" i], [id*="price" i]');
    if (hasCartOrCheckout && hasPriceElement) {
      return true;
    }

    // 3. Tabular / Dashboard indicator:
    // Presence of data tables combined with low narrative paragraph density
    const tables = document.querySelectorAll('table');
    const substantialParagraphs = Array.from(document.querySelectorAll('article p, main p, body p')).filter(
      (p) => (p.innerText || p.textContent || '').trim().length > 80
    );
    if (tables.length > 0 && substantialParagraphs.length < 3) {
      return true;
    }

    return false;
  }

  /**
   * Normalize URL to prevent redundant IDs for identical pages with different hash fragments
   */
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = ''; // Strip anchor hash
      return u.toString();
    } catch {
      return (url || '').split('#')[0];
    }
  }

  /**
   * Standard RFC 4122 Version 4 UUID generator
   */
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

  /**
   * Get or generate a persistent UUIDv4 for a given webpage URL.
   * If URL was already visited/fetched, returns the existing unique ID.
   * If URL is new, generates a new UUIDv4 and persists it to chrome.storage.local.
   */
  async function getOrGenerateUniqueId(rawUrl) {
    const url = normalizeUrl(rawUrl || window.location.href);

    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        // Fallback for environments where storage API might be unavailable
        resolve(generateUUIDv4());
        return;
      }

      chrome.storage.local.get(['page_url_unique_ids'], (res) => {
        const idMap = res.page_url_unique_ids || {};
        if (idMap[url]) {
          resolve(idMap[url]);
        } else {
          const newId = generateUUIDv4();
          idMap[url] = newId;
          chrome.storage.local.set({ page_url_unique_ids: idMap }, () => {
            resolve(newId);
          });
        }
      });
    });
  }

  /**
   * Main orchestrator for page data extraction
   */
  async function extractPageData() {
    const startTime = performance.now();
    const metadata = extractMetadata();
    const jsonLd = extractJsonLd();
    const selectedText = window.getSelection() ? window.getSelection().toString().trim() : '';

    // Retrieve or generate persistent UUIDv4 for this URL
    const unqId = await getOrGenerateUniqueId(metadata.url || window.location.href);

    let result = null;

    // Check if page is an e-commerce, dashboard, or tabular application page
    const preferStructuredFallback = isNonArticlePage(jsonLd);

    if (!preferStructuredFallback) {
      // Step 1: Try Mozilla Readability (Article Gold Standard)
      const readabilityResult = tryReadability();
      if (readabilityResult.success) {
        result = {
          strategy: 'readability',
          strategyLabel: 'Mozilla Readability (Article Mode)',
          title: readabilityResult.title || metadata.title,
          byline: readabilityResult.byline || metadata.author,
          siteName: readabilityResult.siteName || metadata.siteName,
          excerpt: readabilityResult.excerpt || metadata.description,
          content: readabilityResult.content,
        };
      }
    }

    // Step 2: If not an article or if Readability failed/yielded, use Fallback Extractor
    if (!result) {
      const fallbackResult = extractFallback();
      result = {
        strategy: 'fallback-structured',
        strategyLabel: preferStructuredFallback
          ? 'Structured Extractor (Dashboard / E-Commerce Mode)'
          : 'Structured Extractor (Fallback Mode)',
        title: metadata.title,
        byline: metadata.author,
        siteName: metadata.siteName,
        excerpt: metadata.description,
        content: fallbackResult.content,
        readabilityNote: preferStructuredFallback
          ? 'Detected e-commerce/dashboard layout; prioritized structured schema and tables.'
          : 'Mozilla Readability skipped (insufficient article paragraphs).',
      };
    }


    // Detect if page is a PDF document or arXiv paper
    const currentUrl = window.location.href;
    const isPdfDoc = (
      currentUrl.toLowerCase().endsWith('.pdf') ||
      currentUrl.includes('arxiv.org/pdf/') ||
      currentUrl.includes('arxiv.org/abs/') ||
      document.contentType === 'application/pdf' ||
      !!document.querySelector('embed[type="application/pdf"]')
    );

    // Attach metadata, JSON-LD, selection and stats
    const charCount = result.content.length;
    const wordCount = result.content.split(/\s+/).filter(Boolean).length;
    // Standard rule of thumb: ~4 characters or 0.75 words per token
    const estimatedTokens = Math.ceil(charCount / 4);

    const extractionTimeMs = Math.round(performance.now() - startTime);

    return {
      success: true,
      unq_id: unqId,
      unique_id: unqId,
      metadata,
      jsonLd,
      selectedText,
      strategy: result.strategy,
      strategyLabel: result.strategyLabel,
      title: result.title,
      byline: result.byline,
      siteName: result.siteName,
      excerpt: result.excerpt,
      content: result.content,
      readabilityNote: result.readabilityNote || null,
      isPdfDoc,
      stats: {
        charCount,
        wordCount,
        estimatedTokens,
        extractionTimeMs,
        hasSelection: !!selectedText,
        jsonLdCount: jsonLd.length,
        isPdfDoc,
      },
    };
  }

  /**
   * Interactive Screen Snipping Tool Overlay
   */
  function launchSnippingTool(callback) {
    // Remove any existing overlay
    const existing = document.getElementById('pageintel-snip-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pageintel-snip-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 2147483647;
      cursor: crosshair;
      user-select: none;
      background: rgba(11, 15, 25, 0.45);
      backdrop-filter: blur(1px);
    `;

    // Banner instructions
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: absolute;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #111827;
      color: #f9fafb;
      padding: 8px 18px;
      border-radius: 20px;
      border: 1px solid rgba(99, 102, 241, 0.4);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 12px;
      pointer-events: auto;
    `;
    banner.innerHTML = `
      <span>✂️ <strong>Drag to select region for OCR</strong> (Formula, table, figure, or text)</span>
      <span style="color: #9ca3af; font-size: 11px;">[Esc to cancel]</span>
    `;
    overlay.appendChild(banner);

    // Selection box
    const box = document.createElement('div');
    box.style.cssText = `
      position: absolute;
      border: 2px dashed #6366f1;
      background: rgba(99, 102, 241, 0.12);
      display: none;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
      pointer-events: none;
    `;
    overlay.appendChild(box);

    // Dimension badge
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: absolute;
      bottom: -26px;
      right: 0;
      background: #4f46e5;
      color: white;
      font-size: 11px;
      font-family: monospace;
      padding: 2px 6px;
      border-radius: 4px;
      display: none;
    `;
    box.appendChild(badge);

    // Action button toolbar
    const actionToolbar = document.createElement('div');
    actionToolbar.style.cssText = `
      position: absolute;
      bottom: -46px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      gap: 6px;
      pointer-events: auto;
      background: #1f2937;
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    `;
    actionToolbar.innerHTML = `
      <button id="pageintel-confirm-snip" style="background:#6366f1; color:white; border:none; padding:4px 10px; border-radius:4px; font-size:12px; font-weight:600; cursor:pointer;">⚡ OCR Area</button>
      <button id="pageintel-cancel-snip" style="background:transparent; color:#9ca3af; border:1px solid #374151; padding:4px 8px; border-radius:4px; font-size:12px; cursor:pointer;">Cancel</button>
    `;
    box.appendChild(actionToolbar);

    let isDown = false;
    let startX = 0, startY = 0;
    let endX = 0, endY = 0;

    function cleanup() {
      overlay.remove();
      window.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        cleanup();
        if (callback) callback(null);
      }
    }

    overlay.addEventListener('mousedown', (e) => {
      if (e.target.closest('#pageintel-confirm-snip') || e.target.closest('#pageintel-cancel-snip')) return;
      isDown = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = 'block';
      badge.style.display = 'block';
      actionToolbar.style.display = 'none';
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = '0px';
      box.style.height = '0px';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      endX = e.clientX;
      endY = e.clientY;

      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      badge.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
    });

    overlay.addEventListener('mouseup', () => {
      if (!isDown) return;
      isDown = false;
      const width = parseInt(box.style.width, 10);
      const height = parseInt(box.style.height, 10);
      if (width > 20 && height > 20) {
        actionToolbar.style.display = 'flex';
      }
    });

    actionToolbar.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.id === 'pageintel-confirm-snip') {
        const rect = box.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cropData = {
          x: Math.round(rect.left * dpr),
          y: Math.round(rect.top * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
          viewportWidth: Math.round(window.innerWidth * dpr),
          viewportHeight: Math.round(window.innerHeight * dpr),
        };
        cleanup();
        if (callback) callback(cropData);
      } else if (e.target.id === 'pageintel-cancel-snip') {
        cleanup();
        if (callback) callback(null);
      }
    });

    window.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
  }

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'EXTRACT_PAGE_DATA' || request.action === 'FETCH_PAGE_DATA') {
      extractPageData()
        .then((data) => {
          sendResponse({
            success: true,
            unq_id: data.unq_id,
            unique_id: data.unique_id,
            data: data,
          });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep message channel open for async response
    }

    if (request.action === 'START_SNIPPING') {
      launchSnippingTool((cropData) => {
        if (cropData) {
          chrome.runtime.sendMessage({
            action: 'SNIP_AREA_SELECTED',
            crop: cropData,
            url: window.location.href,
            title: document.title,
          });
        }
      });
      sendResponse({ success: true, message: 'Snipping tool active' });
      return true;
    }

    if (request.action === 'GET_PAGE_UNIQUE_ID') {
      getOrGenerateUniqueId(request.url || window.location.href)
        .then((unq_id) => {
          sendResponse({ success: true, unq_id, unique_id: unq_id });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    if (request.action === 'GET_SELECTION') {
      const selection = window.getSelection() ? window.getSelection().toString().trim() : '';
      sendResponse({ success: true, selection });
      return true;
    }

    if (request.action === 'PING') {
      sendResponse({ success: true, message: 'PONG' });
      return true;
    }
  });

  console.log('[PageIntel AI] Content script & extraction engine loaded.');
})();
