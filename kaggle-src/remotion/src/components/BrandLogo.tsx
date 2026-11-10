import React from 'react';
import { spring, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { BrandLogoProps } from '../types';
import { MICKY_THEME } from '../theme';

/**
 * BrandLogo — social media brand logos using inline SVG paths (no extra deps).
 *
 * Supports: instagram, tiktok, youtube, whatsapp, facebook
 *
 * Each logo is rendered as a colored rounded-square tile with the brand SVG
 * glyph inside. The tile animates in via a configurable entrance.
 *
 * Usage:
 *   <BrandLogo platform="instagram" size={80} animation="pop" />
 */

const BRAND_COLORS: Record<BrandLogoProps['platform'], string> = {
  instagram: '#E1306C',
  tiktok: '#000000',
  youtube: '#FF0000',
  whatsapp: '#25D366',
  facebook: '#1877F2',
};

/** SVG path data for each platform's logo glyph (24×24 viewBox). */
const GLYPHS: Record<BrandLogoProps['platform'], React.ReactNode> = {
  instagram: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.5" cy="6.5" r="1.4" fill="currentColor" />
    </>
  ),
  tiktok: (
    <path
      d="M16 3c.4 2.4 2.1 4.3 4.5 4.6v3c-1.7 0-3.3-.5-4.5-1.3v6.4c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6c.4 0 .7 0 1 .1v3.1c-.3-.1-.6-.2-1-.2-1.6 0-2.9 1.3-2.9 2.9s1.3 2.9 2.9 2.9 2.9-1.3 2.9-2.9V3H16z"
      fill="currentColor"
    />
  ),
  youtube: (
    <path
      d="M21.6 7.2c-.2-.9-.9-1.6-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4c-.9.2-1.6.9-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8c.2.9.9 1.6 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3-5.2 3z"
      fill="currentColor"
    />
  ),
  whatsapp: (
    <path
      d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 5L2 22l5.2-1.3c1.4.8 3 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm0 18c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-2.4.6.6-2.3-.2-.3C4.4 15.2 4 13.6 4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8zm4.4-5.6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.7.9-.1.1-.3.2-.5 0-.2-.1-1-.4-1.9-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.4.1-.5.1-.1.2-.3.4-.4.1-.1.2-.2.2-.4.1-.2 0-.3 0-.4-.1-.1-.5-1.3-.7-1.8-.2-.4-.4-.4-.5-.4h-.5c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.3c.1.2 1.6 2.5 4 3.5.6.2 1 .4 1.3.5.5.2 1 .1 1.4.1.4-.1 1.4-.6 1.6-1.1.2-.5.2-1 .1-1.1-.1-.1-.2-.1-.4-.2z"
      fill="currentColor"
    />
  ),
  facebook: (
    <path
      d="M22 12c0-5.5-4.5-10-10-10S2 6.5 2 12c0 5 3.7 9.1 8.4 9.9v-7H8v-2.9h2.4V9.8c0-2.4 1.4-3.7 3.5-3.7 1 0 2.1.2 2.1.2v2.3h-1.2c-1.2 0-1.5.7-1.5 1.5v1.8h2.6l-.4 2.9h-2.2v7c4.7-.8 8.2-4.9 8.2-9.9z"
      fill="currentColor"
    />
  ),
};

export const BrandLogo: React.FC<BrandLogoProps> = ({
  platform,
  size = 64,
  animation = 'pop',
  delayInFrames = 0,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = frame - delayInFrames;
  const brandColor = color ?? BRAND_COLORS[platform];

  // ---- Entrance animations ----
  let transform = '';
  let opacity = 1;

  if (animation !== 'none' && localFrame >= 0) {
    if (animation === 'pop') {
      const scale = spring({
        frame: localFrame,
        fps,
        config: { damping: 10, mass: 0.6, stiffness: 180 },
      });
      transform = `scale(${scale})`;
      opacity = Math.min(scale * 1.3, 1);
    } else if (animation === 'slide-up') {
      const translateY = interpolate(localFrame, [0, 15], [40, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      const scale = spring({
        frame: localFrame,
        fps,
        config: { damping: 12, mass: 0.6, stiffness: 160 },
      });
      transform = `translateY(${translateY}px) scale(${scale})`;
      opacity = Math.min(localFrame / 10, 1);
    } else if (animation === 'fade') {
      opacity = interpolate(localFrame, [0, 15], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
  } else if (localFrame < 0) {
    opacity = 0;
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: `linear-gradient(135deg, ${brandColor}, ${brandColor}cc)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 8px 24px ${brandColor}88, 0 0 0 2px rgba(255,255,255,0.12) inset`,
        transform,
        opacity,
        color: MICKY_THEME.white,
      }}
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
      >
        {GLYPHS[platform]}
      </svg>
    </div>
  );
};
