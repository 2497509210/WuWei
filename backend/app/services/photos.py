from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
from typing import BinaryIO
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_PHOTO_BYTES = 8 * 1024 * 1024


class PhotoValidationError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class EncodedPhoto:
    content: bytes
    source_hash: str


def encode_photo(source: BinaryIO) -> EncodedPhoto:
    """Validate bounded input, normalize orientation, strip metadata and encode JPEG."""
    raw = source.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise PhotoValidationError(413, "photo_too_large", "照片不能超过 8 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as opened:
                if opened.width * opened.height > 20_000_000:
                    raise PhotoValidationError(400, "invalid_image", "照片分辨率过大")
                opened.load()
                converted = ImageOps.exif_transpose(opened).convert("RGB")
                try:
                    converted.thumbnail((2000, 2000))
                    encoded = io.BytesIO()
                    converted.save(encoded, format="JPEG", quality=85)
                finally:
                    converted.close()
    except PhotoValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise PhotoValidationError(400, "invalid_image", "请上传有效的图片") from exc
    return EncodedPhoto(content=encoded.getvalue(), source_hash=hashlib.sha256(raw).hexdigest())
