import React from 'react';
import { Composition } from 'remotion';
import { DynamicComposition } from './DynamicComposition';
import { HormoziCaption } from './compositions/HormoziCaption';
import { InfoCard } from './compositions/InfoCard';
import { ProgressBar } from './compositions/ProgressBar';
import { DentalBroll } from './compositions/DentalBroll';
import type {
  DynamicCompositionProps,
  HormoziCaptionProps,
  InfoCardProps,
  ProgressBarProps,
  DentalBrollProps,
} from './types';

/**
 * RemotionRoot — registers every composition available to the renderer.
 *
 * Compositions:
 *   - DynamicComposition : full montage pipeline (background video + overlays)
 *   - HormoziCaption     : standalone Hormozi-style caption phrase (test/dev)
 *   - InfoCard           : standalone animated info card (test/dev)
 *   - ProgressBar        : standalone progress bar (test/dev)
 *   - DentalBroll        : standalone dental B-roll overlay (test/dev)
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DynamicComposition"
        component={DynamicComposition}
        // 30s at 30fps. The Python generator overrides durationInFrames
        // based on the actual video length via `calculateMetadata`.
        durationInFrames={900}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultDynamicProps}
      />
      <Composition
        id="HormoziCaption"
        component={HormoziCaption}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultHormoziProps}
      />
      <Composition
        id="InfoCard"
        component={InfoCard}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultInfoCardProps}
      />
      <Composition
        id="ProgressBar"
        component={ProgressBar}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProgressBarProps}
      />
      <Composition
        id="DentalBroll"
        component={DentalBroll}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultDentalBrollProps}
      />
    </>
  );
};

// ----- Default props used by Remotion Studio for previews ----------

const defaultDynamicProps: DynamicCompositionProps = {
  videoPath: '/assets/sample/background.mp4',
  captions: [
    {
      words: [
        { text: 'مرحبًا', start: 0, end: 0.4 },
        { text: 'في', start: 0.4, end: 0.7 },
        { text: 'عيادة', start: 0.7, end: 1.1 },
        { text: 'ميكي', start: 1.1, end: 1.5, emoji: '🦷' },
      ],
    },
    {
      words: [
        { text: 'تبييض', start: 2.0, end: 2.5, emoji: '✨', color: '#FFD700' },
        { text: 'احترافي', start: 2.5, end: 3.0 },
      ],
    },
  ],
  infoCards: [
    {
      id: 'card-1',
      start: 2,
      duration: 5,
      title: 'تبييض الأسنان',
      bullets: ['نتائج فورية', 'آمن 100%', ' بدون ألم'],
      icon: 'Sparkles',
      rtl: true,
    },
  ],
  broll: [
    {
      id: 'broll-1',
      start: 4,
      duration: 3,
      variant: 'tooth-rotate',
      position: 'center',
      label: 'زراعة الأسنان',
    },
  ],
  chapters: [
    { start: 0, label: 'المقدمة' },
    { start: 10, label: 'العرض' },
    { start: 25, label: 'النهاية' },
  ],
  options: {
    showCaptions: true,
    showProgressBar: true,
    showInfoCards: true,
    showBroll: true,
    showWatermark: true,
    showEndCard: false,
    rtl: true,
    brandColor: '#0066FF',
    captionColor: '#FFD700',
  },
};

const defaultHormoziProps: HormoziCaptionProps = {
  words: [
    { text: 'تبييض', start: 0, end: 0.5, emoji: '✨', color: '#FFD700' },
    { text: 'الأسنان', start: 0.5, end: 1.0 },
    { text: 'في', start: 1.0, end: 1.3 },
    { text: 'جلسة', start: 1.3, end: 1.7 },
    { text: 'واحدة', start: 1.7, end: 2.0 },
  ],
  start: 0,
  rtl: true,
  fontSize: 90,
  highlightColor: '#FFD700',
};

const defaultInfoCardProps: InfoCardProps = {
  card: {
    id: 'demo-card',
    start: 0,
    duration: 5,
    title: 'زراعة الأسنان',
    bullets: [
      'تقنية حديثة All-on-4',
      'ضمان 10 سنوات',
      'نتيجة طبيعية 100%',
    ],
    icon: 'Tooth',
    rtl: true,
  },
  position: 'right',
};

const defaultProgressBarProps: ProgressBarProps = {
  color: '#0066FF',
  height: 6,
  chapters: [
    { start: 0, label: 'Intro' },
    { start: 5, label: 'Main' },
    { start: 8, label: 'Outro' },
  ],
};

const defaultDentalBrollProps: DentalBrollProps = {
  broll: {
    id: 'demo-broll',
    start: 0,
    duration: 4,
    variant: 'tooth-rotate',
    position: 'center',
    label: 'ميكي',
  },
};
