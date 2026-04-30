"""
Sample Python module for testing the extraction engine.
Contains functions, classes, imports, decorators, and cross-references.
"""
import os
import sys
from pathlib import Path
from typing import Optional, List

# Module-level constant
DEFAULT_CONFIG = "config.yaml"
MAX_RETRIES = 3


def load_config(path: str, env: str = "prod") -> dict:
    """Load configuration from a YAML file."""
    full_path = Path(path)
    if not full_path.exists():
        raise FileNotFoundError(f"Config not found: {path}")
    return validate_config(read_file(full_path))


def validate_config(data: dict) -> dict:
    """Validate configuration data."""
    if "version" not in data:
        raise ValueError("Missing version field")
    return data


def read_file(path: Path) -> dict:
    """Read and parse a file."""
    return {}


class BaseProcessor:
    """Base class for all processors."""

    def __init__(self, config: dict):
        self.config = config
        self.logger = self._setup_logger()

    def _setup_logger(self):
        """Set up logging."""
        return None

    def process(self, data: list) -> list:
        """Process a batch of data."""
        return [self.transform(item) for item in data]

    def transform(self, item):
        """Transform a single item. Override in subclasses."""
        return item


class DataProcessor(BaseProcessor):
    """Processes data records with validation."""

    def __init__(self, config: dict, schema: dict):
        super().__init__(config)
        self.schema = schema

    @staticmethod
    def from_file(path: str) -> "DataProcessor":
        """Create a DataProcessor from a config file."""
        config = load_config(path)
        return DataProcessor(config, {})

    def transform(self, item):
        """Transform with schema validation."""
        validate_config(item)
        return item


@staticmethod
def helper_function():
    """A decorated top-level function."""
    pass


class NestedExample:
    """Class with nested class."""

    class InnerHelper:
        """Inner helper class."""

        def help(self):
            return True

    def use_inner(self):
        helper = self.InnerHelper()
        return helper.help()
