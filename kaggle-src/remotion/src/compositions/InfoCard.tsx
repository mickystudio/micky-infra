import React from 'react';
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import type { InfoCardProps } from '../types';
import { Icon } from '../components/Icon';
import { MICKY_THEME, FONTS } from '../theme';

/**
 * InfoCard — animated info card that slides in from the right.
 *
 * Visual spec:
 *   - Dental-themed: blue/white palette
 *   - Title + bullet points
 *   - Slides in (spring) from the right edge, auto-dismisses (fade out)
 *     after `card.duration` seconds (default 5s)
 *   - Triggered by `card.start` (seconds)
 */
export const InfoCard: React.FC<InfoCardProps> = ({
  card,
  position = 'right',
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const cardWidth = Math.min(540, width * 0.55);
  const startFrame = Math.round(card.start * fps);
  const durationFrames = Math.round((card.duration ?? 5) * fps);
  const endFrame = startFrame + durationFrames;

  const localFrame = frame - startFrame;

  // Entrance spring (slide from right)
  const slideInX = spring({
    frame: localFrame,
    fps,
    config: { damping: 18, mass: 0.7, stiffness: 120 },
  });
  const slideOut = interpolate(
    localFrame,
    [durationFrames - 12, durationFrames],
    [0, cardWidth + 60],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const exitOpacity = interpolate(
    localFrame,
    [durationFrames - 12, durationFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const xOffset = (1 - slideInX) * (cardWidth + 80) + slideOut;

  // Position (left / right / center) + RTL-aware margin
  const positionStyle: React.CSSProperties =
    position === 'left'
      ? { left: 32, right: 'auto', alignItems: card.rtl ? 'flex-end' : 'flex-start' }
      : position === 'center'
      ? { left: '50%', transform: `translateX(-50%)` }
      : { right: 32, left: 'auto', alignItems: card.rtl ? 'flex-end' : 'flex-start' };

  const accent = card.accentColor ?? MICKY_THEME.brandBlue;

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        pointerEvents: 'none',
        opacity: exitOpacity,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '38%',
          width: cardWidth,
          backgroundColor: 'rgba(255,255,255,0.96)',
          borderRadius: 24,
          padding: '28px 32px',
          boxShadow: `0 12px 40px rgba(0,0,0,0.35), 0 0 0 2px ${accent}55 inset`,
          transform: `translateX(${position === 'right' ? xOffset : -xOffset}px)`,
          direction: card.rtl ? 'rtl' : 'ltr',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          fontFamily: FONTS.cairoBold,
          ...positionStyle,
        }}
      >
        {/* Accent stripe */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [card.rtl ? 'left' : 'right']: 0,
            width: 8,
            backgroundColor: accent,
            borderRadius: card.rtl ? '24px 0 0 24px' : '0 24px 24px 0',
          }}
        />
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name={card.icon ?? 'Stethoscope'} size={40} color={accent} animation="rotate-in" durationInFrames={20} />
          <div style={{ fontSize: 34, fontWeight: 800, color: MICKY_THEME.black }}>{card.title}</div>
        </div>
        {/* Bullets */}
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {card.bullets.map((bullet, i) => {
            const bulletOpacity = interpolate(
              localFrame,
              [12 + i * 6, 18 + i * 6],
              [0, 1],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            const bulletX = interpolate(
              localFrame,
              [12 + i * 6, 18 + i * 6],
              [card.rtl ? 20 : -20, 0],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            return (
              <li
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 22,
                  color: '#1A1A1A',
                  fontFamily: FONTS.tajawal,
                  fontWeight: 600,
                  opacity: bulletOpacity,
                  transform: `translateX(${bulletX}px)`,
                }}
              >
                <span style={{ color: accent, fontSize: 24, fontWeight: 900 }}>●</span>
                <span>{bullet}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </AbsoluteFill>
  );
};
