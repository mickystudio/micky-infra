import React from 'react';
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import type { DentalBrollProps } from '../types';
import { Icon } from '../components/Icon';
import { MICKY_THEME, FONTS } from '../theme';

/**
 * DentalBroll — animated dental B-roll overlays.
 *
 * Variants:
 *   - 'tooth-rotate'  : giant tooth icon rotates in & scales up
 *   - 'x-ray'         : white-on-blue x-ray style overlay with scan lines
 *   - 'before-after'  : split-screen before/after effect
 *   - 'diagram-annot' : tooth with annotation lines + label
 *
 * Each variant animates in via spring, holds, then fades out.
 */
export const DentalBroll: React.FC<DentalBrollProps> = ({ broll }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const startFrame = Math.round(broll.start * fps);
  const durationFrames = Math.round((broll.duration ?? 3) * fps);
  const localFrame = frame - startFrame;

  if (localFrame < 0 || localFrame > durationFrames + 15) {
    return null;
  }

  // Common fade in/out
  const fadeIn = interpolate(localFrame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(
    localFrame,
    [durationFrames - 8, durationFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const opacity = Math.min(fadeIn, fadeOut);

  // Position mapping
  const posStyle: React.CSSProperties = (() => {
    switch (broll.position ?? 'center') {
      case 'top-left':
        return { justifyContent: 'flex-start', alignItems: 'flex-start', padding: '120px 32px 0 32px' };
      case 'top-right':
        return { justifyContent: 'flex-end', alignItems: 'flex-start', padding: '120px 32px 0 32px' };
      case 'bottom-left':
        return { justifyContent: 'flex-start', alignItems: 'flex-end', padding: '0 32px 180px 32px' };
      case 'bottom-right':
        return { justifyContent: 'flex-end', alignItems: 'flex-end', padding: '0 32px 180px 32px' };
      case 'center':
      default:
        return { justifyContent: 'center', alignItems: 'center' };
    }
  })();

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        opacity,
        ...posStyle,
      }}
    >
      {broll.variant === 'tooth-rotate' && (
        <ToothRotate frame={localFrame} fps={fps} label={broll.label} />
      )}
      {broll.variant === 'x-ray' && (
        <XRayOverlay frame={localFrame} fps={fps} durationFrames={durationFrames} width={width} height={height} />
      )}
      {broll.variant === 'before-after' && (
        <BeforeAfter frame={localFrame} fps={fps} width={width} />
      )}
      {broll.variant === 'diagram-annot' && (
        <DiagramAnnot frame={localFrame} fps={fps} label={broll.label} />
      )}
    </AbsoluteFill>
  );
};

// ----------------- Variants -----------------------------------------

const ToothRotate: React.FC<{ frame: number; fps: number; label?: string }> = ({ frame, fps, label }) => {
  const scaleSpring = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.8, stiffness: 120 },
  });
  const rotation = interpolate(frame, [0, 30], [-180, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div
        style={{
          transform: `scale(${scaleSpring}) rotate(${rotation}deg)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 200,
          height: 200,
          backgroundColor: 'rgba(255,255,255,0.9)',
          borderRadius: 100,
          boxShadow: `0 0 60px ${MICKY_THEME.brandBlue}cc`,
        }}
      >
        <Icon name="Tooth" size={120} color={MICKY_THEME.brandBlue} animation="none" />
      </div>
      {label && (
        <div
          style={{
            fontFamily: FONTS.cairoBold,
            fontSize: 38,
            fontWeight: 800,
            color: MICKY_THEME.white,
            textShadow: `0 2px 12px ${MICKY_THEME.black}`,
            direction: 'rtl',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
};

const XRayOverlay: React.FC<{
  frame: number;
  fps: number;
  durationFrames: number;
  width: number;
  height: number;
}> = ({ frame, fps, durationFrames, width, height }) => {
  const scanY = interpolate(frame, [0, durationFrames], [0, height], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'rgba(0,40,90,0.55)',
        mixBlendMode: 'screen',
      }}
    >
      {/* Scan line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: scanY,
          height: 4,
          background: `linear-gradient(90deg, transparent, ${MICKY_THEME.captionYellow}, transparent)`,
          boxShadow: `0 0 20px ${MICKY_THEME.captionYellow}`,
        }}
      />
      {/* Center tooth icon */}
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Icon name="Tooth" size={260} color={MICKY_THEME.white} animation="fade" durationInFrames={20} />
      </AbsoluteFill>
      {/* Scanline texture */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 2px, transparent 2px, transparent 4px)`,
        }}
      />
    </AbsoluteFill>
  );
};

const BeforeAfter: React.FC<{ frame: number; fps: number; width: number }> = ({ frame, fps, width }) => {
  const splitX = spring({
    frame,
    fps,
    config: { damping: 20, mass: 0.6, stiffness: 80 },
  });
  const half = width / 2;
  const splitPos = half * splitX;
  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>
      <div
        style={{
          flex: 1,
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderRight: `4px solid ${MICKY_THEME.brandBlue}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONTS.cairoBold,
          fontSize: 32,
          color: MICKY_THEME.white,
        }}
      >
        قبل
      </div>
      <div
        style={{
          position: 'absolute',
          left: splitPos,
          top: 0,
          bottom: 0,
          width: 6,
          backgroundColor: MICKY_THEME.captionYellow,
          boxShadow: `0 0 12px ${MICKY_THEME.captionYellow}`,
        }}
      />
      <div
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,200,80,0.18)',
          borderLeft: `4px solid ${MICKY_THEME.successGreen}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONTS.cairoBold,
          fontSize: 32,
          color: MICKY_THEME.white,
        }}
      >
        بعد
      </div>
    </AbsoluteFill>
  );
};

const DiagramAnnot: React.FC<{ frame: number; fps: number; label?: string }> = ({ frame, fps, label }) => {
  const annotationSpring = spring({
    frame: frame - 6,
    fps,
    config: { damping: 18, mass: 0.5, stiffness: 120 },
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, position: 'relative' }}>
      <Icon name="Tooth" size={180} color={MICKY_THEME.white} animation="rotate-in" durationInFrames={20} />
      {label && (
        <>
          <div
            style={{
              width: 60 * annotationSpring,
              height: 2,
              backgroundColor: MICKY_THEME.captionYellow,
            }}
          />
          <div
            style={{
              fontFamily: FONTS.cairoBold,
              fontSize: 32,
              fontWeight: 700,
              color: MICKY_THEME.captionYellow,
              textShadow: `0 2px 8px ${MICKY_THEME.black}`,
              direction: 'rtl',
              opacity: annotationSpring,
            }}
          >
            {label}
          </div>
        </>
      )}
    </div>
  );
};
