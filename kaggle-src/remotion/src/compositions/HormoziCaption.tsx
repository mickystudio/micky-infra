import React from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import type { HormoziCaptionProps } from '../types';
import { MICKY_THEME, FONTS, DENTAL_KEYWORD_EMOJIS } from '../theme';

/**
 * HormoziCaption — Hormozi-style word-by-word caption.
 *
 * Visual spec:
 *   - Large bold text (default 90px)
 *   - Yellow color (#FFD700) with black outline via text-shadow
 *   - Cairo-Bold font (Arabic RTL support)
 *   - Spring animation on each word: scale up when "active"
 *   - Position: bottom-center (above progress bar)
 *   - Emoji support for dental keywords (whitening ✨, implant 🦷, etc.)
 *
 * The component accepts `words` with start/end times in SECONDS (relative
 * to the start of this phrase if `start` is provided). When used inside
 * DynamicComposition, the parent already scopes to active phrase.
 */
export const HormoziCaption: React.FC<HormoziCaptionProps> = ({
  words,
  start = 0,
  rtl = true,
  fontSize = 90,
  highlightColor = MICKY_THEME.captionYellow,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Convert phrase-relative seconds → frames (absolute frame in this comp)
  const startFrameOffset = Math.round(start * fps);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '0.35em',
        maxWidth: '92%',
        direction: rtl ? 'rtl' : 'ltr',
        fontFamily: FONTS.cairoBold,
        fontSize,
        fontWeight: 800,
        color: highlightColor,
        textAlign: 'center',
        lineHeight: 1.15,
        // Black outline (Hormozi-style)
        textShadow: [
          `-3px -3px 0 ${MICKY_THEME.captionOutline}`,
          `3px -3px 0 ${MICKY_THEME.captionOutline}`,
          `-3px 3px 0 ${MICKY_THEME.captionOutline}`,
          `3px 3px 0 ${MICKY_THEME.captionOutline}`,
          `-3px 0 0 ${MICKY_THEME.captionOutline}`,
          `3px 0 0 ${MICKY_THEME.captionOutline}`,
          `0 -3px 0 ${MICKY_THEME.captionOutline}`,
          `0 3px 0 ${MICKY_THEME.captionOutline}`,
          `0 4px 16px rgba(0,0,0,0.85)`,
        ].join(', '),
        WebkitTextStroke: `2px ${MICKY_THEME.captionOutline}`,
      }}
    >
      {words.map((word, i) => {
        const wordStartFrame = startFrameOffset + Math.round(word.start * fps);
        const wordEndFrame = startFrameOffset + Math.round(word.end * fps);

        // Pre-spoken: invisible
        const enterOpacity = interpolate(
          frame,
          [wordStartFrame - 1, wordStartFrame + 2],
          [0, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
        // Post-spoken: dim slightly so the active word stands out
        const fadeOut = interpolate(
          frame,
          [wordEndFrame, wordEndFrame + 8],
          [1, 0.6],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );

        const isActive = frame >= wordStartFrame && frame <= wordEndFrame + 4;
        // Triangle wave: 0 → 1 → 0 across the word's spoken window
        const progressInsideWord =
          Math.abs(
            (frame - wordStartFrame) / Math.max(wordEndFrame - wordStartFrame, 1) - 0.5
          ) * 2; // 0 at center, 1 at edges
        const scale = isActive ? 1 + 0.22 * (1 - progressInsideWord) : 1;

        const emoji = word.emoji ?? DENTAL_KEYWORD_EMOJIS[word.text.toLowerCase()];
        const wordColor = word.color ?? (emoji ? highlightColor : MICKY_THEME.white);

        return (
          <span
            key={`${word.text}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.1em',
              transform: `scale(${scale})`,
              opacity: enterOpacity * fadeOut,
              color: wordColor,
              transition: 'color 80ms linear',
            }}
          >
            {word.text}
            {emoji ? (
              <span style={{ fontSize: fontSize * 0.9, marginLeft: 4 }}>
                {emoji}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
};
