/**
 * App.tsx — Main Micky Canvas app
 * --------------------------------
 * Orchestrates:
 *   - Image loading (URL param or upload)
 *   - Canvas + layers (delegates to <CanvasEditor>)
 *   - Toolbar (add text / icon / shape / image)
 *   - Layers panel (reorder, delete, visibility, duplicate)
 *   - Properties panel (text props, shape props, transform)
 *   - Templates picker (5 dental templates)
 *   - Export modal (PNG / JPG at 1080p)
 *   - Telegram WebApp integration (theme, haptics, session)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UIIcons, CANVAS_ICONS, getIcon, type CanvasIcon } from './icons';
import {
  DENTAL_TEMPLATES,
  EXPORT_PRESETS,
  instantiateTemplate,
  type Layer,
  type Template,
} from './templates';
import {
  CanvasEditor,
  layersToBlob,
  downloadBlob,
  loadImage,
  type ExportFormat,
} from './canvas';
import {
  applyTelegramTheme,
  getStartParam,
  getTelegramWebApp,
  haptic,
  hapticNotify,
  isTelegramWebApp,
} from './biometric';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_DIMS = { width: 1080, height: 1080 };
const FONTS = [
  { id: 'Cairo', label: 'Cairo · قاهرة' },
  { id: 'Tajawal', label: 'Tajawal · تجوال' },
];

// ---------------------------------------------------------------------------
// Utility: layer factory
// ---------------------------------------------------------------------------
let _id = 0;
function newId(prefix: string): string {
  _id += 1;
  return `${prefix}-${Date.now().toString(36)}-${_id}`;
}

function defaultTextLayer(text = 'اكتب نصًا هنا'): Layer {
  return {
    id: newId('text'),
    type: 'text',
    content: text,
    x: 140, y: 460, width: 800, height: 160,
    rotation: 0, opacity: 1, visible: true,
    properties: {
      fontFamily: 'Cairo',
      fontSize: 64,
      color: '#ffffff',
      align: 'center',
      direction: 'rtl',
      fontWeight: 700,
    },
  };
}

function defaultIconLayer(name: string): Layer {
  const ic = getIcon(name);
  return {
    id: newId('icon'),
    type: 'icon',
    content: name,
    x: 460, y: 200, width: 160, height: 160,
    rotation: 0, opacity: 1, visible: true,
    properties: {
      iconColor: `#${ic.hex}`,
      fontSize: 160,
    },
  };
}

function defaultShapeLayer(kind: 'rect' | 'circle' | 'triangle' | 'line' = 'rect'): Layer {
  return {
    id: newId('shape'),
    type: 'shape',
    content: kind,
    x: 200, y: 200, width: 400, height: 400,
    rotation: 0, opacity: 1, visible: true,
    properties: {
      backgroundColor: '#0ea5b7',
      borderRadius: kind === 'rect' ? 24 : 0,
      borderWidth: 0,
      borderColor: 'transparent',
    },
  };
}

function defaultImageLayer(url: string): Layer {
  return {
    id: newId('image'),
    type: 'image',
    content: url,
    x: 0, y: 0, width: 1080, height: 1080,
    rotation: 0, opacity: 1, visible: true,
    properties: { borderRadius: 0 },
  };
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
const App: React.FC = () => {
  // ---- State ----
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number }>(DEFAULT_DIMS);
  const [background, setBackground] = useState<string>('transparent');
  const [panel, setPanel] = useState<'layers' | 'properties' | 'templates' | 'icons'>('layers');
  const [exportOpen, setExportOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imgUploadInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Telegram integration on mount ----
  useEffect(() => {
    applyTelegramTheme();
    const session = getStartParam();
    if (session) setSessionInfo(session);
    const tg = getTelegramWebApp();
    tg?.ready();
    tg?.expand();
  }, []);

  // ---- Read URL parameters (image / template / dims / bg) ----
  useEffect(() => {
    const url = new URL(window.location.href);
    const tplId = url.searchParams.get('template');
    const img = url.searchParams.get('image');
    const bg = url.searchParams.get('bg');
    const w = parseInt(url.searchParams.get('w') || '', 10);
    const h = parseInt(url.searchParams.get('h') || '', 10);

    if (tplId) {
      const tpl = DENTAL_TEMPLATES.find((t) => t.id === tplId);
      if (tpl) {
        setDims({ width: tpl.dimensions.width, height: tpl.dimensions.height });
        setLayers(instantiateTemplate(tpl));
        return;
      }
    }
    if (w && h) setDims({ width: w, height: h });
    if (bg) setBackground(bg);

    if (img) {
      // Add a full-bleed image layer from the URL.
      const layer = defaultImageLayer(img);
      setDims({ width: w || 1080, height: h || 1080 });
      setLayers([layer]);
      setSelectedId(layer.id);
    }
  }, []);

  // ---- Toast auto-dismiss ----
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- Layer mutations ----
  const updateLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch, properties: { ...l.properties, ...(patch.properties ?? {}) } } : l)));
  }, []);

  const updateLayerProps = useCallback((id: string, props: Partial<Layer['properties']>) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, properties: { ...l.properties, ...props } } : l)));
  }, []);

  const commit = useCallback(() => {
    haptic('light');
    // History is a single-level undo; could be extended later.
  }, []);

  const addLayer = useCallback((l: Layer) => {
    setLayers((prev) => [...prev, l]);
    setSelectedId(l.id);
    setPanel('properties');
    haptic('medium');
  }, []);

  const deleteLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
    hapticNotify('warning');
  }, []);

  const duplicateLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const src = prev.find((l) => l.id === id);
      if (!src) return prev;
      const copy: Layer = {
        ...src,
        id: newId(src.type),
        x: src.x + 24,
        y: src.y + 24,
        properties: { ...src.properties },
      };
      const idx = prev.findIndex((l) => l.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      setSelectedId(copy.id);
      haptic('medium');
      return next;
    });
  }, []);

  const reorder = useCallback((id: string, dir: 'up' | 'down') => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx < 0) return prev;
      const newIdx = dir === 'up' ? Math.min(prev.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (newIdx === idx) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(newIdx, 0, item);
      haptic('light');
      return next;
    });
  }, []);

  const toggleVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  // ---- Add handlers ----
  const handleAddText = useCallback(() => addLayer(defaultTextLayer()), [addLayer]);
  const handleAddIcon = useCallback((name: string) => addLayer(defaultIconLayer(name)), [addLayer]);
  const handleAddShape = useCallback((kind: 'rect' | 'circle' | 'triangle' | 'line') => addLayer(defaultShapeLayer(kind)), [addLayer]);

  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      // Determine natural aspect ratio to fit the layer box
      const img = await loadImage(dataUrl);
      const ar = img.naturalWidth / img.naturalHeight;
      const maxW = dims.width;
      const maxH = dims.height;
      let w = maxW;
      let h = maxW / ar;
      if (h > maxH) {
        h = maxH;
        w = maxH * ar;
      }
      const layer: Layer = {
        id: newId('image'),
        type: 'image',
        content: dataUrl,
        x: (dims.width - w) / 2,
        y: (dims.height - h) / 2,
        width: w,
        height: h,
        rotation: 0, opacity: 1, visible: true,
        properties: { borderRadius: 0 },
      };
      addLayer(layer);
    } catch (err) {
      console.error(err);
      setToast('تعذّر تحميل الصورة');
      hapticNotify('error');
    } finally {
      setUploading(false);
    }
  }, [addLayer, dims]);

  // ---- Template application ----
  const applyTemplate = useCallback((tpl: Template) => {
    setDims({ width: tpl.dimensions.width, height: tpl.dimensions.height });
    setLayers(instantiateTemplate(tpl));
    setSelectedId(null);
    setPanel('layers');
    setToast(`تم تطبيق قالب: ${tpl.nameAr}`);
    hapticNotify('success');
  }, []);

  // ---- Export ----
  const handleExport = useCallback(async (format: ExportFormat, w: number, h: number) => {
    setBusy(true);
    try {
      // Scale layers to target dimensions if they differ from current dims
      let exportLayers = layers;
      if (w !== dims.width || h !== dims.height) {
        const sx = w / dims.width;
        const sy = h / dims.height;
        exportLayers = layers.map((l) => ({
          ...l,
          x: l.x * sx,
          y: l.y * sy,
          width: l.width * sx,
          height: l.height * sy,
          properties: {
            ...l.properties,
            fontSize: (l.properties.fontSize ?? 32) * Math.min(sx, sy),
          },
        }));
      }
      const bg = format === 'jpeg' ? (background === 'transparent' ? '#ffffff' : background) : background;
      const blob = await layersToBlob(exportLayers, w, h, format, bg);
      const ext = format === 'png' ? 'png' : 'jpg';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(blob, `micky-canvas-${ts}.${ext}`);
      setToast(`تم التصدير: ${ext.toUpperCase()}`);
      hapticNotify('success');
    } catch (err) {
      console.error(err);
      setToast('فشل التصدير — تأكد أن الصور من نفس الأصل');
      hapticNotify('error');
    } finally {
      setBusy(false);
      setExportOpen(false);
    }
  }, [layers, dims, background]);

  // ---- Selected layer ----
  const selected = useMemo(
    () => layers.find((l) => l.id === selectedId) ?? null,
    [layers, selectedId],
  );

  // ---- Hidden file inputs ----
  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFileUpload(f);
    e.target.value = '';
  }, [handleFileUpload]);

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div style={appShellStyle}>
      <Header
        onExport={() => setExportOpen(true)}
        onUploadClick={() => fileInputRef.current?.click()}
        uploading={uploading}
        inTelegram={isTelegramWebApp()}
      />

      {/* Canvas area */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <CanvasEditor
          layers={layers}
          width={dims.width}
          height={dims.height}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onUpdate={updateLayer}
          onCommit={commit}
          background={background}
        />

        {/* Empty-state hint */}
        {layers.length === 0 && (
          <div style={emptyStateStyle}>
            <UIIcons.Image size={48} strokeWidth={1.5} />
            <div style={{ marginTop: 12, fontWeight: 700, fontSize: 18 }}>ابدأ تصميمك</div>
            <div style={{ marginTop: 4, color: '#94a3b8', fontSize: 14 }}>
              اختر قالبًا أو أضف نصًا / أيقونة / صورة من الأدوات بالأسفل
            </div>
          </div>
        )}

        {/* Session badge */}
        {sessionInfo && (
          <div style={sessionBadgeStyle}>
            session: <code>{sessionInfo}</code>
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <Toolbar
        onAddText={handleAddText}
        onAddIcon={() => setPanel('icons')}
        onAddShape={() => setPanel('properties')}
        onUploadImage={() => imgUploadInputRef.current?.click()}
        panel={panel}
        setPanel={setPanel}
      />

      {/* Bottom panel (layers / properties / templates / icons) */}
      <BottomPanel
        panel={panel}
        setPanel={setPanel}
        layers={layers}
        selected={selected}
        onSelectLayer={setSelectedId}
        onDeleteLayer={deleteLayer}
        onDuplicateLayer={duplicateLayer}
        onReorder={reorder}
        onToggleVisible={toggleVisible}
        onUpdateProps={updateLayerProps}
        onUpdateLayer={updateLayer}
        onAddIcon={handleAddIcon}
        onAddShape={handleAddShape}
        onApplyTemplate={applyTemplate}
        background={background}
        setBackground={setBackground}
        dims={dims}
        setDims={setDims}
      />

      {/* Export modal */}
      {exportOpen && (
        <ExportModal
          dims={dims}
          onClose={() => setExportOpen(false)}
          onExport={handleExport}
          busy={busy}
        />
      )}

      {/* Toast */}
      {toast && <div style={toastStyle}>{toast}</div>}

      {/* Hidden inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />
      <input
        ref={imgUploadInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />
    </div>
  );
};

export default App;

// ===========================================================================
// Sub-components
// ===========================================================================

const Header: React.FC<{
  onExport: () => void;
  onUploadClick: () => void;
  uploading: boolean;
  inTelegram: boolean;
}> = ({ onExport, onUploadClick, uploading, inTelegram }) => (
  <header style={headerStyle}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,#0ea5b7,#38bdf8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <UIIcons.Sparkles size={18} color="#fff" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <strong style={{ fontSize: 15 }}>Micky Canvas</strong>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>محرر الصور</span>
      </div>
      {inTelegram && (
        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#1e3a5f', color: '#38bdf8', marginRight: 4 }}>
          Telegram
        </span>
      )}
    </div>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <button style={iconBtnStyle} onClick={onUploadClick} title="رفع صورة" aria-label="رفع صورة">
        {uploading ? <UIIcons.Sun size={18} className="spin" /> : <UIIcons.Upload size={18} />}
      </button>
      <button style={primaryBtnStyle} onClick={onExport}>
        <UIIcons.Download size={16} />
        <span style={{ marginRight: 4 }}>تصدير</span>
      </button>
    </div>
  </header>
);

const Toolbar: React.FC<{
  onAddText: () => void;
  onAddIcon: () => void;
  onAddShape: () => void;
  onUploadImage: () => void;
  panel: 'layers' | 'properties' | 'templates' | 'icons';
  setPanel: (p: 'layers' | 'properties' | 'templates' | 'icons') => void;
}> = ({ onAddText, onAddIcon, onAddShape, onUploadImage, panel, setPanel }) => {
  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 4, padding: '8px 4px', background: active ? '#1e3a5f' : 'transparent',
    color: active ? '#38bdf8' : '#cbd5e1', border: 'none',
    cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
  });
  return (
    <div style={toolbarStyle}>
      <button style={btn(false)} onClick={onAddText}>
        <UIIcons.Type size={20} />
        نص
      </button>
      <button style={btn(panel === 'icons')} onClick={onAddIcon}>
        <UIIcons.Smile size={20} />
        أيقونة
      </button>
      <button style={btn(panel === 'properties')} onClick={onAddShape}>
        <UIIcons.Shapes size={20} />
        شكل
      </button>
      <button style={btn(false)} onClick={onUploadImage}>
        <UIIcons.Image size={20} />
        صورة
      </button>
      <button style={btn(panel === 'templates')} onClick={() => setPanel('templates')}>
        <UIIcons.Wand size={20} />
        قوالب
      </button>
      <button style={btn(panel === 'layers')} onClick={() => setPanel('layers')}>
        <UIIcons.Layers size={20} />
        طبقات
      </button>
    </div>
  );
};

const BottomPanel: React.FC<{
  panel: 'layers' | 'properties' | 'templates' | 'icons';
  setPanel: (p: 'layers' | 'properties' | 'templates' | 'icons') => void;
  layers: Layer[];
  selected: Layer | null;
  onSelectLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onReorder: (id: string, dir: 'up' | 'down') => void;
  onToggleVisible: (id: string) => void;
  onUpdateProps: (id: string, props: Partial<Layer['properties']>) => void;
  onUpdateLayer: (id: string, patch: Partial<Layer>) => void;
  onAddIcon: (name: string) => void;
  onAddShape: (kind: 'rect' | 'circle' | 'triangle' | 'line') => void;
  onApplyTemplate: (t: Template) => void;
  background: string;
  setBackground: (c: string) => void;
  dims: { width: number; height: number };
  setDims: (d: { width: number; height: number }) => void;
}> = (props) => {
  const {
    panel, setPanel, layers, selected, onSelectLayer, onDeleteLayer, onDuplicateLayer,
    onReorder, onToggleVisible, onUpdateProps, onUpdateLayer,
    onAddIcon, onAddShape, onApplyTemplate, background, setBackground, dims, setDims,
  } = props;

  return (
    <div style={bottomPanelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: '#cbd5e1' }}>
          {panel === 'layers' && `الطبقات (${layers.length})`}
          {panel === 'properties' && (selected ? 'خصائص الطبقة' : 'الخصائص')}
          {panel === 'templates' && 'القوالب الجاهزة'}
          {panel === 'icons' && 'مكتبة الأيقونات'}
        </strong>
        <button
          onClick={() => setPanel('layers')}
          style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4 }}
          aria-label="إغلاق"
        >
          <UIIcons.X size={14} />
        </button>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: 240, paddingInlineEnd: 2 }}>
        {panel === 'layers' && (
          <LayersPanel
            layers={layers}
            selected={selected}
            onSelect={onSelectLayer}
            onDelete={onDeleteLayer}
            onDuplicate={onDuplicateLayer}
            onReorder={onReorder}
            onToggleVisible={onToggleVisible}
          />
        )}
        {panel === 'properties' && selected && (
          <PropertiesPanel
            layer={selected}
            onUpdateProps={onUpdateProps}
            onUpdateLayer={onUpdateLayer}
            background={background}
            setBackground={setBackground}
            dims={dims}
            setDims={setDims}
          />
        )}
        {panel === 'properties' && !selected && (
          <PropertiesPanel
            layer={null}
            onUpdateProps={() => {}}
            onUpdateLayer={() => {}}
            background={background}
            setBackground={setBackground}
            dims={dims}
            setDims={setDims}
          />
        )}
        {panel === 'templates' && (
          <TemplatesPanel onApply={onApplyTemplate} />
        )}
        {panel === 'icons' && (
          <IconsPanel onAddIcon={onAddIcon} onAddShape={onAddShape} />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------
const LayersPanel: React.FC<{
  layers: Layer[];
  selected: Layer | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (id: string, dir: 'up' | 'down') => void;
  onToggleVisible: (id: string) => void;
}> = ({ layers, selected, onSelect, onDelete, onDuplicate, onReorder, onToggleVisible }) => {
  if (layers.length === 0) {
    return <div style={{ color: '#64748b', fontSize: 13, padding: '12px 0' }}>لا توجد طبقات بعد.</div>;
  }
  // Render top → bottom (last in array = topmost)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {layers.slice().reverse().map((l) => (
        <div
          key={l.id}
          onClick={() => onSelect(l.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderRadius: 8, cursor: 'pointer',
            background: selected?.id === l.id ? '#1e3a5f' : 'rgba(255,255,255,0.03)',
            border: selected?.id === l.id ? '1px solid #38bdf8' : '1px solid transparent',
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onToggleVisible(l.id); }}
            style={miniBtn}
            aria-label="إظهار/إخفاء"
          >
            {l.visible ? <UIIcons.Eye size={14} /> : <UIIcons.EyeOff size={14} />}
          </button>
          <LayerIcon layer={l} />
          <span style={{ flex: 1, fontSize: 13, color: l.visible ? '#e2e8f0' : '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {layerLabel(l)}
          </span>
          <button onClick={(e) => { e.stopPropagation(); onReorder(l.id, 'up'); }} style={miniBtn} aria-label="رفع">
            <UIIcons.Up size={14} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onReorder(l.id, 'down'); }} style={miniBtn} aria-label="خفض">
            <UIIcons.Down size={14} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDuplicate(l.id); }} style={miniBtn} aria-label="نسخ">
            <UIIcons.Copy size={14} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(l.id); }} style={miniBtn} aria-label="حذف">
            <UIIcons.Trash size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};

const LayerIcon: React.FC<{ layer: Layer }> = ({ layer }) => {
  const icon = layer.type === 'text' ? <UIIcons.Type size={14} />
    : layer.type === 'image' ? <UIIcons.Image size={14} />
    : layer.type === 'icon' ? <UIIcons.Smile size={14} />
    : <UIIcons.Shapes size={14} />;
  return <span style={{ color: '#94a3b8' }}>{icon}</span>;
};

function layerLabel(l: Layer): string {
  if (l.type === 'text') return l.content.slice(0, 32) || 'نص فارغ';
  if (l.type === 'image') return l.content ? 'صورة' : 'صورة فارغة';
  if (l.type === 'icon') return getIcon(l.content).labelAr;
  if (l.type === 'shape') {
    const map: Record<string, string> = { rect: 'مستطيل', circle: 'دائرة', triangle: 'مثلث', line: 'خط' };
    return map[l.content] ?? 'شكل';
  }
  return 'طبقة';
}

// ---------------------------------------------------------------------------
// Properties panel
// ---------------------------------------------------------------------------
const PropertiesPanel: React.FC<{
  layer: Layer | null;
  onUpdateProps: (id: string, props: Partial<Layer['properties']>) => void;
  onUpdateLayer: (id: string, patch: Partial<Layer>) => void;
  background: string;
  setBackground: (c: string) => void;
  dims: { width: number; height: number };
  setDims: (d: { width: number; height: number }) => void;
}> = ({ layer, onUpdateProps, onUpdateLayer, background, setBackground, dims, setDims }) => {
  // Canvas-level properties (when no layer is selected)
  if (!layer) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="لون الخلفية">
          <ColorInput value={background === 'transparent' ? '#0f172a' : background} onChange={setBackground} allowTransparent onTransparent={() => setBackground('transparent')} />
        </Field>
        <Field label="أبعاد اللوحة">
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" value={dims.width} onChange={(e) => setDims({ ...dims, width: parseInt(e.target.value, 10) || 1080 })} style={numInput} />
            <span style={{ color: '#64748b' }}>×</span>
            <input type="number" value={dims.height} onChange={(e) => setDims({ ...dims, height: parseInt(e.target.value, 10) || 1080 })} style={numInput} />
          </div>
        </Field>
        <Field label="قوالب سريعة">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {EXPORT_PRESETS.map((p) => (
              <button key={p.id} style={chipBtn} onClick={() => setDims({ width: p.width, height: p.height })}>
                {p.label}
              </button>
            ))}
          </div>
        </Field>
      </div>
    );
  }

  const p = layer.properties;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Transform */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Field label="X">
          <input type="number" value={Math.round(layer.x)} onChange={(e) => onUpdateLayer(layer.id, { x: parseFloat(e.target.value) || 0 })} style={numInput} />
        </Field>
        <Field label="Y">
          <input type="number" value={Math.round(layer.y)} onChange={(e) => onUpdateLayer(layer.id, { y: parseFloat(e.target.value) || 0 })} style={numInput} />
        </Field>
        <Field label="عرض">
          <input type="number" value={Math.round(layer.width)} onChange={(e) => onUpdateLayer(layer.id, { width: Math.max(20, parseFloat(e.target.value) || 20) })} style={numInput} />
        </Field>
        <Field label="ارتفاع">
          <input type="number" value={Math.round(layer.height)} onChange={(e) => onUpdateLayer(layer.id, { height: Math.max(20, parseFloat(e.target.value) || 20) })} style={numInput} />
        </Field>
      </div>
      <Field label={`الدوران: ${Math.round(layer.rotation)}°`}>
        <input type="range" min={-180} max={180} value={layer.rotation} onChange={(e) => onUpdateLayer(layer.id, { rotation: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
      </Field>
      <Field label={`الشفافية: ${Math.round(layer.opacity * 100)}%`}>
        <input type="range" min={0} max={100} value={layer.opacity * 100} onChange={(e) => onUpdateLayer(layer.id, { opacity: parseInt(e.target.value, 10) / 100 })} style={{ width: '100%' }} />
      </Field>

      {/* Type-specific */}
      {layer.type === 'text' && (
        <>
          <Field label="النص">
            <textarea
              value={layer.content}
              onChange={(e) => onUpdateLayer(layer.id, { content: e.target.value })}
              rows={2}
              style={{ ...numInput, width: '100%', minHeight: 60, resize: 'vertical', fontFamily: 'Cairo' }}
            />
          </Field>
          <Field label="الخط">
            <select value={p.fontFamily ?? 'Cairo'} onChange={(e) => onUpdateProps(layer.id, { fontFamily: e.target.value })} style={numInput}>
              {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </Field>
          <Field label={`حجم الخط: ${p.fontSize ?? 32}px`}>
            <input type="range" min={12} max={160} value={p.fontSize ?? 32} onChange={(e) => onUpdateProps(layer.id, { fontSize: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
          </Field>
          <Field label="محاذاة">
            <div style={{ display: 'flex', gap: 4 }}>
              {(['right', 'center', 'left'] as const).map((a) => (
                <button key={a} style={{ ...segBtn, background: (p.align ?? 'center') === a ? '#1e3a5f' : '#1e293b', color: (p.align ?? 'center') === a ? '#38bdf8' : '#cbd5e1' }} onClick={() => onUpdateProps(layer.id, { align: a })}>
                  {a === 'right' ? <UIIcons.AlignRight size={14} /> : a === 'center' ? <UIIcons.AlignCenter size={14} /> : <UIIcons.AlignLeft size={14} />}
                </button>
              ))}
            </div>
          </Field>
          <Field label="الاتجاه">
            <div style={{ display: 'flex', gap: 4 }}>
              {(['rtl', 'ltr'] as const).map((d) => (
                <button key={d} style={{ ...segBtn, background: (p.direction ?? 'rtl') === d ? '#1e3a5f' : '#1e293b', color: (p.direction ?? 'rtl') === d ? '#38bdf8' : '#cbd5e1' }} onClick={() => onUpdateProps(layer.id, { direction: d })}>
                  {d.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
          <Field label="الوزن">
            <select value={p.fontWeight ?? 700} onChange={(e) => onUpdateProps(layer.id, { fontWeight: parseInt(e.target.value, 10) })} style={numInput}>
              {[400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </Field>
          <Field label="لون النص">
            <ColorInput value={p.color ?? '#ffffff'} onChange={(c) => onUpdateProps(layer.id, { color: c })} />
          </Field>
        </>
      )}

      {layer.type === 'shape' && (
        <>
          <Field label="النوع">
            <select value={layer.content} onChange={(e) => onUpdateLayer(layer.id, { content: e.target.value })} style={numInput}>
              <option value="rect">مستطيل</option>
              <option value="circle">دائرة</option>
              <option value="triangle">مثلث</option>
              <option value="line">خط</option>
            </select>
          </Field>
          <Field label="لون التعبئة">
            <ColorInput value={p.backgroundColor ?? '#0ea5b7'} onChange={(c) => onUpdateProps(layer.id, { backgroundColor: c })} />
          </Field>
          {layer.content === 'rect' && (
            <Field label={`استدارة الزوايا: ${p.borderRadius ?? 0}px`}>
              <input type="range" min={0} max={200} value={p.borderRadius ?? 0} onChange={(e) => onUpdateProps(layer.id, { borderRadius: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
            </Field>
          )}
          <Field label={`سمك الحد: ${p.borderWidth ?? 0}px`}>
            <input type="range" min={0} max={40} value={p.borderWidth ?? 0} onChange={(e) => onUpdateProps(layer.id, { borderWidth: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
          </Field>
          {(p.borderWidth ?? 0) > 0 && (
            <Field label="لون الحد">
              <ColorInput value={p.borderColor ?? '#ffffff'} onChange={(c) => onUpdateProps(layer.id, { borderColor: c })} />
            </Field>
          )}
        </>
      )}

      {layer.type === 'icon' && (
        <>
          <Field label="الأيقونة">
            <div style={{ fontSize: 12, color: '#cbd5e1' }}>{getIcon(layer.content).labelAr} · {getIcon(layer.content).label}</div>
          </Field>
          <Field label="لون الأيقونة">
            <ColorInput value={p.iconColor ?? `#${getIcon(layer.content).hex}`} onChange={(c) => onUpdateProps(layer.id, { iconColor: c })} />
          </Field>
        </>
      )}

      {layer.type === 'image' && (
        <>
          <Field label={`استدارة الزوايا: ${p.borderRadius ?? 0}px`}>
            <input type="range" min={0} max={200} value={p.borderRadius ?? 0} onChange={(e) => onUpdateProps(layer.id, { borderRadius: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
          </Field>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {layer.content ? 'الصورة محمّلة.' : 'لا توجد صورة — ارفع صورة لاستبدال هذه الطبقة.'}
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Templates panel
// ---------------------------------------------------------------------------
const TemplatesPanel: React.FC<{ onApply: (t: Template) => void }> = ({ onApply }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
    {DENTAL_TEMPLATES.map((t) => (
      <button key={t.id} onClick={() => onApply(t)} style={tplCardStyle}>
        <TemplateThumb tpl={t} />
        <div style={{ fontWeight: 700, fontSize: 13, marginTop: 6 }}>{t.nameAr}</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>{t.dimensions.width}×{t.dimensions.height}</div>
      </button>
    ))}
  </div>
);

const TemplateThumb: React.FC<{ tpl: Template }> = ({ tpl }) => {
  // Mini-preview: render the background + a few key layers as colored blocks
  const w = tpl.dimensions.width;
  const h = tpl.dimensions.height;
  const bg = tpl.layers.find((l) => l.type === 'shape' && l.content === 'rect')?.properties.backgroundColor ?? '#0f4c75';
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: `${w} / ${h}`, background: bg, borderRadius: 6, overflow: 'hidden', border: '1px solid #1e293b' }}>
      {tpl.layers.slice(1, 6).map((l) => {
        const s = 100 / w; // scale to %
        if (l.type === 'text') {
          return <div key={l.id} style={{ position: 'absolute', left: `${l.x * s}%`, top: `${l.y * s}%`, width: `${l.width * s}%`, height: `${l.height * s}%`, background: l.properties.color ?? '#fff', opacity: 0.6, borderRadius: 2 }} />;
        }
        if (l.type === 'shape') {
          return <div key={l.id} style={{ position: 'absolute', left: `${l.x * s}%`, top: `${l.y * s}%`, width: `${l.width * s}%`, height: `${l.height * s}%`, background: l.properties.backgroundColor ?? '#0ea5b7', borderRadius: l.properties.borderRadius ? 4 : 0, opacity: 0.8 }} />;
        }
        return null;
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Icons panel
// ---------------------------------------------------------------------------
const IconsPanel: React.FC<{
  onAddIcon: (name: string) => void;
  onAddShape: (kind: 'rect' | 'circle' | 'triangle' | 'line') => void;
}> = ({ onAddIcon, onAddShape }) => {
  const categories: Array<CanvasIcon['category']> = ['dental', 'medical', 'social'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Quick shapes */}
      <div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>أشكال</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {([
            ['rect', 'مستطيل'],
            ['circle', 'دائرة'],
            ['triangle', 'مثلث'],
            ['line', 'خط'],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => onAddShape(k)} style={iconTileStyle}>
              {k === 'rect' && <div style={{ width: 24, height: 18, background: '#0ea5b7', borderRadius: 4 }} />}
              {k === 'circle' && <div style={{ width: 24, height: 24, background: '#0ea5b7', borderRadius: '50%' }} />}
              {k === 'triangle' && <div style={{ width: 0, height: 0, borderLeft: '12px solid transparent', borderRight: '12px solid transparent', borderBottom: '20px solid #0ea5b7' }} />}
              {k === 'line' && <div style={{ width: 26, height: 4, background: '#0ea5b7' }} />}
              <span style={{ fontSize: 10, marginTop: 4 }}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {categories.map((cat) => (
        <div key={cat}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
            {cat === 'dental' ? 'أسنان' : cat === 'medical' ? 'طبي' : 'تواصل اجتماعي'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {CANVAS_ICONS.filter((i) => i.category === cat).map((ic) => (
              <button key={ic.name} onClick={() => onAddIcon(ic.name)} style={iconTileStyle} title={ic.labelAr}>
                <IconSvg icon={ic} size={28} />
                <span style={{ fontSize: 10, marginTop: 4, color: '#94a3b8' }}>{ic.labelAr}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const IconSvg: React.FC<{ icon: CanvasIcon; size: number }> = ({ icon, size }) => (
  <svg width={size} height={size} viewBox={icon.viewBox} fill={`#${icon.hex}`} xmlns="http://www.w3.org/2000/svg">
    {icon.paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

// ---------------------------------------------------------------------------
// Export modal
// ---------------------------------------------------------------------------
const ExportModal: React.FC<{
  dims: { width: number; height: number };
  onClose: () => void;
  onExport: (format: ExportFormat, w: number, h: number) => void;
  busy: boolean;
}> = ({ dims, onClose, onExport, busy }) => {
  const [format, setFormat] = useState<ExportFormat>('png');
  const presets = useMemo(() => {
    return [
      { id: 'current', label: `الحالي · ${dims.width}×${dims.height}`, width: dims.width, height: dims.height },
      ...EXPORT_PRESETS.map((p) => ({ ...p })),
    ];
  }, [dims]);
  const [sel, setSel] = useState('current');
  const target = presets.find((p) => p.id === sel) ?? presets[0];

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>تصدير الصورة</strong>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
            <UIIcons.X size={18} />
          </button>
        </div>

        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>الأبعاد</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {presets.map((p) => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: sel === p.id ? '#1e3a5f' : 'transparent' }}>
              <input type="radio" checked={sel === p.id} onChange={() => setSel(p.id)} />
              <span style={{ fontSize: 13 }}>{p.label}</span>
            </label>
          ))}
        </div>

        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>الصيغة</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {(['png', 'jpeg'] as const).map((f) => (
            <button key={f} onClick={() => setFormat(f)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid', borderColor: format === f ? '#38bdf8' : '#1e293b', background: format === f ? '#1e3a5f' : 'transparent', color: format === f ? '#38bdf8' : '#cbd5e1', cursor: 'pointer', fontFamily: 'inherit' }}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>

        <button
          onClick={() => onExport(format, target.width, target.height)}
          disabled={busy}
          style={primaryBtnStyle}
        >
          {busy ? 'جاري التصدير…' : `تصدير ${target.width}×${target.height}`}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Field + ColorInput helpers
// ---------------------------------------------------------------------------
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 11, color: '#94a3b8' }}>{label}</span>
    {children}
  </label>
);

const ColorInput: React.FC<{
  value: string;
  onChange: (c: string) => void;
  allowTransparent?: boolean;
  onTransparent?: () => void;
}> = ({ value, onChange, allowTransparent, onTransparent }) => (
  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
    <input
      type="color"
      value={value.length === 7 ? value : '#000000'}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: 40, height: 32, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
    />
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...numInput, flex: 1, fontFamily: 'monospace' }}
    />
    {allowTransparent && onTransparent && (
      <button onClick={onTransparent} style={{ ...chipBtn, fontSize: 10 }} title="شفاف">شفاف</button>
    )}
  </div>
);

// ===========================================================================
// Styles
// ===========================================================================
const appShellStyle: React.CSSProperties = {
  height: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f172a',
  color: '#e2e8f0',
  fontFamily: "'Cairo', 'Tajawal', sans-serif",
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 12px',
  background: 'rgba(15,23,42,0.9)',
  backdropFilter: 'blur(8px)',
  borderBottom: '1px solid #1e293b',
  direction: 'rtl',
};

const toolbarStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  borderTop: '1px solid #1e293b',
  background: 'rgba(15,23,42,0.9)',
  backdropFilter: 'blur(8px)',
  padding: '4px 4px',
  paddingBottom: 'max(4px, env(safe-area-inset-bottom))',
  direction: 'rtl',
};

const bottomPanelStyle: React.CSSProperties = {
  flexShrink: 0,
  maxHeight: '46dvh',
  background: '#0f172a',
  borderTop: '1px solid #1e293b',
  padding: '10px 12px',
  direction: 'rtl',
  display: 'flex',
  flexDirection: 'column',
};

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 36, height: 36, borderRadius: 8, background: '#1e293b', color: '#cbd5e1',
  border: '1px solid #334155', cursor: 'pointer', padding: 0,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  padding: '8px 14px', borderRadius: 8, background: 'linear-gradient(135deg,#0ea5b7,#38bdf8)',
  color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 13,
};

const numInput: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, background: '#1e293b', color: '#e2e8f0',
  border: '1px solid #334155', fontFamily: 'inherit', fontSize: 13, width: '100%', boxSizing: 'border-box',
};

const segBtn: React.CSSProperties = {
  flex: 1, padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

const chipBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 999, background: '#1e293b', color: '#cbd5e1',
  border: '1px solid #334155', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
};

const miniBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, borderRadius: 6, background: 'transparent', color: '#94a3b8',
  border: 'none', cursor: 'pointer', padding: 0,
};

const iconTileStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 2, padding: 8, borderRadius: 8, background: '#1e293b', color: '#cbd5e1',
  border: '1px solid #334155', cursor: 'pointer', fontFamily: 'inherit',
};

const tplCardStyle: React.CSSProperties = {
  padding: 10, borderRadius: 10, background: '#1e293b', color: '#e2e8f0',
  border: '1px solid #334155', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'right',
};

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100,
};

const modalCardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 480, background: '#0f172a', padding: 18,
  borderRadius: '16px 16px 0 0', border: '1px solid #1e293b', direction: 'rtl',
  paddingBottom: 'max(18px, env(safe-area-inset-bottom))',
};

const emptyStateStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', color: '#64748b',
  pointerEvents: 'none', textAlign: 'center',
};

const sessionBadgeStyle: React.CSSProperties = {
  position: 'absolute', bottom: 8, left: 8, padding: '4px 8px', borderRadius: 6,
  background: 'rgba(15,23,42,0.8)', color: '#64748b', fontSize: 10, fontFamily: 'monospace',
  direction: 'ltr',
};

const toastStyle: React.CSSProperties = {
  position: 'fixed', bottom: 'max(120px, calc(46dvh + 80px))', left: '50%',
  transform: 'translateX(-50%)', padding: '10px 18px', borderRadius: 999,
  background: 'rgba(15,23,42,0.95)', color: '#fff', border: '1px solid #38bdf8',
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 200, fontSize: 13, fontWeight: 600,
};
