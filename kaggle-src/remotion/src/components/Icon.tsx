import React from 'react';
import {
  spring,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import * as LucideIcons from 'lucide-react';
import type { IconProps } from '../types';

type LucideIconComponent = React.FC<{
  size?: number | string;
  color?: string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  fill?: string;
  style?: React.CSSProperties;
}>;

/**
 * Icon — wrapper around lucide-react with Remotion-driven entrance animations.
 *
 * Props:
 *   - name            : lucide-react icon name (PascalCase, e.g. "Tooth")
 *   - size            : pixel size (default 48)
 *   - color           : stroke color (default #0066FF)
 *   - animation       : 'rotate-in' | 'bounce' | 'fade' | 'none'
 *   - durationInFrames: animation length (default 15)
 *
 * Usage:
 *   <Icon name="Tooth" size={120} color="#0066FF" animation="bounce" />
 */
export const Icon: React.FC<IconProps> = ({
  name,
  size = 48,
  color = '#0066FF',
  animation = 'none',
  durationInFrames = 15,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const LucideIcon = (LucideIcons as unknown as Record<string, LucideIconComponent>)[name]
    ?? (LucideIcons as unknown as Record<string, LucideIconComponent>).Stethoscope;

  // ---- Animation transforms ----
  let transform = '';
  let opacity = 1;

  if (animation !== 'none') {
    const t = interpolate(frame, [0, durationInFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    if (animation === 'rotate-in') {
      const rotation = interpolate(t, [0, 1], [-180, 0]);
      const scale = spring({
        frame,
        fps,
        config: { damping: 12, mass: 0.6, stiffness: 120 },
      });
      transform = `rotate(${rotation}deg) scale(${scale})`;
      opacity = Math.min(scale * 1.2, 1);
    } else if (animation === 'bounce') {
      const scale = spring({
        frame,
        fps,
        config: { damping: 8, mass: 0.7, stiffness: 200 },
      });
      const translateY = interpolate(t, [0, 0.5, 1], [-20, 0, 0]);
      transform = `scale(${scale}) translateY(${translateY}px)`;
      opacity = Math.min(t * 2, 1);
    } else if (animation === 'fade') {
      opacity = interpolate(t, [0, 1], [0, 1]);
    }
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform,
        opacity,
        color,
      }}
    >
      <LucideIcon size={size} color={color} strokeWidth={2.2} />
    </span>
  );
};
