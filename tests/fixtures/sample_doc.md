# Architecture Overview

This document describes the high-level architecture of the system.

## Components

The system is composed of three main modules:

- `ConfigLoader` handles configuration parsing
- `DataProcessor` transforms raw input
- `OutputGenerator` produces final results

## Data Flow

Data flows from `src/input/reader.py` through the processing pipeline
to `src/output/writer.py`.

### Input Stage

The input stage uses `validate_schema` to ensure data integrity.

### Processing Stage

Processing is handled by the `transform_data` function in the core module.

## Configuration

See `config/settings.py` for default values.
