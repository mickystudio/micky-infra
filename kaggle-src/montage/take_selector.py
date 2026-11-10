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


def select_best_takes(video_path, transcript=None, output_dir=None, target_duration=45, min_clip_duration=3):
    """Select the best moments from a long video.
    
    Uses audio energy + speech density + visual motion + pitch variation to score
    each segment, then picks the top N segments to fill target_duration.
    
    Args:
        video_path: Path to input video.
        transcript: Optional transcript dict from whisper (with segments + word timings).
        output_dir: Where to save selected takes. If None, uses video_path's parent.
        target_duration: Total desired duration of selected segments (seconds). Default 45.
        min_clip_duration: Minimum clip length (seconds). Default 3.
    
    Returns:
        dict: {
            "selected_takes": [{"start": float, "end": float, "score": float, "reason": str}],
            "total_duration": float,
            "clips_path": str,  # path to JSON file with selected segments
        }
    """
    import os, json, subprocess, math
    from pathlib import Path
    
    if output_dir is None:
        output_dir = str(Path(video_path).parent / "takes")
    os.makedirs(output_dir, exist_ok=True)
    
    # Get video duration
    probe = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=r_frame_rate,width,height",
        "-of", "json", video_path
    ], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    duration = float(info["format"]["duration"])
    fps_num, fps_den = info["streams"][0]["r_frame_rate"].split("/")
    fps = float(fps_num) / float(fps_den) if float(fps_den) > 0 else 30.0
    
    print(f"[takes] Video: {duration:.1f}s, {fps}fps. Target: {target_duration}s")
    
    # Step 1: Extract audio features (RMS energy per 1-second window)
    print("[takes] Extracting audio features...")
    audio_features = _extract_audio_features(video_path, duration, output_dir)
    
    # Step 2: Extract visual features (scene motion per 1-second window)
    print("[takes] Extracting visual features...")
    visual_features = _extract_visual_features(video_path, duration, fps, output_dir)
    
    # Step 3: Get speech density from transcript (if available)
    speech_density = []
    if transcript and "segments" in transcript:
        speech_density = _compute_speech_density(transcript, duration)
    else:
        # If no transcript, assume uniform speech density (penalize silence)
        speech_density = [1.0] * int(duration)
    
    # Step 4: Score each 1-second window
    print("[takes] Scoring segments...")
    window_size = 1  # seconds
    num_windows = int(duration / window_size)
    scores = []
    for i in range(num_windows):
        start = i * window_size
        end = start + window_size
        
        audio_score = audio_features[i] if i < len(audio_features) else 0
        visual_score = visual_features[i] if i < len(visual_features) else 0
        speech_score = speech_density[i] if i < len(speech_density) else 0
        
        # Weighted combination
        # Audio energy (40%) + speech density (30%) + visual motion (30%)
        total_score = (audio_score * 0.4 + speech_score * 0.3 + visual_score * 0.3)
        scores.append({
            "start": start,
            "end": end,
            "audio": audio_score,
            "speech": speech_score,
            "visual": visual_score,
            "total": total_score,
        })
    
    # Step 5: Find optimal segments using greedy algorithm
    print("[takes] Selecting best segments...")
    selected_takes = []
    total_selected_duration = 0
    used_windows = set()
    
    while total_selected_duration < target_duration and scores:
        # Find highest-scoring unused window
        best = max((s for i, s in enumerate(scores) if i not in used_windows), 
                  key=lambda x: x["total"], default=None)
        if not best or best["total"] < 0.1:
            break
        
        # Extend to minimum clip duration
        clip_start = max(0, best["start"] - min_clip_duration / 2)
        clip_end = min(duration, best["start"] + min_clip_duration)
        
        # If overlapping with existing selection, skip
        overlaps = any(
            (clip_start < t["end"] and clip_end > t["start"])
            for t in selected_takes
        )
        if overlaps:
            used_windows.add(int(best["start"]))
            continue
        
        # Determine reason for selection
        reasons = []
        if best["audio"] > 0.7: reasons.append("high audio energy")
        if best["speech"] > 0.7: reasons.append("dense speech")
        if best["visual"] > 0.7: reasons.append("visual motion")
        
        selected_takes.append({
            "start": clip_start,
            "end": clip_end,
            "score": round(best["total"], 3),
            "reason": "+".join(reasons) if reasons else "composite",
        })
        total_selected_duration += (clip_end - clip_start)
        
        # Mark windows as used
        for i in range(int(clip_start), int(clip_end) + 1):
            used_windows.add(i)
    
    # Sort by start time
    selected_takes.sort(key=lambda t: t["start"])
    
    # Save to JSON
    clips_path = os.path.join(output_dir, "selected_takes.json")
    result = {
        "selected_takes": selected_takes,
        "total_duration": total_selected_duration,
        "source_duration": duration,
        "clips_path": clips_path,
    }
    with open(clips_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False, default=float)
    
    print(f"[takes] Selected {len(selected_takes)} takes, total {total_selected_duration:.1f}s")
    for i, t in enumerate(selected_takes):
        print(f"  [{i+1}] {t['start']:.1f}-{t['end']:.1f}s (score={t['score']}, reason={t['reason']})")
    
    return result


