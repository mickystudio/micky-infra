/**
 * icons.ts — Unified icon registry for Micky Canvas
 * --------------------------------------------------
 * Two usage contexts:
 *
 *   1. UI / Toolbar  →  React components from `lucide-react`
 *   2. Canvas        →  raw SVG path data drawn with ctx.fill()
 *
 * Brand logos (Instagram, TikTok, etc.) come from `simple-icons` which
 * exposes `{ title, hex, path }` per icon. Dental / custom icons are
 * hand-authored path strings so they can be drawn onto the <canvas>.
 */

import {
  // UI icons
  Plus,
  Trash2,
  Download,
  Layers as LayersIcon,
  Type as TypeIcon,
  Shapes,
  Image as ImageIcon,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  Copy,
  RotateCw,
  Sun,
  Upload,
  Sparkles,
  Wand2,
  Settings,
  X,
  GripVertical,
  AlignRight,
  AlignCenter,
  AlignLeft,
  Bold,
  Italic,
  Smartphone,
  Fingerprint,
  Lock,
  Palette,
  Move,
  Maximize2,
  // Dental / medical icons that exist in lucide
  Smile,
  Heart,
  Stethoscope,
} from 'lucide-react';

import {
  siInstagram,
  siTiktok,
  siYoutube,
  siFacebook,
  siWhatsapp,
  siX,
  siSnapchat,
  siTelegram,
} from 'simple-icons';

// ---------------------------------------------------------------------------
// 1. UI ICONS — re-export lucide-react components for the toolbar / panels
// ---------------------------------------------------------------------------
export const UIIcons = {
  Plus,
  Trash: Trash2,
  Download,
  Layers: LayersIcon,
  Type: TypeIcon,
  Shapes,
  Image: ImageIcon,
  Eye,
  EyeOff,
  Up: ChevronUp,
  Down: ChevronDown,
  Copy,
  Rotate: RotateCw,
  Sun,
  Upload,
  Sparkles,
  Wand: Wand2,
  Settings,
  X,
  Grip: GripVertical,
  AlignRight,
  AlignCenter,
  AlignLeft,
  Bold,
  Italic,
  Smartphone,
  Fingerprint,
  Lock,
  Palette,
  Move,
  Maximize: Maximize2,
  Smile,
  Heart,
  Stethoscope,
} as const;

// ---------------------------------------------------------------------------
// 2. CANVAS ICONS — raw SVG path data drawn onto <canvas>
// ---------------------------------------------------------------------------
export interface CanvasIcon {
  /** Unique key used by layers (`content` field) */
  name: string;
  /** Human-readable label shown in the icon picker */
  label: string;
  /** Arabic label shown in the icon picker */
  labelAr: string;
  /** viewBox of the source SVG (almost always 0 0 24 24) */
  viewBox: string;
  /** One or more SVG path `d` strings */
  paths: string[];
  /** Default fill colour (hex without #) */
  hex: string;
  /** Category for grouping in the picker UI */
  category: 'dental' | 'medical' | 'social' | 'ui';
}

// ---- Brand icons from simple-icons (viewBox 0 0 24 24, single path) ------
function brand(
  name: string,
  si: { title: string; hex: string; path: string },
  labelAr: string,
): CanvasIcon {
  return {
    name,
    label: si.title,
    labelAr,
    viewBox: '0 0 24 24',
    paths: [si.path],
    hex: si.hex,
    category: 'social',
  };
}

// ---- Custom dental icons (hand-authored SVG paths, 0 0 24 24) ------
// Tooth outline with a small cavity — used in dental carousels
const TOOTH_PATH =
  'M12 2C8.5 2 6 4 5 7c-.8 2.4-.7 5 0 8 .6 2.6 1.4 5 2.8 6.4.7.7 1.7.7 2.2-.3.5-1.1.9-2.4 2-2.4s1.5 1.3 2 2.4c.5 1 1.5 1 2.2.3 1.4-1.4 2.2-3.8 2.8-6.4.7-3 .8-5.6 0-8-1-3-3.5-5-7-5z';

const DENTAL_CHAIR_PATH =
  'M3 18h18v2H3v-2zm2-2v-3a4 4 0 014-4h6a4 4 0 014 4v3H5zm2-2h8v-1a2 2 0 00-2-2H9a2 2 0 00-2 2v1zM8 4h8v3H8V4z';

const DENTAL_IMPLANT_PATH =
  'M9 2h6l-1 4h-4L9 2zm1 6h4l-.4 3h-3.2L10 8zm-1 4h6l-1 10h-4l-1-10z';

const DENTAL_BRUSH_PATH =
  'M7 2h2v6l3 1 3-1V2h2v6.5L13 10v3l3 1v8h-2v-7l-3-1-3 1v7H6v-8l3-1v-3L7 8.5V2z';

