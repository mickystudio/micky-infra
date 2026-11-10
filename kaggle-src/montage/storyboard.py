"""Storyboard checkpoint + rough-cut review (Agent B11).

Pro video editors show a *storyboard* (grid of thumbnails with take-level
metadata) to the client *before* the final render, so the client can
approve, swap, or trim individual takes without paying the 30-60 min
render cost twice. Provides StoryboardTake / Storyboard dataclasses and
a StoryboardGenerator that extracts thumbnails + preview clips, lays out
the grid, exports JSON + PDF, and builds the approval payload. Pillow /
reportlab are lazily imported so `import storyboard` never crashes when
deps are absent.
"""
from __future__ import annotations

import base64, hashlib, os, shutil, subprocess, sys, time, uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional

# Take / SceneBoundary / NarrativeArc are duck-typed (we only read .start /
# .end / .score.overall / .scene_idx / .path), so we accept either v2/v3.
try:  # pragma: no cover — exercised at runtime on Kaggle.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from scene_detector import SceneBoundary  # type: ignore  # noqa: F401
except Exception:  # pragma: no cover
    SceneBoundary = None  # type: ignore[assignment, misc]

DEFAULT_OUTPUT_DIR = '/tmp/micky_storyboard'
THUMB_W = 320
THUMB_QUALITY = 78
PREVIEW_SECONDS = 2.0
APPROVAL_TTL_SEC = 30 * 60
GRID_COLS = 3
GRID_PAD = 16
LABEL_H = 56
MAX_STORYBOARD_BYTES = 500 * 1024


@dataclass
class StoryboardTake:
    """One cell of the storyboard grid."""
    idx: int
    take: Any                       # take_selector_v2/v3 Take (duck-typed)
    thumbnail_path: str
    preview_clip_path: str
    hook_text: str = ''
    score: float = 0.0

    def to_dict(self, include_thumbnail_b64: bool = False) -> dict:
        """Plain dict for JSON / Telegram. ``take`` is flattened to the
        fields the bot UI actually needs (start, end, duration, path)."""
        meta = _take_meta(self.take)
        out: dict = {
            'idx': self.idx,
            'scene_idx': meta['scene_idx'],
            'start': round(meta['start'], 3),
            'end': round(meta['end'], 3),
            'duration': round(max(0.0, meta['end'] - meta['start']), 3),
            'source_path': meta['path'],
            'thumbnail_path': self.thumbnail_path,
            'preview_clip_path': self.preview_clip_path,
            'hook_text': self.hook_text,
            'score': round(meta['score'], 4),
            'thumbnail_b64': '',
        }
        if include_thumbnail_b64 and self.thumbnail_path and os.path.exists(self.thumbnail_path):
            try:
                with open(self.thumbnail_path, 'rb') as f:
                    out['thumbnail_b64'] = base64.b64encode(f.read()).decode('ascii')
            except OSError:
                pass
        return out


@dataclass
class Storyboard:
    """The whole storyboard grid + metadata."""
    image_path: str
    takes: List[StoryboardTake] = field(default_factory=list)
    narrative_arc: Optional[dict] = None
    created_at: float = field(default_factory=time.time)

    def to_dict(self, include_thumbnails_b64: bool = False) -> dict:
        return {
            'image_path': self.image_path,
            'takes': [t.to_dict(include_thumbnail_b64=include_thumbnails_b64)
                      for t in self.takes],
            'narrative_arc': self.narrative_arc,
            'created_at': self.created_at,
            'take_count': len(self.takes),
        }


