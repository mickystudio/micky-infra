/**
 * canvas.tsx — HTML5 Canvas editor for Micky Canvas
 * -------------------------------------------------
 * Renders layers onto a <canvas>, supports drag / resize / rotate via
 * Pointer Events (unified mouse + touch), and exposes a `renderLayers`
 * helper used for full-resolution PNG/JPG export.
 *
 * Coordinate system: every layer stores x/y/w/h in WORLD coordinates
 * (e.g. 0..1080). The canvas's internal pixel size equals the world size;
 * its CSS size is scaled down to fit the viewport.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layer } from './templates';
import { getIcon } from './icons';

// Re-export Layer so consumers can import it from canvas.tsx (per spec)
export type { Layer } from './templates';

// ---------------------------------------------------------------------------
// Image cache — keep loaded HTMLImageElement around so redraws are cheap
// ---------------------------------------------------------------------------
const imageCache = new Map<string, HTMLImageElement>();
const loadingPromises = new Map<string, Promise<HTMLImageElement>>();

/** Load an image URL (or data: URI) and cache it. Cross-origin safe. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return Promise.resolve(cached);
  }
  const inflight = loadingPromises.get(url);
  if (inflight) return inflight;

  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      imageCache.set(url, img);
      loadingPromises.delete(url);
      resolve(img);
    };
    img.onerror = () => {
      loadingPromises.delete(url);
      reject(new Error(`Failed to load image: ${url.slice(0, 64)}`));
    };
    img.src = url;
    loadingPromises.set(url, p);
  });
  return p;
}

/** Preload every image referenced by a set of layers. Returns when all done. */
export async function preloadImages(layers: Layer[]): Promise<void> {
  const urls = layers
    .filter((l) => l.type === 'image' && l.content.trim() !== '')
    .map((l) => l.content);
  await Promise.allSettled(urls.map(loadImage));
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function deg2rad(d: number): number { return (d * Math.PI) / 180; }

/** Rotate point `p` around `c` by `deg` degrees. */
function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const r = deg2rad(deg);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** Convert a screen point into a layer's local (unrotated) coordinate. */
function worldToLocal(layer: Layer, wx: number, wy: number): { x: number; y: number } {
  const cx = layer.x + layer.width / 2;
  const cy = layer.y + layer.height / 2;
  const p = rotatePoint(wx, wy, cx, cy, -layer.rotation);
  return { x: p.x - layer.x, y: p.y - layer.y };
}

/** Hit-test a layer (handles rotation by inverse-rotating the point). */
function hitTestLayer(layer: Layer, wx: number, wy: number): boolean {
  const local = worldToLocal(layer, wx, wy);
  if (layer.type === 'shape' && layer.content === 'circle') {
    const r = layer.width / 2;
    const dx = local.x - r;
    const dy = local.y - r;
    return dx * dx + dy * dy <= r * r;
  }
  return local.x >= 0 && local.x <= layer.width && local.y >= 0 && local.y <= layer.height;
}

/** Find the topmost layer under a world point. */
function pickLayer(layers: Layer[], wx: number, wy: number): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    if (hitTestLayer(l, wx, wy)) return l;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer rendering
// ---------------------------------------------------------------------------

/** Round rect helper (works on all modern browsers). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Wrap a long string into lines that fit `maxWidth` using the current font. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    if (words.length === 0) { lines.push(''); continue; }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = current + ' ' + words[i];
      if (ctx.measureText(test).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = words[i];
      } else {
        current = test;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Draw a single layer onto the given context. */
export function renderLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  images: Map<string, HTMLImageElement>,
): void {
  if (!layer.visible || layer.opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));

  // Rotate around the layer's center
  const cx = layer.x + layer.width / 2;
  const cy = layer.y + layer.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate(deg2rad(layer.rotation));
  ctx.translate(-layer.width / 2, -layer.height / 2);

  switch (layer.type) {
    case 'image': {
      const img = images.get(layer.content);
      if (img && img.complete && img.naturalWidth > 0) {
        // Cover-fit: scale image to fill the layer's box, cropping overflow
        const ar = img.naturalWidth / img.naturalHeight;
        const boxAr = layer.width / layer.height;
        let sw = img.naturalWidth;
        let sh = img.naturalHeight;
        let sx = 0;
        let sy = 0;
        if (ar > boxAr) {
          sw = img.naturalHeight * boxAr;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = img.naturalWidth / boxAr;
          sy = (img.naturalHeight - sh) / 2;
        }
        const r = layer.properties.borderRadius ?? 0;
        if (r > 0) {
          roundRect(ctx, 0, 0, layer.width, layer.height, r);
          ctx.clip();
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, layer.width, layer.height);
      } else {
        // Placeholder box for empty / still-loading images
        ctx.fillStyle = '#1e293b';
        roundRect(ctx, 0, 0, layer.width, layer.height, 8);
        ctx.fill();
        ctx.strokeStyle = '#475569';
        ctx.setLineDash([12, 8]);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '600 28px Cairo, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('اضغط لاستبدال الصورة', layer.width / 2, layer.height / 2);
      }
      break;
    }

    case 'shape': {
      const fill = layer.properties.backgroundColor ?? '#3b82f6';
      const radius = layer.properties.borderRadius ?? 0;
      const borderWidth = layer.properties.borderWidth ?? 0;
      const borderColor = layer.properties.borderColor ?? 'transparent';
      ctx.fillStyle = fill;
      if (layer.content === 'circle') {
        ctx.beginPath();
        ctx.ellipse(layer.width / 2, layer.height / 2, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        if (borderWidth > 0) {
          ctx.lineWidth = borderWidth;
          ctx.strokeStyle = borderColor;
          ctx.stroke();
        }
      } else if (layer.content === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(layer.width / 2, 0);
        ctx.lineTo(layer.width, layer.height);
        ctx.lineTo(0, layer.height);
        ctx.closePath();
        ctx.fill();
        if (borderWidth > 0) {
          ctx.lineWidth = borderWidth;
          ctx.strokeStyle = borderColor;
          ctx.stroke();
        }
      } else if (layer.content === 'line') {
        ctx.strokeStyle = fill;
        ctx.lineWidth = Math.max(2, layer.height);
        ctx.beginPath();
        ctx.moveTo(0, layer.height / 2);
        ctx.lineTo(layer.width, layer.height / 2);
        ctx.stroke();
      } else {
        // rect (default)
        if (radius > 0) {
          roundRect(ctx, 0, 0, layer.width, layer.height, radius);
          ctx.fill();
          if (borderWidth > 0) {
            ctx.lineWidth = borderWidth;
            ctx.strokeStyle = borderColor;
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = fill;
          ctx.fillRect(0, 0, layer.width, layer.height);
          if (borderWidth > 0) {
            ctx.lineWidth = borderWidth;
            ctx.strokeStyle = borderColor;
            ctx.strokeRect(0, 0, layer.width, layer.height);
          }
        }
      }
      break;
    }

    case 'icon': {
      const icon = getIcon(layer.content);
      const color = layer.properties.iconColor ?? layer.properties.color ?? `#${icon.hex}`;
      // Icons are drawn at (0,0) → (width, height). The drawIcon helper
      // takes centre + size; compute centre in the rotated local space.
      const size = Math.min(layer.width, layer.height);
      // Use the icons.ts helper via a Path2D fill (inline to avoid extra import)
      const scale = size / 24;
      ctx.save();
      ctx.translate(layer.width / 2 - size / 2, layer.height / 2 - size / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = color;
      for (const d of icon.paths) {
        const p = new Path2D(d);
        ctx.fill(p);
      }
      ctx.restore();
      break;
    }

    case 'text': {
      const p = layer.properties;
      const fontSize = p.fontSize ?? 32;
      const fontFamily = p.fontFamily ?? 'Cairo';
      const weight = p.fontWeight ?? 700;
      const color = p.color ?? '#ffffff';
      ctx.fillStyle = color;
      ctx.font = `${weight} ${fontSize}px ${fontFamily}, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.direction = p.direction ?? 'rtl';
      const align = p.align ?? (p.direction === 'rtl' ? 'right' : 'left');
      ctx.textAlign = align;

      const lines = wrapText(ctx, layer.content || '', layer.width);
      const lineHeight = fontSize * 1.35;
      // Vertical centering: start so the block sits in the middle of the box
      const totalH = lines.length * lineHeight;
      let startY = (layer.height - totalH) / 2;
      if (startY < 0) startY = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let x: number;
        if (align === 'center') x = layer.width / 2;
        else if (align === 'right') x = layer.width;
        else x = 0;
        // Support explicit text shadow for readability over images
        ctx.fillText(line, x, startY + i * lineHeight, layer.width);
      }
      break;
    }
  }

  ctx.restore();
}

/** Render all visible layers in z-order. Used both on screen and for export. */
export function renderLayers(
  ctx: CanvasRenderingContext2D,
  layers: Layer[],
  images: Map<string, HTMLImageElement>,
  clear = true,
): void {
  if (clear) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  for (const l of layers) renderLayer(ctx, l, images);
}

// ---------------------------------------------------------------------------
// Export to PNG / JPG
// ---------------------------------------------------------------------------

export type ExportFormat = 'png' | 'jpeg';

/** Render layers to a fresh offscreen canvas and return a Blob (PNG / JPEG). */
export async function layersToBlob(
  layers: Layer[],
  width: number,
  height: number,
  format: ExportFormat = 'png',
  background = '#ffffff',
): Promise<Blob> {
  // Ensure every image is loaded before drawing
  await preloadImages(layers);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  // Fill background (JPEGs don't support transparency)
  if (format === 'jpeg' || background !== 'transparent') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  // Scale to fit template dimensions → export dimensions (usually 1:1)
  const sx = width / Math.max(1, Math.max(...layers.map((l) => l.x + l.width)));
  const sy = height / Math.max(1, Math.max(...layers.map((l) => l.y + l.height)));
  // Use the template's native size to compute scale: we pass world dimensions
  // explicitly via the canvas size; layers are authored in the same world
  // space, so no scaling is needed when export dims == world dims. When they
  // differ we scale uniformly.
  const worldW = Math.max(...layers.map((l) => l.x + l.width));
  const worldH = Math.max(...layers.map((l) => l.y + l.height));
  const scaleX = width / (worldW || width);
  const scaleY = height / (worldH || height);
  void sx; void sy;

  if (scaleX !== 1 || scaleY !== 1) {
    ctx.scale(scaleX, scaleY);
  }

  renderLayers(ctx, layers, imageCache, false);

  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'jpeg' ? 0.92 : undefined;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas.toBlob returned null — possibly tainted by cross-origin image'));
      },
      mime,
      quality,
    );
  });
}

/** Trigger a download of a Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export interface CanvasEditorProps {
  layers: Layer[];
  width: number;       // world width (e.g. 1080)
  height: number;      // world height
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Live update (during drag) — should be cheap. */
  onUpdate: (id: string, patch: Partial<Layer>) => void;
  /** Fired at the end of a drag/resize/rotate gesture (for history). */
  onCommit: () => void;
  /** Background colour rendered behind everything (transparent by default). */
  background?: string;
}

type HandleKind = 'tl' | 'tr' | 'bl' | 'br' | 'rot';

interface DragState {
  layerId: string;
  mode: 'move' | 'resize' | 'rotate';
  handle?: HandleKind;
  startWorldX: number;
  startWorldY: number;
  startLayer: Layer;
}

const HANDLE_SIZE = 14; // CSS pixels

export const CanvasEditor: React.FC<CanvasEditorProps> = ({
  layers,
  width,
  height,
  selectedId,
  onSelect,
  onUpdate,
  onCommit,
  background = 'transparent',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [ready, setReady] = useState(false);

  // Compute display scale to fit the available container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cw = entry.contentRect.width;
      const ch = entry.contentRect.height;
      const sx = cw / width;
      const sy = ch / height;
      const s = Math.min(sx, sy);
      setDisplayScale(s > 0 ? s : 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  // Preload images whenever layers change
  useEffect(() => {
    let cancelled = false;
    const urls = layers
      .filter((l) => l.type === 'image' && l.content.trim() !== '')
      .map((l) => l.content);
    if (urls.length === 0) {
      setImages(new Map());
      setReady(true);
      return;
    }
    setReady(false);
    Promise.allSettled(urls.map(loadImage)).then(() => {
      if (cancelled) return;
      const next = new Map<string, HTMLImageElement>();
      for (const url of urls) {
        const img = imageCache.get(url);
        if (img) next.set(url, img);
      }
      setImages(next);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [layers]);

  // Draw whenever layers / images / dims change
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Render at the world resolution; CSS scales down for display.
    canvas.width = width;
    canvas.height = height;
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    renderLayers(ctx, layers, images, background === 'transparent');
  }, [layers, images, width, height, background]);

  useEffect(() => { draw(); }, [draw]);

  // Convert a screen (client) pointer position to world coordinates
  const toWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
    return { x, y };
  }, [width, height]);

  // ---- Pointer handlers ----
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const world = toWorld(e.clientX, e.clientY);

    // 1) Check handle hit first (if a layer is selected)
    if (selectedId) {
      const handle = hitHandle(world, selectedId, layers, displayScale);
      if (handle) {
        const layer = layers.find((l) => l.id === selectedId);
        if (layer) {
          dragRef.current = {
            layerId: selectedId,
            mode: handle === 'rot' ? 'rotate' : 'resize',
            handle,
            startWorldX: world.x,
            startWorldY: world.y,
            startLayer: { ...layer, properties: { ...layer.properties } },
          };
          e.preventDefault();
          return;
        }
      }
    }

    // 2) Pick a layer
    const picked = pickLayer(layers, world.x, world.y);
    if (picked) {
      onSelect(picked.id);
      dragRef.current = {
        layerId: picked.id,
        mode: 'move',
        startWorldX: world.x,
        startWorldY: world.y,
        startLayer: { ...picked, properties: { ...picked.properties } },
      };
    } else {
      onSelect(null);
      dragRef.current = null;
    }
    e.preventDefault();
  }, [layers, selectedId, displayScale, toWorld, onSelect]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const world = toWorld(e.clientX, e.clientY);
    const dx = world.x - drag.startWorldX;
    const dy = world.y - drag.startWorldY;
    const start = drag.startLayer;

    if (drag.mode === 'move') {
      onUpdate(drag.layerId, {
        x: start.x + dx,
        y: start.y + dy,
      });
    } else if (drag.mode === 'resize') {
      // Resize from the opposite corner (anchor stays fixed)
      const cx = start.x + start.width / 2;
      const cy = start.y + start.height / 2;
      // Use the rotated-opposite corner as the anchor. For simplicity keep
      // aspect-ratio free; anchor = the corner opposite to the dragged handle.
      let newX = start.x;
      let newY = start.y;
      let newW = start.width;
      let newH = start.height;
      const minSize = 20;
      switch (drag.handle) {
        case 'br':
          newW = Math.max(minSize, start.width + dx);
          newH = Math.max(minSize, start.height + dy);
          break;
        case 'tr':
          newW = Math.max(minSize, start.width + dx);
          newY = start.y + (start.height - Math.max(minSize, start.height - dy));
          newH = Math.max(minSize, start.height - dy);
          break;
        case 'bl':
          newX = start.x + (start.width - Math.max(minSize, start.width - dx));
          newW = Math.max(minSize, start.width - dx);
          newH = Math.max(minSize, start.height + dy);
          break;
        case 'tl':
          newX = start.x + (start.width - Math.max(minSize, start.width - dx));
          newY = start.y + (start.height - Math.max(minSize, start.height - dy));
          newW = Math.max(minSize, start.width - dx);
          newH = Math.max(minSize, start.height - dy);
          break;
        default:
          break;
      }
      // Keep the centre fixed during resize to feel natural (matches Figma).
      // We computed newX/Y relative to start corner, so centre is preserved
      // only when rotation is 0 — for rotated layers this is approximate.
      void cx; void cy;
      onUpdate(drag.layerId, {
        x: newX,
        y: newY,
        width: newW,
        height: newH,
      });
    } else if (drag.mode === 'rotate') {
      const cx = start.x + start.width / 2;
      const cy = start.y + start.height / 2;
      const angle = Math.atan2(world.y - cy, world.x - cx);
      const deg = (angle * 180) / Math.PI + 90; // 0° = up
      onUpdate(drag.layerId, { rotation: Math.round(deg) });
    }
    e.preventDefault();
  }, [onUpdate, toWorld]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && e.pointerId !== undefined) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (dragRef.current) {
      dragRef.current = null;
      onCommit();
    }
  }, [onCommit]);

  const onPointerCancel = useCallback(() => {
    dragRef.current = null;
    onCommit();
  }, [onCommit]);

  // ---- Selected layer (for overlay) ----
  const selected = useMemo(
    () => layers.find((l) => l.id === selectedId) ?? null,
    [layers, selectedId],
  );

  const cssWidth = width * displayScale;
  const cssHeight = height * displayScale;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: 'repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 50% / 24px 24px',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: cssWidth,
          height: cssHeight,
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          borderRadius: 6,
          overflow: 'visible',
        }}
      >
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          style={{
            width: cssWidth,
            height: cssHeight,
            display: 'block',
            borderRadius: 6,
            touchAction: 'none',
            cursor: dragRef.current ? 'grabbing' : 'default',
            opacity: ready ? 1 : 0.5,
            transition: 'opacity 200ms',
          }}
        />

        {/* Selection overlay (DOM, so it's not in the export) */}
        {selected && selected.visible && (
          <SelectionOverlay
            layer={selected}
            scale={displayScale}
            onHandlePointerDown={(handle, e) => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              canvas.setPointerCapture(e.pointerId);
              const world = toWorld(e.clientX, e.clientY);
              dragRef.current = {
                layerId: selected.id,
                mode: handle === 'rot' ? 'rotate' : 'resize',
                handle,
                startWorldX: world.x,
                startWorldY: world.y,
                startLayer: { ...selected, properties: { ...selected.properties } },
              };
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Selection overlay — DOM-rendered handles (not part of export)
// ---------------------------------------------------------------------------
const SelectionOverlay: React.FC<{
  layer: Layer;
  scale: number;
  onHandlePointerDown: (handle: HandleKind, e: React.PointerEvent<HTMLDivElement>) => void;
}> = ({ layer, scale, onHandlePointerDown }) => {
  // The box is in world coordinates; multiply by scale for CSS pixels.
  // We render it at the layer's unrotated position and rotate via CSS transform
  // around its centre.
  const w = layer.width * scale;
  const h = layer.height * scale;
  const left = layer.x * scale;
  const top = layer.y * scale;
  const transform = layer.rotation ? `rotate(${layer.rotation}deg)` : undefined;
  const transformOrigin = 'center center';

  const handleStyle: React.CSSProperties = {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: '#38bdf8',
    border: '2px solid #fff',
    borderRadius: 3,
    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
    touchAction: 'none',
    zIndex: 10,
  };

  const positions: { kind: HandleKind; style: React.CSSProperties }[] = [
    { kind: 'tl', style: { ...handleStyle, left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nwse-resize' } },
    { kind: 'tr', style: { ...handleStyle, left: w - HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2, cursor: 'nesw-resize' } },
    { kind: 'bl', style: { ...handleStyle, left: -HANDLE_SIZE / 2, top: h - HANDLE_SIZE / 2, cursor: 'nesw-resize' } },
    { kind: 'br', style: { ...handleStyle, left: w - HANDLE_SIZE / 2, top: h - HANDLE_SIZE / 2, cursor: 'nwse-resize' } },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        left, top,
        width: w, height: h,
        pointerEvents: 'none',
        transform,
        transformOrigin,
        boxSizing: 'border-box',
        border: '1.5px solid #38bdf8',
        boxShadow: '0 0 0 1px rgba(56,189,248,0.25)',
      }}
    >
      {positions.map(({ kind, style }) => (
        <div
          key={kind}
          style={{ ...style, pointerEvents: 'auto' }}
          onPointerDown={(e) => onHandlePointerDown(kind, e)}
        />
      ))}
      {/* Rotation handle — a circle above the top edge */}
      <div
        style={{
          position: 'absolute',
          left: w / 2 - HANDLE_SIZE,
          top: -36,
          width: HANDLE_SIZE * 2,
          height: HANDLE_SIZE * 2,
          borderRadius: '50%',
          background: '#38bdf8',
          border: '2px solid #fff',
          cursor: 'grab',
          touchAction: 'none',
          pointerEvents: 'auto',
          zIndex: 11,
        }}
        onPointerDown={(e) => onHandlePointerDown('rot', e)}
      />
      {/* Connector line for the rotation handle */}
      <div
        style={{
          position: 'absolute',
          left: w / 2 - 1,
          top: -28,
          width: 2,
          height: 28,
          background: '#38bdf8',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Handle hit detection (for the on-screen pointer interaction)
// ---------------------------------------------------------------------------
function hitHandle(
  world: { x: number; y: number },
  selectedId: string,
  layers: Layer[],
  displayScale: number,
): HandleKind | null {
  const layer = layers.find((l) => l.id === selectedId);
  if (!layer) return null;
  const handleWorld = HANDLE_SIZE / displayScale; // world-space handle size
  const corners: { kind: HandleKind; x: number; y: number }[] = [
    { kind: 'tl', x: layer.x, y: layer.y },
    { kind: 'tr', x: layer.x + layer.width, y: layer.y },
    { kind: 'bl', x: layer.x, y: layer.y + layer.height },
    { kind: 'br', x: layer.x + layer.width, y: layer.y + layer.height },
  ];
  for (const c of corners) {
    const rot = rotatePoint(world.x, world.y, layer.x + layer.width / 2, layer.y + layer.height / 2, -layer.rotation);
    if (Math.abs(rot.x - c.x) <= handleWorld && Math.abs(rot.y - c.y) <= handleWorld) {
      return c.kind;
    }
  }
  // Rotation handle: 28px above top-centre
  const rotHandleWorld = rotatePoint(
    layer.x + layer.width / 2,
    layer.y - 28 / displayScale,
    layer.x + layer.width / 2,
    layer.y + layer.height / 2,
    layer.rotation,
  );
  if (Math.abs(world.x - rotHandleWorld.x) <= handleWorld && Math.abs(world.y - rotHandleWorld.y) <= handleWorld) {
    return 'rot';
  }
  return null;
}

// Default export for convenience
export default CanvasEditor;