// Sparkle / star — decorative
const SPARKLE_PATH =
  'M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z';

const DENTAL_TEMPLATES = {
  TOOTH_PATH,
  DENTAL_CHAIR_PATH,
  DENTAL_IMPLANT_PATH,
  DENTAL_BRUSH_PATH,
  SPARKLE_PATH,
};

// ---- Registry -------------------------------------------------------------
export const CANVAS_ICONS: CanvasIcon[] = [
  // Dental
  {
    name: 'tooth',
    label: 'Tooth',
    labelAr: 'سنّ',
    viewBox: '0 0 24 24',
    paths: [TOOTH_PATH],
    hex: '38bdf8',
    category: 'dental',
  },
  {
    name: 'dental-chair',
    label: 'Dental Chair',
    labelAr: 'كرسي الأسنان',
    viewBox: '0 0 24 24',
    paths: [DENTAL_CHAIR_PATH],
    hex: '22d3ee',
    category: 'dental',
  },
  {
    name: 'implant',
    label: 'Implant',
    labelAr: 'زرعة',
    viewBox: '0 0 24 24',
    paths: [DENTAL_IMPLANT_PATH],
    hex: 'a78bfa',
    category: 'dental',
  },
  {
    name: 'brush',
    label: 'Toothbrush',
    labelAr: 'فرشاة',
    viewBox: '0 0 24 24',
    paths: [DENTAL_BRUSH_PATH],
    hex: '34d399',
    category: 'dental',
  },
  {
    name: 'sparkle',
    label: 'Sparkle',
    labelAr: 'بريق',
    viewBox: '0 0 24 24',
    paths: [SPARKLE_PATH],
    hex: 'fbbf24',
    category: 'dental',
  },
  // Medical (lucide-equivalent paths, hand-authored)
  {
    name: 'smile',
    label: 'Smile',
    labelAr: 'ابتسامة',
    viewBox: '0 0 24 24',
    paths: [
      'M12 2a10 10 0 100 20 10 10 0 000-20zM8 9.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm8 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm-4 4c2.2 0 4 1.3 4.7 3H7.3c.7-1.7 2.5-3 4.7-3z',
    ],
    hex: 'f472b6',
    category: 'medical',
  },
  {
    name: 'heart',
    label: 'Heart',
    labelAr: 'قلب',
    viewBox: '0 0 24 24',
    paths: ['M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.2 1.2 4 2.4.8-1.2 2-2.4 4-2.4 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z'],
    hex: 'f87171',
    category: 'medical',
  },
  {
    name: 'stethoscope',
    label: 'Stethoscope',
    labelAr: 'سماعة',
    viewBox: '0 0 24 24',
    paths: [
      'M5 3v6a4 4 0 008 0V3h-2v6a2 2 0 11-4 0V3H5zm12 7a4 4 0 00-2 7.4V19a3 3 0 01-6 0v-2h2v2a1 1 0 102 0v-1.6A4 4 0 0017 10zm0 2a2 2 0 100 4 2 2 0 000-4z',
    ],
    hex: '34d399',
    category: 'medical',
  },
  // Social brands
  brand('instagram', siInstagram, 'إنستغرام'),
  brand('tiktok', siTiktok, 'تيك توك'),
  brand('youtube', siYoutube, 'يوتيوب'),
  brand('facebook', siFacebook, 'فيسبوك'),
  brand('whatsapp', siWhatsapp, 'واتساب'),
  brand('x', siX, 'إكس'),
  brand('snapchat', siSnapchat, 'سناب شات'),
  brand('telegram', siTelegram, 'تيليجرام'),
];

/** Quick lookup map */
export const ICON_MAP: Record<string, CanvasIcon> = Object.fromEntries(
  CANVAS_ICONS.map((i) => [i.name, i]),
);

/** Get a canvas icon by name (returns the tooth icon as a safe fallback) */
export function getIcon(name: string): CanvasIcon {
  return ICON_MAP[name] ?? CANVAS_ICONS[0];
}

/** Draw an icon onto a 2D canvas context. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  icon: CanvasIcon,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const [vx, vy, vw, vh] = icon.viewBox.split(' ').map(Number);
  const scale = size / Math.max(vw, vh);
  ctx.save();
  ctx.translate(cx - (size / 2), cy - (size / 2));
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const d of icon.paths) {
    // Use Path2D for robust path parsing (handles all SVG path commands)
    const p = new Path2D(d);
    ctx.fill(p);
  }
  // Reset translate: ensure the next fill draws at translated origin
  void vx; void vy; void vh;
  ctx.restore();
}

export { DENTAL_TEMPLATES };
