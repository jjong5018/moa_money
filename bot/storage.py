"""Paths shared by the dashboard and KIS client."""

import os
from pathlib import Path


def data_path(filename: str) -> Path:
    directory = Path(os.environ.get("MOA_DATA_DIR") or Path(__file__).resolve().parent.parent)
    directory.mkdir(parents=True, exist_ok=True)
    return directory / filename
