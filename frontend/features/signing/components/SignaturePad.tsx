'use client';

// Real signature capture — draw with mouse/touch, type a name rendered in a
// cursive font, or upload/drag-and-drop a signature image. Either way the
// result is a data:image/png;base64 string, which is exactly what the PAdES
// flattening step already accepts as a field value
// (backend/src/modules/esigning/esignPades.ts) — replacing what used to be a
// plain typed-name string submitted as the "signature".

import { useEffect, useRef, useState } from 'react';
import { Eraser, ImageUp, PenLine, Type } from 'lucide-react';

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 160;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — generous for a signature image

function textToDataUrl(text: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  ctx.font = `52px "Brush Script MT", "Segoe Script", cursive`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL('image/png');
}

// Re-encodes any browser-decodable image (webp, gif, bmp, or already-fine
// png/jpeg) into a PNG normalized to the pad's canvas footprint — the backend
// flattening step (esignPades.ts) only knows how to embed image/png or
// image/jpeg, so a raw pass-through of e.g. a webp screenshot would silently
// fail to render on the signed PDF (falls back to a "[signed]" text stamp).
// Alpha is preserved (no background fill), so a signature exported with a
// transparent background composites cleanly onto the document page.
function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file'));
    };
    img.src = objectUrl;
  });
}

export function SignaturePad({
  defaultTypedName,
  defaultSignatureImage,
  onChange,
}: {
  defaultTypedName?: string;
  /** The signer's saved profile signature (users.signatureImage, a
   *  data:image/png;base64 string), if they have one — pre-fills the pad
   *  with it via the existing "upload" mode's preview/replace UI, so a
   *  signer who already uploaded a signature once in Settings never has to
   *  draw/type/upload it again for every single signing ceremony. Still
   *  fully replaceable: switching mode, uploading a new file, or drawing
   *  overrides it exactly like it would override any other starting value.
   *  Read once at mount (deliberately not re-applied if this prop changes
   *  later — a mid-session profile signature edit should never overwrite
   *  what the signer is actively drawing/typing right now). */
  defaultSignatureImage?: string | null;
  onChange: (dataUrl: string | null) => void;
}) {
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>(defaultSignatureImage ? 'upload' : 'draw');
  const [typedName, setTypedName] = useState(defaultTypedName ?? '');
  const [hasDrawing, setHasDrawing] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(defaultSignatureImage ?? null);
  // Only true for the untouched saved signature — cleared the moment the
  // signer actually replaces it (a fresh upload, or switching away and
  // back), so the "this is your saved signature" caption never lingers on
  // an image that isn't it anymore.
  const [isSavedSignature, setIsSavedSignature] = useState(Boolean(defaultSignatureImage));
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const getCanvasCtx = () => canvasRef.current?.getContext('2d') ?? null;

  useEffect(() => {
    const ctx = getCanvasCtx();
    if (!ctx || !canvasRef.current) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  // Re-emit whenever the typed name changes in "type" mode.
  useEffect(() => {
    if (mode !== 'type') return;
    onChange(typedName.trim() ? textToDataUrl(typedName.trim()) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, typedName]);

  // Re-emit whatever was already uploaded when switching back to "upload"
  // mode — mirrors the "type" effect above (each mode owns re-emitting its
  // own value on mode switch; file processing itself emits directly, below).
  useEffect(() => {
    if (mode !== 'upload') return;
    onChange(uploadPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    setUploadError(null);
    if (!file.type.startsWith('image/')) {
      setUploadError('That file isn\'t an image.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('Image is too large (max 5MB).');
      return;
    }
    try {
      const dataUrl = await imageFileToDataUrl(file);
      setUploadPreview(dataUrl);
      setIsSavedSignature(false);
      onChange(dataUrl);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Could not read that image file');
    }
  };

  const removeUpload = () => {
    setUploadPreview(null);
    setIsSavedSignature(false);
    setUploadError(null);
    onChange(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    void handleFile(e.dataTransfer.files?.[0]);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const onDragLeave = () => setIsDragOver(false);

  const pointFromEvent = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = 'touches' in e ? e.touches[0] : (e as React.MouseEvent);
    if (!point) return null;
    return {
      x: ((point.clientX - rect.left) / rect.width) * canvas.width,
      y: ((point.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    drawingRef.current = true;
    lastPointRef.current = pointFromEvent(e);
  };
  const moveDraw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingRef.current) return;
    const ctx = getCanvasCtx();
    const point = pointFromEvent(e);
    if (!ctx || !point || !lastPointRef.current) return;
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    if (!hasDrawing) setHasDrawing(true);
  };
  const endDraw = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (canvasRef.current) onChange(hasDrawing ? canvasRef.current.toDataURL('image/png') : null);
  };

  const clear = () => {
    const ctx = getCanvasCtx();
    if (!ctx || !canvasRef.current) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setHasDrawing(false);
    onChange(null);
  };

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <button
          type="button"
          onClick={() => setMode('draw')}
          className={`ui-btn !py-1 !px-2.5 text-xs ${mode === 'draw' ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
        >
          <PenLine className="h-3.5 w-3.5" /> Draw
        </button>
        <button
          type="button"
          onClick={() => setMode('type')}
          className={`ui-btn !py-1 !px-2.5 text-xs ${mode === 'type' ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
        >
          <Type className="h-3.5 w-3.5" /> Type
        </button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={`ui-btn !py-1 !px-2.5 text-xs ${mode === 'upload' ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
        >
          <ImageUp className="h-3.5 w-3.5" /> Upload
        </button>
        {mode === 'draw' && (
          <button type="button" onClick={clear} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-xs ml-auto">
            <Eraser className="h-3.5 w-3.5" /> Clear
          </button>
        )}
        {mode === 'upload' && uploadPreview && (
          <button type="button" onClick={removeUpload} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-xs ml-auto">
            <Eraser className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {mode === 'draw' ? (
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="rounded-md border w-full touch-none cursor-crosshair"
          style={{ borderColor: 'var(--border)', maxWidth: CANVAS_WIDTH }}
          onMouseDown={startDraw}
          onMouseMove={moveDraw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={moveDraw}
          onTouchEnd={endDraw}
        />
      ) : mode === 'type' ? (
        <input
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          placeholder="Type your full name"
          className="ui-input w-full"
          style={{ fontFamily: '"Brush Script MT", "Segoe Script", cursive', fontSize: 28 }}
        />
      ) : (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            className="rounded-md border w-full flex items-center justify-center cursor-pointer overflow-hidden"
            style={{
              borderColor: isDragOver ? 'var(--brand-500)' : 'var(--border)',
              borderStyle: uploadPreview ? 'solid' : 'dashed',
              background: isDragOver ? 'var(--brand-50)' : 'var(--surface-raised)',
              maxWidth: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
            }}
          >
            {uploadPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={uploadPreview} alt="Uploaded signature" className="max-h-full max-w-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-1 px-3 text-center" style={{ color: 'var(--text-muted)' }}>
                <ImageUp className="h-6 w-6" />
                <span className="text-xs">Drag & drop a signature image, or click to browse</span>
                <span className="text-[10px]">PNG or JPEG with a transparent background works best</span>
              </div>
            )}
          </div>
          {uploadError && (
            <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{uploadError}</p>
          )}
          {isSavedSignature && uploadPreview && !uploadError && (
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              This is the signature saved on your profile (Settings → Profile &amp; Signature). Click above to replace it for this signature only, or switch to Draw/Type instead.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
