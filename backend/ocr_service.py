"""
OCR Service for Scientific Papers & Webpage Screenshots
Uses Tesseract OCR 5.3 + PIL image enhancement + Groq LLM post-processing
for high-accuracy text, LaTeX formula, and table extraction.
"""

import os
import io
import re
import base64
from typing import Dict, Any, Optional
from PIL import Image, ImageEnhance, ImageFilter
import pytesseract
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage


def preprocess_image(image: Image.Image, crop: Optional[Dict[str, Any]] = None) -> Image.Image:
    """Preprocesses the input PIL image for optimal OCR recognition."""
    img = image.convert("RGB")

    # Safe cropping if bounding box provided
    if crop:
        try:
            x = max(0, int(crop.get("x", 0)))
            y = max(0, int(crop.get("y", 0)))
            w = int(crop.get("width", 0))
            h = int(crop.get("height", 0))
            
            # Check valid bounds
            img_w, img_h = img.size
            if w > 5 and h > 5 and x < img_w and y < img_h:
                right = min(img_w, x + w)
                bottom = min(img_h, y + h)
                img = img.crop((x, y, right, bottom))
        except Exception as crop_err:
            print(f"[OCR] Crop failed, using full image: {crop_err}")

    # Convert to grayscale
    gray = img.convert("L")

    # Upscale small images to improve Tesseract character recognition
    w, h = gray.size
    if w < 800 or h < 600:
        scale = max(2, int(1200 / max(w, 1)))
        if scale > 1:
            gray = gray.resize((w * scale, h * scale), Image.Resampling.LANCZOS)

    # Enhance contrast
    enhancer = ImageEnhance.Contrast(gray)
    enhanced = enhancer.enhance(1.8)

    # Slight sharpness enhancement
    enhanced = enhanced.filter(ImageFilter.SHARPEN)

    return enhanced


def run_tesseract_ocr(img: Image.Image) -> str:
    """Runs Tesseract with multi-strategy page segmentation."""
    # Strategy 1: Automatic page segmentation (best for multi-column papers)
    try:
        text = pytesseract.image_to_string(img, config="--psm 3 -l eng")
        if text and len(text.strip()) > 30:
            return text.strip()
    except Exception as e:
        print(f"[OCR] Tesseract PSM 3 warning: {e}")

    # Strategy 2: Single uniform block (best for cropped paragraphs/tables/formulas)
    try:
        text_block = pytesseract.image_to_string(img, config="--psm 6 -l eng")
        if text_block and len(text_block.strip()) > 10:
            return text_block.strip()
    except Exception as e:
        print(f"[OCR] Tesseract PSM 6 warning: {e}")

    # Strategy 3: Sparse text with OSD
    try:
        text_sparse = pytesseract.image_to_string(img, config="--psm 11 -l eng")
        return text_sparse.strip()
    except Exception as e:
        print(f"[OCR] Tesseract PSM 11 warning: {e}")
        return ""


async def enhance_ocr_with_llm(
    raw_ocr_text: str,
    groq_api_key: Optional[str] = None,
    groq_model: Optional[str] = None,
) -> str:
    """Cleans up OCR noise, converts math symbols into clean LaTeX, and formats tables using Groq."""
    key = groq_api_key or os.getenv("GROQ_API_KEY")
    if not key or not raw_ocr_text or len(raw_ocr_text.strip()) < 15:
        return raw_ocr_text

    model_name = groq_model or os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

    system_prompt = (
        "You are an expert scientific document OCR assistant and post-processor. "
        "Your task is to transform raw OCR text captured from an academic paper, figure, or webpage into pristine, highly structured Markdown.\n"
        "Guidelines:\n"
        "1. Fix obvious OCR typos, broken words, or misplaced punctuation.\n"
        "2. Convert mathematical equations and formulas into standard LaTeX ($inline$ and $$display$$).\n"
        "3. Format structured numerical data or tabular comparisons into clean Markdown tables.\n"
        "4. Preserve all original headings, citations, numbers, dates, and theorem statements faithfully.\n"
        "5. Output ONLY the cleaned-up Markdown content with no conversational chit-chat or preamble."
    )

    user_prompt = f"Please clean up, format LaTeX math, and structure this raw OCR paper text:\n\n```\n{raw_ocr_text}\n```"

    try:
        llm = ChatGroq(model=model_name, api_key=key, temperature=0.1)
        response = await llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
        cleaned = response.content.strip()
        return cleaned if cleaned else raw_ocr_text
    except Exception as err:
        print(f"[OCR] LLM enhancement fallback to raw text: {err}")
        return raw_ocr_text


async def process_ocr_request(
    image_base64: str,
    crop: Optional[Dict[str, Any]] = None,
    enhance_with_llm: bool = True,
    groq_api_key: Optional[str] = None,
    groq_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Decodes base64 screenshot, preprocesses, executes OCR, and optionally cleans with LLM.
    
    Returns:
        dict: {
            "success": bool,
            "clean_text": str,
            "raw_text": str,
            "char_count": int,
            "word_count": int,
            "enhanced": bool,
            "error": Optional[str]
        }
    """
    try:
        # Strip data URL header if present (e.g. data:image/png;base64,...)
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_base64)
        original_img = Image.open(io.BytesIO(image_bytes))

        # Preprocess and crop
        processed_img = preprocess_image(original_img, crop=crop)

        # Run Tesseract OCR
        raw_text = run_tesseract_ocr(processed_img)

        if not raw_text or not raw_text.strip():
            return {
                "success": False,
                "clean_text": "",
                "raw_text": "",
                "char_count": 0,
                "word_count": 0,
                "enhanced": False,
                "error": "No text detected in screenshot. Ensure the text or paper page is clearly visible.",
            }

        # Enhance with LLM
        clean_text = raw_text
        enhanced = False
        if enhance_with_llm:
            try:
                clean_text = await enhance_ocr_with_llm(
                    raw_text, groq_api_key=groq_api_key, groq_model=groq_model
                )
                enhanced = bool(clean_text and clean_text != raw_text)
            except Exception as e:
                print(f"[OCR] Enhancement skipped: {e}")

        words = clean_text.split()
        return {
            "success": True,
            "clean_text": clean_text,
            "raw_text": raw_text,
            "char_count": len(clean_text),
            "word_count": len(words),
            "enhanced": enhanced,
            "error": None,
        }

    except Exception as e:
        return {
            "success": False,
            "clean_text": "",
            "raw_text": "",
            "char_count": 0,
            "word_count": 0,
            "enhanced": False,
            "error": f"OCR processing failed: {str(e)}",
        }