class StoryboardGenerator:
    """Build a storyboard grid + per-take preview clips for user approval."""

    def __init__(self, output_dir: str = DEFAULT_OUTPUT_DIR) -> None:
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        self._thumbs_dir = os.path.join(self.output_dir, 'thumbnails')
        self._previews_dir = os.path.join(self.output_dir, 'previews')
        os.makedirs(self._thumbs_dir, exist_ok=True)
        os.makedirs(self._previews_dir, exist_ok=True)

    def generate_storyboard(
        self,
        takes: List[Any],
        scene_boundaries: Optional[List[Any]] = None,
        narrative_arc: Any = None,
    ) -> Storyboard:
        """Build a Storyboard from a list of takes. For each take: extract the
        middle frame as a thumbnail, extract the first 2 s as a silent preview
        clip, then compose all into a 3-column grid image with labels."""
        if not takes:
            placeholder = os.path.join(self.output_dir, 'storyboard_empty.jpg')
            self._write_placeholder(placeholder, text='No takes selected')
            return Storyboard(image_path=placeholder, takes=[], narrative_arc=None)

        storyboard_takes: List[StoryboardTake] = []
        labels: List[str] = []
        thumb_paths: List[str] = []
        for i, take in enumerate(takes):
            thumb_path = self._extract_thumbnail(take, i)
            preview_path = self._extract_preview_clip(take, i)
            hook = self._derive_hook_text(take, narrative_arc, i)
            score = _take_meta(take)['score']
            storyboard_takes.append(StoryboardTake(
                idx=i, take=take, thumbnail_path=thumb_path,
                preview_clip_path=preview_path, hook_text=hook, score=score,
            ))
            labels.append(self._format_label(i, take, score))
            thumb_paths.append(thumb_path)

        grid_path = self.format_storyboard_image(
            thumb_paths, cols=GRID_COLS, labels=labels,
        )
        grid_path = self._enforce_size_budget(grid_path)

        return Storyboard(
            image_path=grid_path, takes=storyboard_takes,
            narrative_arc=_arc_to_dict(narrative_arc),
        )

    def format_storyboard_image(
        self,
        thumbnails: List[str],
        cols: int = 3,
        labels: Optional[List[str]] = None,
    ) -> str:
        """Lay out thumbnail JPGs into a single grid image with labels (PIL)."""
        from PIL import Image, ImageDraw, ImageFont  # type: ignore

        if not thumbnails:
            out = os.path.join(self.output_dir, 'storyboard_empty.jpg')
            self._write_placeholder(out, text='No thumbnails')
            return out

        labels = labels or [f'#{i+1}' for i in range(len(thumbnails))]
        cols = max(1, min(cols, len(thumbnails)))
        rows = (len(thumbnails) + cols - 1) // cols

        cell_w = THUMB_W
        cell_h = LABEL_H + (cell_w * 9 // 16)
        grid_w = cols * cell_w + (cols + 1) * GRID_PAD
        grid_h = rows * cell_h + (rows + 1) * GRID_PAD

        grid = Image.new('RGB', (grid_w, grid_h), color=(24, 24, 28))
        draw = ImageDraw.Draw(grid)

        font = self._load_font(18)
        for i, thumb_path in enumerate(thumbnails):
            r, c = divmod(i, cols)
            x = GRID_PAD + c * (cell_w + GRID_PAD)
            y = GRID_PAD + r * (cell_h + GRID_PAD)
            label = labels[i] if i < len(labels) else f'#{i+1}'

            draw.rectangle(
                [x, y, x + cell_w, y + LABEL_H], fill=(40, 40, 48),
            )
            draw.text((x + 10, y + 16), label, fill=(255, 255, 255), font=font)

            try:
                img = Image.open(thumb_path).convert('RGB')
                img.thumbnail((cell_w, cell_w * 9 // 16))
                tx = x + (cell_w - img.width) // 2
                ty = y + LABEL_H
                grid.paste(img, (tx, ty))
            except Exception as e:
                draw.rectangle(
                    [x, y + LABEL_H, x + cell_w, y + cell_h], fill=(80, 0, 0),
                )
                draw.text(
                    (x + 10, y + LABEL_H + 8),
                    f'thumb err: {str(e)[:30]}', fill=(255, 200, 200), font=font,
                )

        out_path = os.path.join(self.output_dir, self._grid_filename())
        grid.save(out_path, 'JPEG', quality=THUMB_QUALITY, optimize=True)
        return out_path

    def export_storyboard_json(self, storyboard: Storyboard) -> dict:
        """JSON-serialisable dict for the Telegram bot (thumbnails inline)."""
        return {
            'schema': 'micky.storyboard.v1',
            'image_path': storyboard.image_path,
            'takes': [t.to_dict(include_thumbnail_b64=True) for t in storyboard.takes],
            'narrative_arc': storyboard.narrative_arc,
            'created_at': storyboard.created_at,
            'take_count': len(storyboard.takes),
        }

    def export_storyboard_pdf(
        self, storyboard: Storyboard, output_path: str,
    ) -> str:
        """Multi-page PDF (6 takes per page) with thumbnail + metadata.
        Lazily imports reportlab so the module loads without it."""
        from reportlab.lib.pagesizes import letter  # type: ignore
        from reportlab.lib.units import inch  # type: ignore
        from reportlab.platypus import (  # type: ignore
            SimpleDocTemplate, Image as RLImage, Paragraph, Spacer, PageBreak,
        )
        from reportlab.lib.styles import getSampleStyleSheet  # type: ignore

        doc = SimpleDocTemplate(
            output_path, pagesize=letter,
            leftMargin=0.5 * inch, rightMargin=0.5 * inch,
            topMargin=0.5 * inch, bottomMargin=0.5 * inch,
        )
        styles = getSampleStyleSheet()
        elements = []

        elements.append(Paragraph(
            f'<b>Micky Storyboard</b> &nbsp; '
            f'({len(storyboard.takes)} takes, '
            f'{time.strftime("%Y-%m-%d %H:%M", time.localtime(storyboard.created_at))})',
            styles['Heading2'],
        ))
        elements.append(Spacer(1, 0.2 * inch))

        per_page = 6
        for i, st in enumerate(storyboard.takes):
            d = st.to_dict(include_thumbnail_b64=False)
            elements.append(Paragraph(
                f'<b>#{d["idx"] + 1}</b> &nbsp; '
                f'start={d["start"]:.1f}s &nbsp; '
                f'duration={d["duration"]:.1f}s &nbsp; '
                f'score={d["score"]:.2f} &nbsp; '
                f'<i>{d["hook_text"]}</i>',
                styles['Normal'],
            ))
            if st.thumbnail_path and os.path.exists(st.thumbnail_path):
                try:
                    elements.append(RLImage(
                        st.thumbnail_path, width=4 * inch, height=2.25 * inch,
                    ))
                except Exception:
                    pass
            elements.append(Spacer(1, 0.15 * inch))
            if (i + 1) % per_page == 0 and (i + 1) < len(storyboard.takes):
                elements.append(PageBreak())

        if storyboard.narrative_arc:
            elements.append(Spacer(1, 0.3 * inch))
            elements.append(Paragraph('<b>Narrative Arc</b>', styles['Heading3']))
            arc = storyboard.narrative_arc
            for role in ('opening', 'rising', 'climax', 'resolution'):
                v = arc.get(role) if isinstance(arc, dict) else None
                if isinstance(v, list):
                    v = f'{len(v)} takes'
                elif isinstance(v, dict):
                    v = f'start={v.get("start", "?"):.1f}s end={v.get("end", "?"):.1f}s'
                elements.append(Paragraph(
                    f'&bull; <b>{role.title()}</b>: {v or "—"}', styles['Normal'],
                ))

        doc.build(elements)
        return output_path

    def prepare_for_user_approval(
        self,
        storyboard: Storyboard,
        approval_token: Optional[str] = None,
    ) -> dict:
        """Build the payload the Telegram bot stores alongside the photo.
        `approval_token` is a UUID (generated here if not provided) that the
        bot later stores in D1/KV with a 30-min TTL."""
        token = approval_token or str(uuid.uuid4())
        expires_at = int(time.time()) + APPROVAL_TTL_SEC
        return {
            'schema': 'micky.storyboard.approval.v1',
            'storyboard_image_path': storyboard.image_path,
            'storyboard_image_url': None,
            'approval_token': token,
            'expires_at': expires_at,
            'expires_in_sec': APPROVAL_TTL_SEC,
            'takes': [t.to_dict() for t in storyboard.takes],
            'narrative_arc': storyboard.narrative_arc,
            'take_count': len(storyboard.takes),
            'created_at': storyboard.created_at,
        }

    # Internal helpers
    def _extract_thumbnail(self, take: Any, idx: int) -> str:
        """Extract the middle frame of the take as a smaller-res JPG."""
        meta = _take_meta(take)
        if not meta['path'] or not os.path.exists(meta['path']):
            return self._placeholder_thumbnail(idx, 'no source')
        mid = (meta['start'] + meta['end']) / 2.0
        out = os.path.join(self._thumbs_dir, f'thumb_{idx:03d}.jpg')
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', f'{mid:.3f}', '-i', meta['path'],
            '-frames:v', '1', '-vf', f'scale={THUMB_W}:-2',
            '-q:v', '3', '-update', '1', out,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                return out
        except Exception as e:
            print(f'[storyboard] thumb {idx} failed: {e}')
        return self._placeholder_thumbnail(idx, 'extract failed')

    def _extract_preview_clip(self, take: Any, idx: int) -> str:
        """Extract the first 2 s of the take as a silent MP4 preview clip."""
        meta = _take_meta(take)
        if not meta['path'] or not os.path.exists(meta['path']):
            return ''
        out = os.path.join(self._previews_dir, f'preview_{idx:03d}.mp4')
        dur = max(0.0, min(PREVIEW_SECONDS, meta['end'] - meta['start']))
        if dur < 0.2:
            return ''
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', f'{meta["start"]:.3f}', '-i', meta['path'],
            '-t', f'{dur:.3f}',
            '-an',
            '-vf', 'scale=640:-2',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '24',
            '-movflags', '+faststart',
            out,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                return out
        except Exception as e:
            print(f'[storyboard] preview {idx} failed: {e}')
        return ''

    def _derive_hook_text(
        self, take: Any, narrative_arc: Any, idx: int,
    ) -> str:
        """One-line human-readable label for a take."""
        role = _role_for_take(take, narrative_arc)
        if role:
            return f'take #{idx + 1} · {role}'
        return f'take #{idx + 1}'

    def _format_label(self, idx: int, take: Any, score: float) -> str:
        meta = _take_meta(take)
        dur = max(0.0, meta['end'] - meta['start'])
        return f'#{idx + 1} · {dur:.1f}s · {score:.2f}'

    def _grid_filename(self) -> str:
        h = hashlib.sha1(f'{time.time()}{uuid.uuid4()}'.encode()).hexdigest()[:12]
        return f'storyboard_{h}.jpg'

    def _enforce_size_budget(self, path: str) -> str:
        """Re-encode the JPG at progressively lower quality until <500 KB.
        Idempotent: leaves an already-small file untouched."""
        if not os.path.exists(path) or os.path.getsize(path) <= MAX_STORYBOARD_BYTES:
            return path
        try:
            from PIL import Image  # type: ignore
        except ImportError:
            return path
        img = Image.open(path).convert('RGB')
        for q in (70, 60, 50, 40, 30):
            tmp = path.replace('.jpg', f'_q{q}.jpg')
            img.save(tmp, 'JPEG', quality=q, optimize=True)
            if os.path.getsize(tmp) <= MAX_STORYBOARD_BYTES:
                shutil.move(tmp, path)
                return path
            os.remove(tmp)
        w, h = img.size
        scale = 0.75
        while scale > 0.2:
            small = img.resize((int(w * scale), int(h * scale)))
            small.save(path, 'JPEG', quality=50, optimize=True)
            if os.path.getsize(path) <= MAX_STORYBOARD_BYTES:
                return path
            scale -= 0.15
        return path

    def _placeholder_thumbnail(self, idx: int, reason: str) -> str:
        try:
            from PIL import Image, ImageDraw  # type: ignore
        except ImportError:
            return ''
        out = os.path.join(self._thumbs_dir, f'thumb_{idx:03d}_err.jpg')
        img = Image.new('RGB', (THUMB_W, THUMB_W * 9 // 16), color=(40, 0, 0))
        d = ImageDraw.Draw(img)
        d.text((10, 10), f'#{idx} {reason}', fill=(255, 200, 200))
        img.save(out, 'JPEG', quality=80)
        return out

    def _write_placeholder(self, path: str, text: str) -> None:
        try:
            from PIL import Image, ImageDraw  # type: ignore
            img = Image.new('RGB', (640, 360), color=(24, 24, 28))
            d = ImageDraw.Draw(img)
            d.text((20, 160), text, fill=(200, 200, 200))
            img.save(path, 'JPEG', quality=80)
        except ImportError:
            with open(path, 'wb') as f:
                f.write(b'\xff\xd8\xff\xe0\x00\x10JFIF')

    @staticmethod
    def _load_font(size: int):  # type: ignore[no-untyped-def]
        from PIL import ImageFont  # type: ignore
        for fpath in (
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        ):
            if os.path.exists(fpath):
                try:
                    return ImageFont.truetype(fpath, size)
                except Exception:
                    pass
        return ImageFont.load_default()


# Module-level helpers — kept outside the class so the dataclass's to_dict
# can call them without holding a StoryboardGenerator reference.
def _take_meta(take: Any) -> dict:
    """Flatten a Take object (dataclass or dict) into a plain dict."""
    if isinstance(take, dict):
        start = float(take.get('start', 0.0))
        end = float(take.get('end', 0.0))
        path = take.get('path', '') or ''
        scene_idx = take.get('scene_idx', 0)
        sc = take.get('score', 0.0)
    elif hasattr(take, 'start'):
        start = float(getattr(take, 'start', 0.0))
        end = float(getattr(take, 'end', 0.0))
        path = getattr(take, 'path', '') or ''
        scene_idx = getattr(take, 'scene_idx', 0)
        sc = getattr(take, 'score', 0.0)
    else:
        start, end, path, scene_idx = 0.0, 0.0, '', 0
        sc = 0.0
    # Normalise the score: TakeScore dataclass, dict, or scalar.
    if hasattr(sc, 'overall'):
        score = float(getattr(sc, 'overall', 0.0))
    elif isinstance(sc, dict):
        score = float(sc.get('overall', 0.0))
    else:
        try:
            score = float(sc or 0.0)
        except (TypeError, ValueError):
            score = 0.0
    return {
        'start': start, 'end': end, 'path': path,
        'scene_idx': scene_idx, 'score': score,
    }


def _arc_to_dict(narrative_arc: Any) -> Optional[dict]:
    """Normalise a NarrativeArc (dataclass or dict) to a plain dict."""
    if narrative_arc is None:
        return None
    if hasattr(narrative_arc, 'to_dict'):
        try:
            return narrative_arc.to_dict()
        except Exception:
            return None
    if isinstance(narrative_arc, dict):
        return narrative_arc
    return None


def _role_for_take(take: Any, narrative_arc: Any) -> str:
    """Return 'opening' / 'climax' / 'resolution' if `take` is the arc's
    anchor in that role, otherwise ''."""
    if narrative_arc is None:
        return ''
    arc = _arc_to_dict(narrative_arc)
    if not arc:
        return ''
    take_start = _take_meta(take)['start']
    for role in ('opening', 'climax', 'resolution'):
        v = arc.get(role)
        if isinstance(v, dict) and abs(float(v.get('start', -1)) - take_start) < 0.5:
            return role
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and abs(float(item.get('start', -1)) - take_start) < 0.5:
                    return role
    return ''
