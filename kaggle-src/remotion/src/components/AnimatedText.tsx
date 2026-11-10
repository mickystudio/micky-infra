import React from 'react';
import { spring, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { AnimatedTextProps } from '../types';
import { MICKY_THEME, FONTS, DENTAL_KEYWORD_EMOJIS } from '../theme';

/**
 * AnimatedText — word-by-word animated text with Arabic RTL support.
 *
 * Props:
 *   - words         : CaptionWord[] (each gets its own animation timing)
 *   - animationType : 'spring' | 'fade' | 'slide'
 *   - rtl           : direction (Arabic = true)
 *   - fontFamily    : CSS font-family string
 *   - fontSize      : px size
 *   - color         : base text color
 *   - keywordEmojiMap: optional override of dental keyword emojis
 *
 * The active word (one whose start ≤ frame ≤ end) gets a scale boost.
 */
export const AnimatedText: React.FC<AnimatedTextProps> = ({
  words,
  animationType = 'spring',
  rtl = false,
  fontFamily = FONTS.cairoBold,
  fontSize = 80,
  color = MICKY_THEME.white,
  keywordEmojiMap,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const emojiMap = keywordEmojiMap ?? DENTAL_KEYWORD_EMOJIS;

  return (
    <span
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: '0.35em',
        direction: rtl ? 'rtl' : 'ltr',
        fontFamily,
        fontSize,
        fontWeight: 800,
        color,
        textAlign: 'center',
        lineHeight: 1.15,
      }}
    >
      {words.map((word, i) => {
        const startFrame = Math.round(word.start * fps);
        const endFrame = Math.round(word.end * fps);
        const localFrame = frame - startFrame;

        let opacity = 1;
        let scale = 1;
        let translateY = 0;

        if (localFrame < 0) {
          // Pre-spoken: invisible
          opacity = 0;
        } else if (localFrame <= endFrame - startFrame + 6) {
          // Active word window
          if (animationType === 'spring') {
            const s = spring({
              frame: localFrame,
              fps,
              config: { damping: 12, mass: 0.6, stiffness: 220 },
            });
            scale = 0.7 + 0.5 * s;
            opacity = Math.min(s, 1);
          } else if (animationType === 'fade') {
            opacity = interpolate(localFrame, [0, 6], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
          } else if (animationType === 'slide') {
            opacity = interpolate(localFrame, [0, 6], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            translateY = interpolate(localFrame, [0, 8], [40, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
          }
        } else {
          // Post-spoken: dim slightly
          opacity = 0.7;
          scale = 1;
        }

        const emoji = word.emoji ?? emojiMap[word.text.toLowerCase()];
        const wordColor = word.color ?? color;

        return (
          <span
            key={`${word.text}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.1em',
              transform: `scale(${scale}) translateY(${translateY}px)`,
              opacity,
              color: wordColor,
              transition: 'color 80ms linear, opacity 80ms linear',
            }}
          >
            {word.text}
            {emoji ? (
              <span style={{ fontSize: fontSize * 0.9, marginLeft: 4 }}>{emoji}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
};
