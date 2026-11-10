/**
 * Shared type contracts between Remotion components and the Python
 * dynamic generator (`kaggle-src/montage/remotion_renderer.py`).
 *
 * The Python generator emits a JSON props file that is consumed by the
 * DynamicComposition. These types MUST stay in sync with that generator.
 */

/** A single word in a word-level transcript (Whisper output). */
export interface CaptionWord {
  /** Word text (may include Arabic / emoji). */
  text: string;
  /** Start time in seconds (relative to video start). */
  start: number;
  /** End time in seconds (relative to video start). */
  end: number;
  /** Optional confidence 0..1 from Whisper. */
  confidence?: number;
  /** Optional emoji to render beside the word (dental keyword trigger). */
  emoji?: string;
  /** Optional highlight color override (e.g. for "تبييض" → yellow). */
  color?: string;
}

/** A caption group is one "phrase" displayed on screen at a time. */
export interface CaptionGroup {
  /** Words that appear together on screen. */
  words: CaptionWord[];
  /** Optional override for on-screen layout. */
  align?: 'left' | 'center' | 'right';
}

/** An info card that slides in at a specific timestamp. */
export interface InfoCardData {
  /** Stable id (used as React key). */
  id: string;
  /** Trigger time in seconds. */
  start: number;
  /** Auto-dismiss after this many seconds (default 5). */
  duration?: number;
  /** Card title (Arabic or English). */
  title: string;
  /** Bullet points (1–4). */
  bullets: string[];
  /** Optional icon name (lucide-react). */
  icon?: string;
  /** Optional accent color override. Defaults to dental blue. */
  accentColor?: string;
  /** RTL if true. */
  rtl?: boolean;
}

/** A B-roll animation overlay (tooth, x-ray, before/after). */
export interface BrollData {
  id: string;
  /** Trigger time in seconds. */
  start: number;
  /** Duration in seconds. */
  duration?: number;
  /** Animation variant. */
  variant: 'tooth-rotate' | 'x-ray' | 'before-after' | 'diagram-annot';
  /** Position on screen. */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  /** Optional label text. */
  label?: string;
}

/** A progress bar segment / chapter marker. */
export interface ChapterMarker {
  /** Start time in seconds. */
  start: number;
  /** Optional label. */
  label?: string;
  /** Optional color override. */
  color?: string;
}

/** Top-level options for the dynamic composition. */
export interface MontageOptions {
  /** Show the Hormozi-style captions. */
  showCaptions?: boolean;
  /** Show the bottom progress bar. */
  showProgressBar?: boolean;
  /** Show info cards at key moments. */
  showInfoCards?: boolean;
  /** Show dental B-roll overlays. */
  showBroll?: boolean;
  /** Show a brand watermark / logo. */
  showWatermark?: boolean;
  /** Show end-card with social handles. */
  showEndCard?: boolean;
  /** Render captions Right-To-Left (Arabic). */
  rtl?: boolean;
  /** Brand primary color (default #0066FF). */
  brandColor?: string;
  /** Caption highlight color (default #FFD700). */
  captionColor?: string;
  /** Logo image path or URL (optional). */
  logoPath?: string;
  /** Social handles for end-card. */
  socialHandles?: Partial<Record<'instagram' | 'tiktok' | 'youtube' | 'whatsapp' | 'facebook', string>>;
}

/** Props passed from Python generator to DynamicComposition. */
export type DynamicCompositionProps = {
  /** Absolute path (or URL) to the background video. */
  videoPath: string;
  /** Word-level captions grouped into phrases. */
  captions: CaptionGroup[];
  /** Info cards triggered at specific timestamps. */
  infoCards?: InfoCardData[];
  /** B-roll overlays. */
  broll?: BrollData[];
  /** Chapter markers on the progress bar. */
  chapters?: ChapterMarker[];
  /** Global montage options. */
  options?: MontageOptions;
} & Record<string, unknown>;

/** Word-by-word animated text props. */
export type AnimatedTextProps = {
  /** Words to render (each gets its own spring). */
  words: CaptionWord[];
  /** Animation style per word. */
  animationType?: 'spring' | 'fade' | 'slide';
  /** Render direction. */
  rtl?: boolean;
  /** Base font family (Cairo for Arabic). */
  fontFamily?: string;
  /** Base font size in px. */
  fontSize?: number;
  /** Base text color. */
  color?: string;
  /** Optional emoji map for dental keywords (keyword → emoji). */
  keywordEmojiMap?: Record<string, string>;
} & Record<string, unknown>;

/** Lucide icon name + size/color. */
export type IconProps = {
  name: string;
  size?: number;
  color?: string;
  /** Animation type for entrance. */
  animation?: 'rotate-in' | 'bounce' | 'fade' | 'none';
  /** Animation duration in frames. */
  durationInFrames?: number;
} & Record<string, unknown>;

/** Brand logo props. */
export type BrandLogoProps = {
  /** Which social platform. */
  platform: 'instagram' | 'tiktok' | 'youtube' | 'whatsapp' | 'facebook';
  /** Logo size in px (square). */
  size?: number;
  /** Entrance animation. */
  animation?: 'pop' | 'slide-up' | 'fade' | 'none';
  /** Optional delay in frames. */
  delayInFrames?: number;
  /** Optional color override (defaults to brand color). */
  color?: string;
} & Record<string, unknown>;

/** Hormozi-style caption props (single phrase). */
export type HormoziCaptionProps = {
  words: CaptionWord[];
  /** Phrase start in seconds. */
  start?: number;
  /** Render direction (Arabic RTL). */
  rtl?: boolean;
  /** Font size in px (default 90). */
  fontSize?: number;
  /** Highlight color. */
  highlightColor?: string;
} & Record<string, unknown>;

/** InfoCard component props. */
export type InfoCardProps = {
  card: InfoCardData;
  /** Optional position override. */
  position?: 'left' | 'right' | 'center';
} & Record<string, unknown>;

/** ProgressBar component props. */
export type ProgressBarProps = {
  /** Brand color. */
  color?: string;
  /** Bar height in px (default 6). */
  height?: number;
  /** Optional chapter markers. */
  chapters?: ChapterMarker[];
} & Record<string, unknown>;

/** DentalBroll component props. */
export type DentalBrollProps = {
  broll: BrollData;
} & Record<string, unknown>;
