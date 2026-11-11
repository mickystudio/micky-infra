"""
Sound design pipeline (B8).

Fetches background music (Jamendo CC-BY) + SFX (Freesound CC0), auto-ducks
music under speech via FFmpeg sidechain compression, places whoosh SFX at
scene cut points, and mixes all layers into a final track loudness-
normalized to -14 LUFS (YouTube/TikTok broadcast standard).

Graceful degradation: if Jamendo/Freesound APIs fail we fall back to the
local ``MusicLibrary`` (B4); if that's empty too, ``select_music`` returns
"" and ``select_sfx`` returns [], and ``mix_final_audio`` simply loudness-
normalizes the speech/video audio. All intermediate audio is written under
``/tmp/micky_audio/`` so the Kaggle output dir stays clean.

Created: 2026-11-10  |  Task B8
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Lazy optional: MusicLibrary (B4).
try:
    from music_library import MusicLibrary  # type: ignore
    _MUSIC_LIBRARY_AVAILABLE = True
except Exception as _ml_err:  # pragma: no cover
    MusicLibrary = None  # type: ignore[assignment, misc]
    _MUSIC_LIBRARY_AVAILABLE = False
    print(f"[sound_designer] WARNING: music_library unavailable "
          f"({_ml_err!r}); local-track lookup disabled.")

_requests_module: Any = None


def _ensure_requests() -> Any:
    """Return the ``requests`` module, auto-installing on first call."""
    global _requests_module
    if _requests_module is not None:
        return _requests_module
    try:
        import requests  # type: ignore
        _requests_module = requests
        return requests
    except ImportError:
        print("[sound_designer] installing requests>=2.31 ...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "requests>=2.31"])
        import requests  # type: ignore
        _requests_module = requests
        return requests


# --- Constants -------------------------------------------------------------
TMP_AUDIO_DIR: str = "/tmp/micky_audio"
DEFAULT_OUTPUT_LUFS: float = -14.0   # YouTube/TikTok broadcast standard
SPEECH_GAIN_DB: float = 0.0
MUSIC_GAIN_DB: float = -18.0
SFX_GAIN_DB: float = -6.0
JAMENDO_API_BASE: str = "https://api.jamendo.com/v3.0/tracks/"
FREESOUND_API_BASE: str = "https://freesound.org/apiv2/search/text/"
SFX_TYPES: tuple[str, ...] = (
    'whoosh', 'impact', 'riser', 'whoosh_in', 'whoosh_out', 'transition')


def _db_to_lin(db: float) -> float:
    """Decibels → linear amplitude factor (10^(db/20))."""
    return 10.0 ** (db / 20.0)


def _ensure_ffmpeg() -> None:
    import shutil  # noqa: PLC0415
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found in PATH — install ffmpeg.")


def _run_ffmpeg(args: list[str], desc: str = "") -> None:
    """Run ffmpeg, capturing stderr on failure for diagnostics."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error"] + args
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or "").strip()
        raise RuntimeError(f"ffmpeg failed ({desc or 'unknown'}): {err[:500]}") from exc


