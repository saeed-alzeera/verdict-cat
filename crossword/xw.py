#!/usr/bin/env python3
"""Crossword construction CLI. Run `python3 crossword/xw.py --help`."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xw.cli import main
if __name__ == '__main__':
    sys.exit(main())
