from transformers import Blip2Processor, Blip2ForConditionalGeneration
from PIL import Image
import sys
import torch
import re
import gc
import json

device = "cuda" if torch.cuda.is_available() else "cpu"

processor = Blip2Processor.from_pretrained("Salesforce/blip2-opt-2.7b")
model = Blip2ForConditionalGeneration.from_pretrained(
    "Salesforce/blip2-opt-2.7b",
    load_in_8bit=True if device == "cuda" else False,
    torch_dtype=torch.float16 if device == "cuda" else torch.float32
)
model = model.to(device)

warmup_image = Image.new("RGB", (224, 224), color="white")
inputs = processor(warmup_image, return_tensors="pt").to(device, torch.float16)
model.generate(**inputs)

def clean_caption(caption):
    """Consistent caption cleaning for both single and batch processing"""
    caption = re.sub(
        r'\b(a picture|an image|a photo|a photograph) of\b', 
        '', 
        caption, 
        flags=re.IGNORECASE
    ).strip()
    return caption.capitalize()

def process_image(path):
    """Process individual image with strict error handling"""
    try:
        image = Image.open(path).convert("RGB")
        
        inputs = processor(image, return_tensors="pt").to(device, torch.float16)
        outputs = model.generate(
            **inputs,
            max_new_tokens=60,
            temperature=0.7,
            repetition_penalty=1.2
        )
        
        caption = processor.decode(outputs[0], skip_special_tokens=True)
        cleaned_caption = clean_caption(caption)
        
        if not cleaned_caption.strip():
            raise ValueError("Empty caption generated")
            
        return cleaned_caption
        
    except Exception as e:
        print(f"Error processing {path}: {str(e)}", file=sys.stderr)
        return None
    finally:
        if 'image' in locals(): del image
        if 'inputs' in locals(): del inputs
        if 'outputs' in locals(): del outputs
        if device == "cuda":
            torch.cuda.empty_cache()
        gc.collect()

def generate_batch_captions(image_paths):
    """Process multiple images and return only 100% successful results"""
    results = []
    for path in image_paths:
        caption = process_image(path)
        if caption is not None:
            results.append({
                "path": path,
                "caption": caption
            })
    return results

if __name__ == "__main__":
    try:
        if len(sys.argv) > 2:
            results = generate_batch_captions(sys.argv[1:])
            print(json.dumps(results))
        else:
            caption = process_image(sys.argv[1])
            if caption:
                print(caption)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)