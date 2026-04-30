"""
Second sample module that imports from sample_module.
Used for testing cross-file import resolution.
"""
from sample_module import DataProcessor, load_config
from pathlib import Path


class ExtendedProcessor(DataProcessor):
    """Extended processor with custom logic."""

    def transform(self, item):
        """Custom transform."""
        result = super().transform(item)
        self.log_result(result)
        return result

    def log_result(self, result):
        """Log the transformation result."""
        pass


def run_pipeline(config_path: str) -> list:
    """Run the full processing pipeline."""
    config = load_config(config_path)
    processor = ExtendedProcessor(config, {})
    data = fetch_data()
    return processor.process(data)


def fetch_data() -> list:
    """Fetch data from source."""
    return []