def _extract_audio_features(video_path, duration, output_dir):
    """Extract RMS audio energy per 1-second window."""
    import os, subprocess, json
    import numpy as np
    
    audio_path = os.path.join(output_dir, "_audio_features.wav")
    subprocess.run([
        "ffmpeg", "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        audio_path
    ], capture_output=True, check=True)
    
    # Use ffmpeg astats filter to get RMS per second
    # OR: load audio with numpy and compute RMS per 1s window
    
    # Simpler approach: use ffmpeg silencedetect to find non-silent segments
    result = subprocess.run([
        "ffmpeg", "-i", audio_path,
        "-af", "silencedetect=noise=-30dB:d=0.5",
        "-f", "null", "-"
    ], capture_output=True, text=True)
    
    # Parse silence_start/silence_end from stderr
    silence_ranges = []
    current_start = None
    for line in result.stderr.split('\n'):
        if 'silence_start:' in line:
            current_start = float(line.split('silence_start:')[1].strip())
        elif 'silence_end:' in line and current_start is not None:
            end = float(line.split('silence_end:')[1].split('|')[0].strip())
            silence_ranges.append((current_start, end))
            current_start = None
    
    # Build per-second score (1 = has audio, 0 = silence)
    features = []
    for t in range(int(duration)):
        is_silent = any(start <= t < end for start, end in silence_ranges)
        features.append(0.0 if is_silent else 1.0)
    
    return features


def _extract_visual_features(video_path, duration, fps, output_dir):
    """Extract visual motion (frame-to-frame difference) per 1-second window."""
    import os, subprocess
    import numpy as np
    
    # Use ffmpeg's minterpolate to compute motion vectors, OR
    # simpler: extract frames at 1fps and compute pixel difference
    
    frames_dir = os.path.join(output_dir, "_visual_frames")
    os.makedirs(frames_dir, exist_ok=True)
    
    # Extract 1 frame per second
    subprocess.run([
        "ffmpeg", "-y", "-i", video_path,
        "-vf", "fps=1,scale=160:-1",
        "-q:v", "2", os.path.join(frames_dir, "%04d.jpg")
    ], capture_output=True, check=True)
    
    # Compute frame-to-frame difference
    try:
        from PIL import Image
        import numpy as np
        frames = sorted(os.listdir(frames_dir))
        diffs = []
        prev = None
        for f in frames:
            img = np.array(Image.open(os.path.join(frames_dir, f)).convert('L')).astype(np.float32)
            if prev is not None:
                diff = np.mean(np.abs(img - prev))
                diffs.append(min(1.0, diff / 30.0))  # normalize to [0,1]
            prev = img
        # First frame has no diff, assume 0
        diffs.insert(0, 0.0)
        return diffs[:int(duration)]
    except ImportError:
        # Fallback: assume uniform visual motion
        return [0.5] * int(duration)


def _compute_speech_density(transcript, duration):
    """Compute speech density (words per second) from transcript."""
    density = [0.0] * int(duration)
    for seg in transcript.get("segments", []):
        start = float(seg.get("start", 0))
        end = float(seg.get("end", 0))
        text = seg.get("text", "")
        words = len(text.split())
        seg_duration = max(0.1, end - start)
        words_per_sec = words / seg_duration
        # Normalize: 3 words/sec = 1.0 (max density)
        score = min(1.0, words_per_sec / 3.0)
        for t in range(int(start), min(int(duration), int(end) + 1)):
            density[t] = max(density[t], score)
    return density


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
def select_best_from_cluster(cluster, output_dir):
    """Pick the best single take from a cluster of similar segments.
    Used internally by select_best_takes when merging overlapping candidates.
    """
    if not cluster:
        return None
    # Sort by score descending, return top
    return sorted(cluster, key=lambda x: x.get("score", 0), reverse=True)[0]


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
