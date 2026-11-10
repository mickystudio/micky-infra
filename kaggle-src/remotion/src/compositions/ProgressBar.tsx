import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { ProgressBarProps } from '../types';
import { MICKY_THEME, FONTS } from '../theme';

/**
 * ProgressBar — bottom progress bar (YouTube-style) for the montage video.
 *
 * Visual spec:
 *   - Brand color: #0066FF (default)
 *   - Height: 6px (default), 1080px-wide canvas
 *   - Smooth linear interpolation from 0 → 100% across the composition
 *   - Chapter markers rendered as small vertical ticks above the bar
 *   - Subtle "shimmer" highlight at the leading edge
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  color = MICKY_THEME.brandBlue,
  height = 6,
  chapters = [],
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fillWidth = Math.round(progress * width);

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'stretch',
        pointerEvents: 'none',
      }}
    >
      {/* Chapter marker labels (above the bar) */}
      {chapters.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: height + 4,
            left: 0,
            right: 0,
            height: 24,
            display: 'flex',
            direction: 'ltr',
          }}
        >
          {chapters.map((chapter, i) => {
            const chapterStartFrame = Math.round(chapter.start * fps);
            const chapterProgress = chapterStartFrame / durationInFrames;
            const x = chapterProgress * width;
            const visible = frame >= chapterStartFrame - 5;
            const opacity = interpolate(
              frame,
              [chapterStartFrame - 5, chapterStartFrame + 5],
              [0, 1],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: x,
                  transform: 'translateX(-50%)',
                  opacity: visible ? opacity : 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    width: 2,
                    height: 8,
                    backgroundColor: chapter.color ?? MICKY_THEME.white,
                    opacity: 0.85,
                  }}
                />
                {chapter.label && (
                  <div
                    style={{
                      fontFamily: FONTS.cairoBold,
                      fontSize: 14,
                      color: MICKY_THEME.white,
                      textShadow: `0 1px 4px ${MICKY_THEME.black}`,
                      whiteSpace: 'nowrap',
                      marginTop: 2,
                    }}
                  >
                    {chapter.label}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Background track */}
      <div
        style={{
          width: '100%',
          height,
          backgroundColor: 'rgba(0,0,0,0.5)',
          position: 'relative',
        }}
      >
        {/* Filled portion */}
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            backgroundColor: color,
            transition: 'width 0.03s linear',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Leading-edge shimmer */}
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 32,
              background: `linear-gradient(90deg, transparent, rgba(255,255,255,0.65))`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
