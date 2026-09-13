#!/usr/bin/env python3
"""Compatibility entrypoint for the current TAF Engine v2 finalizer."""
from finalize_central_message_architecture_v2 import *  # noqa: F401,F403


if __name__ == "__main__":
    raise SystemExit(main())
