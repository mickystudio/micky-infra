"""
Take selector (P4-T2).
==================
When the user records the same scene multiple times back-to-back
(separated by long silences), this module:

    1. Detects silence gaps (`ffmpeg silencedetect`)
    2. Splits the video into candidate "takes"
    3. Clusters takes by transcript text similarity (first-N-words keying)
    4. Scores each take:
         - SNR (signal-to-noise ratio of audio)
         - WPM (words-per-minute, ideal 110–160 for Arabic speech)
         - Fluency (no long pauses or stutter repeats)
    5. Picks the best take per cluster and concatenates them.

If there's only one take (no detectable silence gaps above 0.5s),
the input video is returned unchanged.

Created: 2026-11-10
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SILENCE_THRESHOLD_DB = -30      # Below this = silence
SILENCE_MIN_DURATION = 0.5      # Seconds (a "take boundary")
TARGET_WPM = 135                # Ideal words-per-minute for Arabic dental content
WPM_TOLERANCE = 35              # ±35 WPM around target
SNR_FLOOR_DB = 5.0             # Below this, take is unusable


def select_best_takes(
    video_path: str,
    transcript: dict | None = None,
    output_dir: str | None = None,
) -> str:
    """
    Inspect the input video for multiple takes separated by silence.
    Select the best take from each cluster and concatenate them.

    Args:
        video_path:   Input video (with audio track).
        transcript:   Optional Whisper transcript (used for text clustering).
        output_dir:   Where to drop intermediate + output files. If None,
                      a sibling directory is created.

    Returns:
        Path to the "selected" video. If only one take is detected, the
        original `video_path` is returned unchanged.
    """
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(video_path) or '.',
                                  f'{Path(video_path).stem}_takes')
    os.makedirs(output_dir, exist_ok=True)

    # 1. Detect silence gaps
    silence_periods = detect_silence(video_path)
    print(f"   🎯 Detected {len(silence_periods)} silence periods")
    if len(silence_periods) < 2:
        print("   🎯 Single take — no selection needed")
        return video_path

    # 2. Split video at silence boundaries
    segments = split_video_at_silence(video_path, silence_periods, output_dir)
    print(f"   🎯 {len(segments)} candidate segments")

    # 3. Cluster by transcript text
    clusters = cluster_segments_by_text(segments, transcript)
    print(f"   🎯 {len(clusters)} unique scenes after clustering")

    # 4. Pick best per cluster
    best_segments: list[dict] = []
    for i, cluster in enumerate(clusters):
        print(f"      Cluster {i + 1}: {len(cluster)} take(s)")
        best = select_best_from_cluster(cluster, output_dir)
        best_segments.append(best)
        print(f"         → winner: {Path(best['path']).name} "
              f"(score={best.get('score', 0):.2f})")

    # 5. Concatenate best takes
    if len(best_segments) == 1:
        return best_segments[0]['path']
    output_path = os.path.join(output_dir, 'best_takes.mp4')
    concatenate_segments(best_segments, output_path)
    return output_path


# ---------------------------------------------------------------------------
# Step 1: silence detection
# ---------------------------------------------------------------------------
def detect_silence(video_path: str) -> list[dict]:
    """
    Run `ffmpeg silencedetect` and parse the stderr log.

    Returns:
        List of dicts: [{'start': float, 'end': float}, ...]
    """
    result = subprocess.run(
        [
            'ffmpeg', '-i', video_path,
            '-af', f'silencedetect=noise={SILENCE_THRESHOLD_DB}dB:d={SILENCE_MIN_DURATION}',
            '-f', 'null', '-',
        ],
        capture_output=True, text=True,
    )
    # silencedetect writes to stderr
    log = result.stderr

    silences: list[dict] = []
    start_re = re.compile(r'silence_start:\s*([\d.]+)')
    end_re = re.compile(r'silence_end:\s*([\d.]+)')

    current: dict | None = None
    for line in log.splitlines():
        m = start_re.search(line)
        if m:
            current = {'start': float(m.group(1))}
            silences.append(current)
            continue
        m = end_re.search(line)
        if m and current is not None:
            current['end'] = float(m.group(1))
            current = None

    # Drop any incomplete (start without end)
    return [s for s in silences if 'end' in s]


# ---------------------------------------------------------------------------
# Step 2: split at silence
# ---------------------------------------------------------------------------
def split_video_at_silence(
    video_path: str,
    silences: list[dict],
    output_dir: str,
) -> list[dict]:
    """
    Split the input video at the centre of each silence gap.

    Returns:
        List of segment dicts: {'path', 'start', 'end', 'duration'}
    """
    # Boundaries = midpoints of each silence period
    cut_points = [(s['start'] + s['end']) / 2.0 for s in silences]
    # Final cut = end of video (probed via ffprobe)
    total_duration = _probe_duration(video_path)
    cut_points.append(total_duration)

    segments: list[dict] = []
    prev = 0.0
    for i, cut in enumerate(cut_points):
        seg_path = os.path.join(output_dir, f'seg_{i:03d}.mp4')
        _run_ffmpeg([
            'ffmpeg', '-y',
            '-i', video_path,
            '-ss', f'{prev:.3f}',
            '-to', f'{cut:.3f}',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '128k',
            seg_path,
        ])
        segments.append({
            'path': seg_path,
            'start': prev,
            'end': cut,
            'duration': cut - prev,
        })
        prev = cut
    return segments


# ---------------------------------------------------------------------------
# Step 3: text clustering
# ---------------------------------------------------------------------------
def cluster_segments_by_text(
    segments: list[dict],
    transcript: dict | None,
) -> list[list[dict]]:
    """
    Group segments whose transcript starts with the same 5 words.
    Segments with no transcript are each put in their own singleton cluster.
    """
    clusters: dict[str, list[dict]] = {}
    singleton_idx = 0

    for seg in segments:
        text = ''
        if transcript:
            text = get_text_for_range(transcript, seg['start'], seg['end'])
        if not text:
            # No transcript → singleton cluster (won't be merged with others)
            key = f'__no_transcript_{singleton_idx}'
            singleton_idx += 1
        else:
            # Use first 5 words as cluster key (lowercased, no diacritics)
            words = text.split()[:5]
            key = ' '.join(words).lower()
        clusters.setdefault(key, []).append(seg)

    return list(clusters.values())


def get_text_for_range(
    transcript: dict,
    start: float,
    end: float,
) -> str:
    """Concatenate all word-texts from Whisper segments overlapping [start, end]."""
    out: list[str] = []
    for seg in transcript.get('segments', []):
        # Use word-level if available; otherwise segment-level
        if seg.get('words'):
            for w in seg['words']:
                if w.get('start', 0) >= start and w.get('end', 0) <= end:
                    out.append(w.get('word', '').strip())
        else:
            if seg.get('start', 0) >= start and seg.get('end', 0) <= end:
                out.append(seg.get('text', '').strip())
    return ' '.join(out).strip()


# ---------------------------------------------------------------------------
# Step 4: scoring + selection
# ---------------------------------------------------------------------------
def select_best_from_cluster(cluster: list[dict], output_dir: str) -> dict:
    """
    Score every take in a cluster and return the winner (the original
    dict augmented with `score` and metrics).
    """
    if len(cluster) == 1:
        winner = dict(cluster[0])
        winner['score'] = calculate_take_score(cluster[0], output_dir)
        return winner

    best = None
    best_score = -1.0
    for seg in cluster:
        score = calculate_take_score(seg, output_dir)
        seg_copy = dict(seg)
        seg_copy['score'] = score
        if score > best_score:
            best_score = score
            best = seg_copy
    return best


def calculate_take_score(segment: dict, output_dir: str | None = None) -> float:
    """
    Compute a 0..1 quality score for a take:
        - 40% SNR (higher = cleaner audio)
        - 40% WPM fit (close to TARGET_WPM = best)
        - 20% Fluency (low pause-ratio = fluent)
    """
    duration = segment.get('duration', 0.0)
    if duration <= 0:
        return 0.0

    snr_db = _compute_snr(segment['path'])
    snr_norm = _clamp01((snr_db - SNR_FLOOR_DB) / 25.0)        # 5..30 dB → 0..1

    wpm = _compute_wpm(segment, duration)
    wpm_norm = _clamp01(1.0 - abs(wpm - TARGET_WPM) / WPM_TOLERANCE)

    fluency = _compute_fluency(segment['path'])
    fluency_norm = _clamp01(fluency)

    score = 0.40 * snr_norm + 0.40 * wpm_norm + 0.20 * fluency_norm
    return round(score, 3)


# ---------------------------------------------------------------------------
# Step 5: concatenation
# ---------------------------------------------------------------------------
def concatenate_segments(segments: list[dict], output_path: str) -> str:
    """Concatenate best-take MP4s via ffmpeg concat demuxer (no re-encode)."""
    list_path = os.path.join(os.path.dirname(output_path), 'concat_list.txt')
    with open(list_path, 'w', encoding='utf-8') as f:
        for seg in segments:
            # ffmpeg concat list expects `file 'path'` lines, paths quoted
            f.write(f"file '{seg['path']}'\n")

    _run_ffmpeg([
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', list_path,
        '-c', 'copy',                   # stream copy
        output_path,
    ])
    return output_path


# ---------------------------------------------------------------------------
# Metric helpers
# ---------------------------------------------------------------------------
def _compute_snr(video_path: str) -> float:
    """
    Estimate SNR (dB) of the audio track.
    SNR ≈ 20·log10(rms_signal / rms_noise)
    where rms_noise is estimated from the quietest 5% of frames.
    """
    try:
        import soundfile as sf
    except ImportError:
        return 20.0  # optimistic default if soundfile unavailable

    # Extract audio to temp WAV
    tmp_wav = os.path.join(os.path.dirname(video_path) or '.',
                           f'{Path(video_path).stem}_snr.wav')
    _run_ffmpeg([
        'ffmpeg', '-y', '-i', video_path,
        '-vn', '-acodec', 'pcm_s16le',
        '-ar', '16000', '-ac', '1',
        tmp_wav,
    ])
    try:
        audio, _ = sf.read(tmp_wav, dtype='float32')
    except Exception:
        return 20.0
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)

    if audio.size == 0:
        return 0.0

    # Frame-based RMS (20ms frames)
    frame_size = int(0.02 * 16000)
    frames = audio[: (audio.size // frame_size) * frame_size].reshape(-1, frame_size)
    if frames.size == 0:
        return 0.0
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    rms.sort()
    noise_rms = float(np.mean(rms[: max(1, len(rms) // 20)]))   # quietest 5%
    signal_rms = float(np.mean(rms))
    if noise_rms <= 0:
        return 35.0
    snr_db = 20.0 * math.log10(signal_rms / noise_rms)
    return max(0.0, snr_db)


def _compute_wpm(segment: dict, duration: float) -> float:
    """
    Estimate words-per-minute for this segment using its transcript text
    (extracted via Whisper if available).
    """
    transcript = segment.get('transcript')
    if transcript:
        text = get_text_for_range(transcript,
                                  segment['start'], segment['end'])
    else:
        text = segment.get('text', '')
    word_count = len(text.split())
    if duration <= 0:
        return 0.0
    return (word_count / duration) * 60.0


def _compute_fluency(video_path: str) -> float:
    """
    Fluency proxy: ratio of "speech time" to "total time".
    Speech time = total − silence time. Higher ratio = more fluent.
    """
    silences = detect_silence(video_path)
    total = _probe_duration(video_path)
    if total <= 0:
        return 0.5
    silence_total = sum(
        s.get('end', 0) - s.get('start', 0) for s in silences
    )
    speech_ratio = max(0.0, 1.0 - silence_total / total)
    return speech_ratio


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------
def _probe_duration(video_path: str) -> float:
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                video_path,
            ],
            capture_output=True, text=True, check=True,
        )
        return float(result.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-1500:]}"
        )


# Allow this module to run standalone for debugging
if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('Usage: take_selector.py <video_path> [output_dir]')
        sys.exit(1)
    out = select_best_takes(sys.argv[1], None,
                            sys.argv[2] if len(sys.argv) > 2 else None)
    print(f'Best takes → {out}')
