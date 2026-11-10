/**
 * templates.ts — Dental content templates for Micky Canvas
 * --------------------------------------------------------
 * Pure data module: defines the `Layer` interface (shared with canvas.tsx
 * and App.tsx) and a registry of 5 dental templates that the user can apply
 * with one tap.
 */

// ---------------------------------------------------------------------------
// Layer interface (shared across canvas / app / templates)
// ---------------------------------------------------------------------------
export interface Layer {
  id: string;
  /** 'image' = raster URL/data-URI; 'text' = string; 'icon' = icon name from icons.ts; 'shape' = 'rect' | 'circle' | 'triangle' | 'line' */
  type: 'image' | 'text' | 'icon' | 'shape';
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  opacity: number; // 0..1
  visible: boolean;
  properties: {
    fontFamily?: string;
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
    align?: 'left' | 'center' | 'right';
    direction?: 'rtl' | 'ltr';
    fontWeight?: number;
    borderRadius?: number;
    borderColor?: string;
    borderWidth?: number;
    iconColor?: string; // for icon layers (defaults to color)
  };
}

// ---------------------------------------------------------------------------
// Template interface
// ---------------------------------------------------------------------------
export interface Template {
  id: string;
  name: string;
  nameAr: string;
  dimensions: { width: number; height: number };
  /** Aspect ratio hint shown in the picker */
  ratio: 'square' | 'portrait' | 'story' | 'carousel';
  layers: Layer[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Create a fresh copy of a template's layers with new IDs (so multiple
 *  instances don't collide). */
export function instantiateTemplate(tpl: Template): Layer[] {
  return tpl.layers.map((l) => ({ ...l, properties: { ...l.properties }, id: genId(l.type) }));
}

// Convenience factories ---------------------------------------------------
function rect(
  x: number, y: number, w: number, h: number,
  fill: string,
  opts: Partial<Layer['properties']> = {},
): Layer {
  return {
    id: genId('shape'),
    type: 'shape',
    content: 'rect',
    x, y, width: w, height: h,
    rotation: 0,
    opacity: 1,
    visible: true,
    properties: {
      backgroundColor: fill,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: 'transparent',
      ...opts,
    },
  };
}

function circle(cx: number, cy: number, d: number, fill: string): Layer {
  return {
    id: genId('shape'),
    type: 'shape',
    content: 'circle',
    x: cx - d / 2, y: cy - d / 2, width: d, height: d,
    rotation: 0, opacity: 1, visible: true,
    properties: { backgroundColor: fill, borderWidth: 0, borderColor: 'transparent' },
  };
}

function text(
  content: string,
  x: number, y: number, w: number, h: number,
  opts: {
    size: number;
    color: string;
    align?: 'left' | 'center' | 'right';
    direction?: 'rtl' | 'ltr';
    weight?: number;
    font?: string;
  },
): Layer {
  return {
    id: genId('text'),
    type: 'text',
    content,
    x, y, width: w, height: h,
    rotation: 0, opacity: 1, visible: true,
    properties: {
      fontSize: opts.size,
      color: opts.color,
      align: opts.align ?? 'center',
      direction: opts.direction ?? 'rtl',
      fontWeight: opts.weight ?? 700,
      fontFamily: opts.font ?? 'Cairo',
    },
  };
}

function icon(
  name: string,
  cx: number, cy: number, size: number,
  color: string,
): Layer {
  return {
    id: genId('icon'),
    type: 'icon',
    content: name,
    x: cx - size / 2, y: cy - size / 2, width: size, height: size,
    rotation: 0, opacity: 1, visible: true,
    properties: { iconColor: color, fontSize: size },
  };
}

function imageLayer(url: string, x: number, y: number, w: number, h: number): Layer {
  return {
    id: genId('image'),
    type: 'image',
    content: url,
    x, y, width: w, height: h,
    rotation: 0, opacity: 1, visible: true,
    properties: { borderRadius: 0 },
  };
}

// ---------------------------------------------------------------------------
// Brand palette (dental clinic theme)
// ---------------------------------------------------------------------------
const PALETTE = {
  bgTeal: '#0ea5b7',
  bgDeep: '#0f4c75',
  accent: '#fbbf24',
  white: '#ffffff',
  ink: '#0f172a',
  muted: '#64748b',
  mint: '#34d399',
  rose: '#f472b6',
  instagramPink: '#E4405F',
};

// ===========================================================================
// TEMPLATE 1 — Carousel Slide (1 of 4)
// ===========================================================================
const CAROUSEL_TEMPLATE: Template = {
  id: 'carousel',
  name: 'Carousel Slide',
  nameAr: 'كاروسيل',
  dimensions: { width: 1080, height: 1080 },
  ratio: 'carousel',
  layers: [
    // Background
    rect(0, 0, 1080, 1080, PALETTE.bgDeep),
    // Top accent bar
    rect(0, 0, 1080, 16, PALETTE.accent),
    // Header pill
    rect(60, 80, 240, 60, PALETTE.bgTeal, { borderRadius: 30 }),
    text('نصيحة أسنان', 60, 80, 240, 60, {
      size: 28, color: PALETTE.white, align: 'center', weight: 700,
    }),
    // Main title
    text('كيف تحافظ على لمعان ابتسامتك؟', 60, 180, 960, 140, {
      size: 64, color: PALETTE.white, align: 'right', weight: 800,
    }),
    // Image placeholder (centered)
    imageLayer('', 140, 360, 800, 480),
    // Decorative circle (behind image, but appears before it in z-order)
    circle(540, 600, 540, PALETTE.bgTeal),
    // Body text
    text('استخدم فرشاة ناعمة مرتين يوميًا، وخيط الأسنان مرة قبل النوم، وتجنّب الإفراط في المشروبات السكرية.', 60, 880, 960, 120, {
      size: 30, color: '#cbd5e1', align: 'right', weight: 500,
    }),
    // Slide indicator "1 / 4"
    text('1 / 4', 880, 1000, 140, 40, {
      size: 24, color: PALETTE.accent, align: 'center', weight: 700, direction: 'ltr',
    }),
    // Tooth icon
    icon('tooth', 970, 110, 56, PALETTE.accent),
  ],
};

// ===========================================================================
// TEMPLATE 2 — Before / After (split screen)
// ===========================================================================
const BEFORE_AFTER_TEMPLATE: Template = {
  id: 'before-after',
  name: 'Before / After',
  nameAr: 'قبل / بعد',
  dimensions: { width: 1080, height: 1080 },
  ratio: 'square',
  layers: [
    // Background
    rect(0, 0, 1080, 1080, PALETTE.ink),
    // Two image placeholders
    imageLayer('', 0, 0, 540, 1080),       // left = before
    imageLayer('', 540, 0, 540, 1080),    // right = after
    // Center divider
    rect(530, 0, 20, 1080, PALETTE.accent),
    // "قبل" badge (left, bottom)
    rect(60, 940, 200, 80, PALETTE.rose, { borderRadius: 40 }),
    text('قبل', 60, 940, 200, 80, {
      size: 36, color: PALETTE.white, align: 'center', weight: 800,
    }),
    // "بعد" badge (right, bottom)
    rect(820, 940, 200, 80, PALETTE.mint, { borderRadius: 40 }),
    text('بعد', 820, 940, 200, 80, {
      size: 36, color: PALETTE.white, align: 'center', weight: 800,
    }),
    // Title at top
    rect(0, 0, 1080, 100, PALETTE.bgDeep),
    text('نتائج تبييض الأسنان الاحترافي', 60, 0, 960, 100, {
      size: 32, color: PALETTE.white, align: 'center', weight: 700,
    }),
    // Sparkle icons on the "after" side
    icon('sparkle', 720, 220, 60, PALETTE.accent),
    icon('sparkle', 900, 360, 44, PALETTE.accent),
    icon('sparkle', 640, 480, 38, PALETTE.accent),
  ],
};

// ===========================================================================
// TEMPLATE 3 — Treatment Steps (3 steps, portrait)
// ===========================================================================
const STEPS_TEMPLATE: Template = {
  id: 'treatment-steps',
  name: 'Treatment Steps',
  nameAr: 'خطوات العلاج',
  dimensions: { width: 1080, height: 1350 },
  ratio: 'portrait',
  layers: [
    rect(0, 0, 1080, 1350, '#f8fafc'),
    // Header
    rect(0, 0, 1080, 220, PALETTE.bgTeal),
    text('خطوات تبييض الأسنان', 60, 40, 960, 80, {
      size: 52, color: PALETTE.white, align: 'right', weight: 800,
    }),
    text('ثلاث خطوات بسيطة لابتسامة أكثر إشراقًا', 60, 130, 960, 60, {
      size: 26, color: '#e0f2fe', align: 'right', weight: 500,
    }),
    // Step 1
    circle(180, 380, 140, PALETTE.bgDeep),
    text('1', 180, 380, 140, 140, {
      size: 64, color: PALETTE.white, align: 'center', weight: 800, direction: 'ltr',
    }),
    icon('brush', 180, 380, 80, PALETTE.accent),
    text('تنظيف احترافي', 320, 320, 700, 60, {
      size: 36, color: PALETTE.ink, align: 'right', weight: 700,
    }),
    text('إزالة الجير والتصبغات السطحية لتحضير الأسنان للتبييض.', 320, 390, 700, 80, {
      size: 24, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    // Divider
    rect(60, 560, 960, 2, '#e2e8f0'),
    // Step 2
    circle(180, 690, 140, PALETTE.bgDeep),
    text('2', 180, 690, 140, 140, {
      size: 64, color: PALETTE.white, align: 'center', weight: 800, direction: 'ltr',
    }),
    icon('sparkle', 180, 690, 80, PALETTE.accent),
    text('تطبيق مادة التبييض', 320, 630, 700, 60, {
      size: 36, color: PALETTE.ink, align: 'right', weight: 700,
    }),
    text('وضع جل التبييض وتنشيطه بالضوء لمدة 30 دقيقة.', 320, 700, 700, 80, {
      size: 24, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    rect(60, 870, 960, 2, '#e2e8f0'),
    // Step 3
    circle(180, 1000, 140, PALETTE.mint),
    text('3', 180, 1000, 140, 140, {
      size: 64, color: PALETTE.white, align: 'center', weight: 800, direction: 'ltr',
    }),
    icon('smile', 180, 1000, 80, PALETTE.white),
    text('ابتسامة جديدة', 320, 940, 700, 60, {
      size: 36, color: PALETTE.ink, align: 'right', weight: 700,
    }),
    text('نتيجة فورية تدوم حتى 12 شهرًا مع العناية المناسبة.', 320, 1010, 700, 80, {
      size: 24, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    // Footer
    rect(0, 1240, 1080, 110, PALETTE.bgDeep),
    text('عيادة سمايل · لحجز موعد: 0500-123-456', 60, 1240, 960, 110, {
      size: 26, color: '#cbd5e1', align: 'center', weight: 600,
    }),
  ],
};

// ===========================================================================
// TEMPLATE 4 — Did You Know? (fact card)
// ===========================================================================
const DID_YOU_KNOW_TEMPLATE: Template = {
  id: 'did-you-know',
  name: 'Did You Know?',
  nameAr: 'هل تعلم؟',
  dimensions: { width: 1080, height: 1080 },
  ratio: 'square',
  layers: [
    rect(0, 0, 1080, 1080, PALETTE.bgTeal),
    // Decorative big circle
    circle(540, 540, 900, PALETTE.bgDeep),
    // "هل تعلم؟" pill
    rect(390, 120, 300, 80, PALETTE.accent, { borderRadius: 40 }),
    text('هل تعلم؟', 390, 120, 300, 80, {
      size: 40, color: PALETTE.ink, align: 'center', weight: 800,
    }),
    // Big tooth icon
    icon('tooth', 540, 360, 180, PALETTE.white),
    // Question text
    text('أن استخدام خيط الأسنان يوميًا يطيل عمر أسنانك بما يصل إلى 6 سنوات؟', 120, 540, 840, 260, {
      size: 44, color: PALETTE.white, align: 'center', weight: 700,
    }),
    // Source
    text('المصدر: الجمعية الأمريكية لطب الأسنان', 120, 860, 840, 50, {
      size: 24, color: '#cbd5e1', align: 'center', weight: 500, direction: 'rtl',
    }),
    // Footer brand
    icon('instagram', 540, 980, 44, PALETTE.white),
  ],
};

// ===========================================================================
// TEMPLATE 5 — Appointment Reminder (story 9:16)
// ===========================================================================
const APPOINTMENT_TEMPLATE: Template = {
  id: 'appointment',
  name: 'Appointment Reminder',
  nameAr: 'تذكير موعد',
  dimensions: { width: 1080, height: 1920 },
  ratio: 'story',
  layers: [
    rect(0, 0, 1080, 1920, PALETTE.bgDeep),
    // Top decorative band
    rect(0, 0, 1080, 8, PALETTE.accent),
    // Calendar icon (big)
    circle(540, 360, 320, PALETTE.bgTeal),
    icon('tooth', 540, 360, 160, PALETTE.accent),
    // Title
    text('تذكير بموعدك القادم', 80, 580, 920, 100, {
      size: 56, color: PALETTE.white, align: 'center', weight: 800,
    }),
    // Patient name (placeholder)
    text('مرحبًا، Micky 👋', 80, 700, 920, 70, {
      size: 36, color: '#cbd5e1', align: 'center', weight: 600,
    }),
    // Appointment card
    rect(80, 880, 920, 460, '#1e3a5f', { borderRadius: 32 }),
    // Date label
    text('التاريخ', 140, 920, 400, 60, {
      size: 28, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    text('الإثنين، 15 يونيو 2026', 140, 980, 800, 80, {
      size: 40, color: PALETTE.white, align: 'right', weight: 700,
    }),
    // Time label
    text('الوقت', 140, 1100, 400, 60, {
      size: 28, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    text('الساعة 4:30 مساءً', 140, 1160, 800, 80, {
      size: 40, color: PALETTE.white, align: 'right', weight: 700,
    }),
    // Location
    text('العنوان', 140, 1280, 800, 60, {
      size: 28, color: PALETTE.muted, align: 'right', weight: 500,
    }),
    text('عيادة سمايل — حي النخيل، الرياض', 140, 1340, 800, 60, {
      size: 32, color: PALETTE.white, align: 'right', weight: 600,
    }),
    // CTA button (visual only)
    rect(140, 1480, 800, 110, PALETTE.accent, { borderRadius: 55 }),
    text('تأكيد الموعد', 140, 1480, 800, 110, {
      size: 36, color: PALETTE.ink, align: 'center', weight: 800,
    }),
    // Phone / cancel hint
    text('لإعادة الجدولة، اتصل: 0500-123-456', 80, 1660, 920, 60, {
      size: 26, color: '#94a3b8', align: 'center', weight: 500,
    }),
    // Brand footer
    rect(0, 1820, 1080, 100, PALETTE.bgTeal),
    text('عيادة سمايل لطب الأسنان', 80, 1820, 920, 100, {
      size: 30, color: PALETTE.white, align: 'center', weight: 700,
    }),
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const DENTAL_TEMPLATES: Template[] = [
  CAROUSEL_TEMPLATE,
  BEFORE_AFTER_TEMPLATE,
  STEPS_TEMPLATE,
  DID_YOU_KNOW_TEMPLATE,
  APPOINTMENT_TEMPLATE,
];

/** Look up a template by id */
export function getTemplate(id: string): Template | undefined {
  return DENTAL_TEMPLATES.find((t) => t.id === id);
}

/** Common export presets (1080p) */
export const EXPORT_PRESETS = [
  { id: 'square', label: 'مربع 1080×1080', width: 1080, height: 1080 },
  { id: 'portrait', label: 'بورتريه 1080×1350', width: 1080, height: 1350 },
  { id: 'story', label: 'ستوري 1080×1920', width: 1080, height: 1920 },
] as const;

export type ExportPreset = (typeof EXPORT_PRESETS)[number];