def _probe_duration(path: str) -> float:
    """Return media file duration in seconds (0.0 on error)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True)
        return float(r.stdout.strip() or 0.0)
    except Exception:  # noqa: BLE001
        return 0.0


def _hash_str(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()[:12]


def _write_attr_json(audio_path: str, meta: dict) -> None:
    """Persist attribution JSON next to a downloaded audio file."""
    try:
        import json  # noqa: PLC0415
        with open(audio_path + ".json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        print(f"[sound_designer] could not write attribution JSON: {exc!r}")


def _normalize_segs(segments: List[dict], dur: float) -> List[tuple[float, float]]:
    """Return list of (start, end) tuples clamped to [0, dur], skip invalid."""
    out: list[tuple[float, float]] = []
    for s in segments or []:
        try:
            lo = max(0.0, float(s.get("start", 0.0)))
            hi = min(dur, float(s.get("end", lo + 0.1)))
        except (TypeError, ValueError):
            continue
        if hi > lo:
            out.append((lo, hi))
    return out


def _download_to(url: str, out_path: str, headers: dict | None = None) -> None:
    """Stream-download URL → out_path (skip if already present)."""
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return
    requests = _ensure_requests()
    ar = requests.get(url, headers=headers, timeout=60, stream=True)
    ar.raise_for_status()
    with open(out_path, "wb") as f:
        for chunk in ar.iter_content(8192):
            if chunk:
                f.write(chunk)


# ---------------------------------------------------------------------------
# SoundDesigner
# ---------------------------------------------------------------------------
class SoundDesigner:
    """End-to-end sound design: music + SFX selection, ducking, mixing.

    Args:
        jamendo_client_id:  Jamendo API client_id (env ``JAMENDO_CLIENT_ID``).
        freesound_token:    Freesound API OAuth2 token (env ``FREESOUND_TOKEN``).
        music_library_path: Local music library dir (B4 ``MusicLibrary``).
    """

    def __init__(self, jamendo_client_id: Optional[str] = None,
                 freesound_token: Optional[str] = None,
                 music_library_path: Optional[str] = None) -> None:
        self.jamendo_client_id = jamendo_client_id or os.getenv("JAMENDO_CLIENT_ID")
        self.freesound_token = freesound_token or os.getenv("FREESOUND_TOKEN")
        self._music_library: Optional[MusicLibrary] = None
        if _MUSIC_LIBRARY_AVAILABLE:
            lib_path = music_library_path or "/kaggle/input/micky-assets/music_cc0"
            try:
                self._music_library = MusicLibrary(lib_path)
                print(f"[sound_designer] local music library: "
                      f"{len(self._music_library.tracks)} tracks @ {lib_path}")
            except Exception as exc:  # noqa: BLE001
                print(f"[sound_designer] local music library unavailable "
                      f"({exc!r}); API-only mode.")
                self._music_library = None
        os.makedirs(TMP_AUDIO_DIR, exist_ok=True)
        print(f"[sound_designer] tmp audio dir: {TMP_AUDIO_DIR}")

    def select_music(self, target_bpm: float, mood: str,
                     duration_sec: float) -> str:
        """Pick a background track matching BPM + mood.

        Order: local ``MusicLibrary`` → Jamendo API → "".
        """
        if self._music_library is not None:
            try:
                local = self._music_library.get_track_by_bpm(
                    target_bpm, tolerance=8.0, mood=mood)
                if local and os.path.exists(local):
                    print(f"[sound_designer] local music match: {local}")
                    return local
            except Exception as exc:  # noqa: BLE001
                print(f"[sound_designer] local library query failed: {exc!r}")
        if self.jamendo_client_id:
            try:
                path = self._fetch_from_jamendo(target_bpm, mood, duration_sec)
                if path:
                    print(f"[sound_designer] Jamendo music: {path}")
                    return path
            except Exception as exc:  # noqa: BLE001
                print(f"[sound_designer] Jamendo fetch failed: {exc!r}")
                traceback.print_exc()
        print("[sound_designer] no music source available — returning ''")
        return ""

    def _fetch_from_jamendo(self, target_bpm: float, mood: str,
                            duration_sec: float) -> str:
        """Query Jamendo and download the best-matching CC-BY track."""
        requests = _ensure_requests()
        bpm_lo, bpm_hi = max(60, int(target_bpm - 8)), min(200, int(target_bpm + 8))
        params = {"client_id": self.jamendo_client_id, "format": "json",
                  "limit": 20, "audioformat": "mp32", "tags": mood,
                  "bpm": f"{bpm_lo}-{bpm_hi}", "include": "musicinfo+audioinfo",
                  "order": "popularity_total"}
        r = requests.get(JAMENDO_API_BASE, params=params, timeout=20)
        r.raise_for_status()
        results = (r.json() or {}).get("results", []) or []
        if not results:
            print(f"[sound_designer] Jamendo returned 0 tracks "
                  f"bpm={bpm_lo}-{bpm_hi} mood={mood}")
            return ""
        # Prefer tracks long enough to cover ~80% of the video.
        target_dur = max(duration_sec * 0.8, 30.0)
        best = next((t for t in results if float(
            (t.get("audioinfo") or {}).get("length") or 0) >= target_dur),
            results[0])
        audio_url = best.get("audio") or best.get("audiodownload")
        if not audio_url:
            return ""
        track_id = str(best.get("id") or _hash_str(audio_url))
        out_path = os.path.join(TMP_AUDIO_DIR, f"music_{track_id}.mp3")
        _download_to(audio_url, out_path)
        _write_attr_json(out_path, {
            "source": "jamendo", "track_id": best.get("id"),
            "title": best.get("name"),
            "artist": (best.get("artist_name") or "").strip(),
            "url": best.get("shareurl") or audio_url,
            "license": best.get("license_ccurl",
                                "https://creativecommons.org/licenses/by/4.0/"),
            "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        print(f"[sound_designer] Jamendo: {best.get('name')} by "
              f"{best.get('artist_name')} → {out_path}")
        return out_path

    def select_sfx(self, sfx_type: str, count: int = 3) -> List[str]:
        """Fetch ``count`` CC0 SFX files matching ``sfx_type``."""
        sfx_type = (sfx_type or "whoosh").strip().lower()
        if sfx_type not in SFX_TYPES:
            print(f"[sound_designer] unknown sfx_type '{sfx_type}'; coercing to 'whoosh'")
            sfx_type = "whoosh"
        if not self.freesound_token:
            print("[sound_designer] FREESOUND_TOKEN not set; returning []")
            return []
        # whoosh_in → rising; whoosh_out → falling.
        query = {"whoosh_in": "whoosh rising",
                 "whoosh_out": "whoosh falling"}.get(sfx_type, sfx_type)
        try:
            return self._fetch_from_freesound(query, count, sfx_type)
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] Freesound fetch failed: {exc!r}")
            traceback.print_exc()
            return []

    def _fetch_from_freesound(self, query: str, count: int, tag: str) -> List[str]:
        """Query Freesound for CC0 sounds matching ``query``."""
        requests = _ensure_requests()
        params = {"query": query, "filter": 'license:"Creative Commons 0"',
                  "page_size": min(max(count, 1), 20),
                  "fields": "id,name,duration,previews", "sort": "rating_desc"}
        headers = {"Authorization": f"Token {self.freesound_token}"}
        r = requests.get(FREESOUND_API_BASE, params=params,
                         headers=headers, timeout=20)
        r.raise_for_status()
        results = (r.json() or {}).get("results", []) or []
        if not results:
            print(f"[sound_designer] Freesound returned 0 results for '{query}'")
            return []
        paths: List[str] = []
        for sfx in results[:count]:
            previews = sfx.get("previews") or {}
            url = previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3")
            if not url:
                continue
            sid = str(sfx.get("id") or _hash_str(url))
            out_path = os.path.join(TMP_AUDIO_DIR, f"sfx_{tag}_{sid}.wav")
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                paths.append(out_path)
                continue
            try:
                tmp_mp3 = out_path + ".mp3"
                _download_to(url, tmp_mp3, headers=headers)
                _run_ffmpeg(["-i", tmp_mp3, "-vn", "-ar", "44100", "-ac", "2",
                             "-acodec", "pcm_s16le", out_path], desc=f"freesound-{sid}")
                if os.path.exists(tmp_mp3):
                    os.remove(tmp_mp3)
                paths.append(out_path)
                _write_attr_json(out_path, {
                    "source": "freesound", "sound_id": sid,
                    "name": sfx.get("name"), "license": "Creative Commons 0",
                    "url": f"https://freesound.org/s/{sid}/",
                    "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
            except Exception as exc:  # noqa: BLE001
                print(f"[sound_designer] download failed for sound {sid}: {exc!r}")
                continue
        print(f"[sound_designer] Freesound fetched {len(paths)}/{count} '{tag}' SFX")
        return paths

    def duck_music_under_speech(self, music_path: str,
                                speech_segments: List[dict],
                                reduction_db: float = -12.0) -> str:
        """Duck ``music_path`` during speech via FFmpeg sidechaincompress.

        Falls back to per-segment ``volume`` automation if sidechain fails.
        Returns ducked music WAV path (or "" if music missing).
        """
        if not music_path or not os.path.exists(music_path):
            print("[sound_designer] duck_music: no music path — returning ''")
            return ""
        out_path = os.path.join(TMP_AUDIO_DIR, f"music_ducked_{_hash_str(music_path)}.wav")
        trigger = self._build_speech_trigger(speech_segments, music_path)
        if not trigger:
            _run_ffmpeg(["-i", music_path, "-vn", "-ar", "44100", "-ac", "2",
                         "-acodec", "pcm_s16le", out_path], desc="duck-music-no-speech")
            return out_path
        _ensure_ffmpeg()
        try:
            _run_ffmpeg(["-i", music_path, "-i", trigger, "-filter_complex",
                         "[0:a][1:a]sidechaincompress="
                         "threshold=0.05:ratio=10:attack=5:release=200[mixed]",
                         "-map", "[mixed]", "-ar", "44100", "-ac", "2",
                         "-acodec", "pcm_s16le", out_path], desc="sidechain-duck")
            print(f"[sound_designer] ducked music (sidechain): {out_path}")
            return out_path
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] sidechain ducking failed ({exc!r}); "
                  "falling back to volume automation")
            traceback.print_exc()
        # Fallback: per-segment volume automation via eval expression.
        factor = _db_to_lin(reduction_db)
        dur = _probe_duration(music_path) or 1e6
        segs = _normalize_segs(speech_segments, dur)
        if not segs:
            _run_ffmpeg(["-i", music_path, "-vn", "-ar", "44100", "-ac", "2",
                         "-acodec", "pcm_s16le", out_path], desc="duck-noop")
            return out_path
        parts = [f"between(t,{lo:.3f},{hi:.3f})" for lo, hi in segs]
        expr = f"if(gt({' + '.join(parts)},0),{factor},1.0)"
        _run_ffmpeg(["-i", music_path, "-af", f"volume='{expr}':eval=frame",
                     "-ar", "44100", "-ac", "2", "-acodec", "pcm_s16le",
                     out_path], desc="volume-automation-duck")
        print(f"[sound_designer] ducked music (vol-automation, {reduction_db}dB): {out_path}")
        return out_path

    def _build_speech_trigger(self, speech_segments: List[dict],
                              music_path: str) -> str:
        """Synthesize sidechain-trigger: 0.5-amp 80Hz sine during speech."""
        if not speech_segments:
            return ""
        dur = _probe_duration(music_path)
        if dur <= 0:
            dur = max((float(s.get("end", 0.0)) for s in speech_segments), default=0.0)
        if dur <= 0:
            return ""
        segs = _normalize_segs(speech_segments, dur)
        if not segs:
            return ""
        parts = [f"between(t,{lo:.3f},{hi:.3f})" for lo, hi in segs]
        expr = f"min(0.5,0.5*({' + '.join(parts)}))"  # cap at 0.5 amp
        trig_path = os.path.join(TMP_AUDIO_DIR, "speech_trigger.wav")
        _run_ffmpeg(["-f", "lavfi", "-t", f"{dur:.3f}",
                     "-i", "sine=frequency=80:sample_rate=44100",
                     "-af", f"volume={expr}:eval=frame",
                     "-ac", "1", "-acodec", "pcm_s16le", trig_path],
                    desc="speech-trigger")
        return trig_path

    def place_sfx_at_cuts(self, sfx_paths: List[str], cut_times: List[float],
                          duration_sec: float,
                          output_path: Optional[str] = None) -> str:
        """Lay each SFX at its cut time → single SFX track.

        Each SFX gets an 80 ms fade in (anti-click) and is delayed by its
        cut time via ``adelay``, then ``amix``-ed (no auto-norm).
        """
        if not sfx_paths:
            print("[sound_designer] place_sfx: no SFX — returning ''")
            return ""
        if not output_path:
            output_path = os.path.join(
                TMP_AUDIO_DIR, f"sfx_track_{_hash_str(','.join(sfx_paths))}.wav")
        pairs = [(p, max(0.0, float(t))) for p, t in zip(sfx_paths, cut_times)
                 if p and os.path.exists(p)]
        if not pairs:
            print("[sound_designer] place_sfx: no valid SFX files after filter")
            return ""
        input_args: list[str] = []
        labels: list[str] = []
        filter_parts: list[str] = []
        for i, (p, t) in enumerate(pairs):
            input_args += ["-i", p]
            lbl = f"s{i}"
            delay_ms = int(t * 1000)
            filter_parts.append(
                f"[{i}:a]afade=t=in:st=0:d=0.08,"
                f"adelay=delays={delay_ms}:all=1[{lbl}]")
            labels.append(f"[{lbl}]")
        filter_parts.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:"
            f"duration=longest:normalize=0[sfx_track]")
        tail_start = max(duration_sec - 0.2, 0.0)
        filter_parts.append(
            f"[sfx_track]atrim=0:{max(duration_sec,0.1):.3f},"
            f"afade=t=out:st={tail_start:.3f}:d=0.2[sfx_out]")
        filter_complex = ";".join(filter_parts)
        _run_ffmpeg(input_args + ["-filter_complex", filter_complex,
                                  "-map", "[sfx_out]", "-ar", "44100",
                                  "-ac", "2", "-acodec", "pcm_s16le",
                                  output_path], desc="place-sfx-at-cuts")
        print(f"[sound_designer] placed {len(pairs)} SFX cuts → {output_path}")
        return output_path

    def mix_final_audio(self, video_path: str,
                        music_path: Optional[str] = None,
                        sfx_track: Optional[str] = None,
                        speech_path: Optional[str] = None,
                        output_path: Optional[str] = None,
                        target_lufs: float = DEFAULT_OUTPUT_LUFS) -> str:
        """Mix all audio layers → final video, normalized to ``target_lufs``.

        Levels: Speech 0 dB (1.000), Music -18 dB (0.126), SFX -6 dB (0.501).
        Single-pass ``loudnorm`` to -14 LUFS by default. Set env var
        ``MICKY_LOUDNORM_TWOPASS=1`` for EBU R128 two-pass (slower, tighter).
        Video stream is copied (no re-encode). Falls back to ``video_path``.
        """
        _ensure_ffmpeg()
        if not output_path:
            output_path = os.path.join(
                TMP_AUDIO_DIR, f"{Path(video_path).stem}_sounddesigned.mp4")
        input_args: list[str] = ["-i", video_path]
        filter_parts: list[str] = []
        mix_labels: list[str] = []
        # Speech layer (or video's own audio).
        if speech_path and os.path.exists(speech_path):
            input_args += ["-i", speech_path]
            speech_idx = len(input_args) // 2 - 1
        else:
            speech_idx = 0
        filter_parts.append(f"[{speech_idx}:a]volume={_db_to_lin(SPEECH_GAIN_DB)}[speech_norm]")
        mix_labels.append("[speech_norm]")
        # Music layer.
        if music_path and os.path.exists(music_path):
            input_args += ["-i", music_path]
            music_idx = len(input_args) // 2 - 1
            filter_parts.append(f"[{music_idx}:a]volume={_db_to_lin(MUSIC_GAIN_DB)}[music_norm]")
            mix_labels.append("[music_norm]")
        # SFX layer.
        if sfx_track and os.path.exists(sfx_track):
            input_args += ["-i", sfx_track]
            sfx_idx = len(input_args) // 2 - 1
            filter_parts.append(f"[{sfx_idx}:a]volume={_db_to_lin(SFX_GAIN_DB)}[sfx_norm]")
            mix_labels.append("[sfx_norm]")
        n = len(mix_labels)
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={n}:duration=first:normalize=0[mixed]")
        # Loudness normalization (single-pass by default, two-pass opt-in).
        suffix = "print_format=summary" if os.getenv("MICKY_LOUDNORM_TWOPASS") == "1" \
            else "linear=true"
        loudnorm = f"loudnorm=I={target_lufs}:TP=-1.0:LRA=11:{suffix}"
        filter_parts.append(f"[mixed]{loudnorm}[final_audio]")
        filter_complex = ";".join(filter_parts)
        try:
            _run_ffmpeg(input_args + ["-filter_complex", filter_complex,
                                      "-map", "0:v", "-map", "[final_audio]",
                                      "-c:v", "copy", "-c:a", "aac",
                                      "-b:a", "192k", "-shortest", output_path],
                        desc="mix-final-audio")
            print(f"[sound_designer] mixed final audio → {output_path} (target {target_lufs} LUFS)")
            return output_path
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] mix_final_audio failed ({exc!r}); returning original video")
            traceback.print_exc()
            return video_path

    def auto_design_track(self, video_path: str,
                          scene_boundaries: Sequence[Any],
                          whisperx_result: dict,
                          mood: Optional[str] = None) -> str:
        """End-to-end: BPM detect → select music → duck → place SFX → mix.

        Cut times = ``start_time`` of each scene except the first (which is
        the opening, not a cut). ``mood`` overrides scene metadata, else
        inferred from first scene's ``metadata.mood``, else 'neutral'.
        Falls back to ``video_path`` on any failure.
        """
        try:
            _ensure_ffmpeg()
            duration_sec = _probe_duration(video_path) or 60.0
            print(f"[sound_designer] auto_design_track: {video_path} ({duration_sec:.1f}s)")
            # 1) Extract speech audio from video.
            speech_path = os.path.join(TMP_AUDIO_DIR, "speech_extracted.wav")
            _run_ffmpeg(["-i", video_path, "-vn", "-ar", "44100", "-ac", "1",
                         "-acodec", "pcm_s16le", speech_path], desc="extract-speech")
            # 2) BPM detection — BeatSync, then librosa, default 120.
            target_bpm = self._detect_bpm_from_video(video_path)
            print(f"[sound_designer] detected/assumed BPM: {target_bpm}")
            # 3) Mood: passed-in > scene metadata > 'neutral'.
            if not mood and scene_boundaries:
                first = scene_boundaries[0]
                meta = (getattr(first, "metadata", None)
                        or (first.get("metadata", {}) if isinstance(first, dict)
                            else {})) or {}
                mood = meta.get("mood") or "neutral"
            mood = mood or "neutral"
            # 4) Select music.
            music_path = self.select_music(target_bpm, mood, duration_sec)
            # 5) Duck music under speech segments.
            ducked_music: Optional[str] = None
            if music_path:
                segments = (whisperx_result or {}).get("segments", [])
                speech_segs = [{"start": float(s.get("start", 0.0)),
                                "end": float(s.get("end", 0.0))}
                               for s in segments if s.get("start") is not None]
                ducked_music = self.duck_music_under_speech(
                    music_path, speech_segs, reduction_db=-12.0)
            # 6) SFX at cut points (skip scene 0 — it's the opening).
            cut_times: list[float] = []
            for i, sb in enumerate(scene_boundaries or []):
                if i == 0:
                    continue
                st = (getattr(sb, "start_time", None)
                      if not isinstance(sb, dict)
                      else sb.get("start_time", 0.0))
                cut_times.append(float(st or 0.0))
            sfx_track: Optional[str] = None
            if cut_times:
                sfx_paths = self.select_sfx("whoosh", count=len(cut_times))
                if sfx_paths:
                    sfx_paths = [sfx_paths[i % len(sfx_paths)]
                                 for i in range(len(cut_times))]
                    sfx_track = self.place_sfx_at_cuts(sfx_paths, cut_times, duration_sec)
            # 7) Mix everything into the final video.
            final = self.mix_final_audio(
                video_path=video_path, music_path=ducked_music,
                sfx_track=sfx_track, speech_path=speech_path,
                output_path=os.path.join(
                    TMP_AUDIO_DIR, Path(video_path).stem + "_sounddesigned.mp4"))
            print(f"[sound_designer] auto_design_track complete → {final}")
            return final
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] auto_design_track FAILED: {exc!r}")
            traceback.print_exc()
            return video_path

    def _detect_bpm_from_video(self, video_path: str) -> float:
        """Best-effort BPM: BeatSync → librosa → 120."""
        try:
            from beat_sync import BeatSync  # type: ignore
            info = BeatSync(device="cpu").detect_beats(video_path)
            if info and info.bpm and info.bpm > 0:
                return float(info.bpm)
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] BeatSync BPM detect failed: {exc!r}")
        try:
            import librosa  # type: ignore
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tmp_wav = tf.name
            _run_ffmpeg(["-i", video_path, "-vn", "-ar", "22050", "-ac", "1",
                         "-acodec", "pcm_s16le", tmp_wav], desc="bpm-extract")
            y, sr = librosa.load(tmp_wav, sr=22050, mono=True)
            tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
            if isinstance(tempo, (list, tuple)):
                tempo = tempo[0] if tempo else 120.0
            if hasattr(tempo, "item"):
                tempo = tempo.item()
            if os.path.exists(tmp_wav):
                os.remove(tmp_wav)
            return float(tempo or 120.0)
        except Exception as exc:  # noqa: BLE001
            print(f"[sound_designer] librosa BPM detect failed: {exc!r}; defaulting to 120 BPM")
        return 120.0


if __name__ == "__main__":
    # Smoke test: python sound_designer.py VIDEO [--mood calm] [--transcript JSON]
    import argparse, json  # noqa: PLC0415
    _p = argparse.ArgumentParser(description="SoundDesigner — B8 smoke test")
    _p.add_argument("video"); _p.add_argument("--mood", default=None)
    _p.add_argument("--transcript", default=None)
    _a = _p.parse_args()
    _wx = {"segments": []}
    if _a.transcript and os.path.exists(_a.transcript):
        with open(_a.transcript, encoding="utf-8") as _f:
            _wx = json.load(_f)
    print(f"\nFinal video: {SoundDesigner().auto_design_track(_a.video, [], _wx, _a.mood)}")
