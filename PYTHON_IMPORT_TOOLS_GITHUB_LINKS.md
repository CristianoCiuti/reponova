# Python Import Resolution Tools - GitHub & PyPI Links

## ⭐ TOP 3 RECOMMENDED

### 1. import-cruiser
- **GitHub**: https://github.com/kevin91nl/import-cruiser
- **PyPI**: https://pypi.org/project/import-cruiser/
- **Latest Release**: v0.2.38 (March 30, 2026)
- **License**: MIT
- **Status**: ✅ Actively maintained

**Key Repo Files**:
- Main CLI: https://github.com/kevin91nl/import-cruiser/blob/main/src/import_cruiser/cli.py
- Analyzer: https://github.com/kevin91nl/import-cruiser/blob/main/src/import_cruiser/analyzer.py
- JSON Export: https://github.com/kevin91nl/import-cruiser/blob/main/src/import_cruiser/exporters/json_exporter.py

---

### 2. findimports
- **GitHub**: https://github.com/mgedmin/findimports
- **PyPI**: https://pypi.org/project/findimports/
- **Latest Release**: v3.0.0 (December 8, 2025)
- **License**: MIT
- **Status**: ✅ Actively maintained

**Key Repo Files**:
- Main module: https://github.com/mgedmin/findimports/blob/master/src/findimports/__init__.py
- CLI: https://github.com/mgedmin/findimports/blob/master/src/findimports/__main__.py

---

### 3. grimp
- **GitHub**: https://github.com/python-grimp/grimp
- **PyPI**: https://pypi.org/project/grimp/
- **Latest Release**: Multiple releases in 2026
- **License**: BSD-2-Clause
- **Status**: ✅ Actively maintained

**Key Repo Files**:
- Graph builder: https://github.com/python-grimp/grimp/blob/main/src/grimp/graph.py
- Import analysis: https://github.com/python-grimp/grimp/blob/main/src/grimp/importers/
- Rust acceleration: https://github.com/python-grimp/grimp/tree/main/rust

---

## ⚠️ TOOLS TO AVOID

### importlab (ARCHIVED)
- **GitHub**: https://github.com/google/importlab
- **Status**: ❌ **ARCHIVED** (May 6, 2025)
- **Last Release**: v0.8.1
- **Why Archived**: Pytype moved to different strategy, maintenance burden too high

**Archive Notice**: https://github.com/google/importlab/blob/main/README.rst

---

### snakefood (UNMAINTAINED)
- **GitHub**: https://github.com/blais/snakefood
- **Status**: ❌ **UNMAINTAINED** (last release 2013)
- **Python Support**: Python 2 only (no Python 3)
- **Why Dead**: No Python 3 support, better alternatives available

---

## 📚 ALTERNATIVE TOOLS

### modulegraph2
- **GitHub**: https://github.com/ronaldoussoren/modulegraph
- **PyPI**: https://pypi.org/project/modulegraph2/
- **Latest Release**: v2.4 (November 2025)
- **License**: MIT
- **Status**: ✅ Maintained

**Key Repo Files**:
- Main module: https://github.com/ronaldoussoren/modulegraph/blob/master/modulegraph/modulegraph.py

---

### pydeps
- **GitHub**: https://github.com/thebjorn/pydeps
- **PyPI**: https://pypi.org/project/pydeps/
- **Latest Release**: v3.0.6
- **License**: MIT
- **Status**: ✅ Maintained

**Key Repo Files**:
- Dependency graph: https://github.com/thebjorn/pydeps/blob/master/pydeps/depgraph.py
- CLI: https://github.com/thebjorn/pydeps/blob/master/pydeps/pydeps.py

---

### rope (Python Refactoring Library)
- **GitHub**: https://github.com/python-rope/rope
- **PyPI**: https://pypi.org/project/rope/
- **Latest Release**: v1.14.0 (July 2025)
- **License**: LGPL-3.0
- **Status**: ✅ Actively maintained

**Key Repo Files**:
- Import handling: https://github.com/python-rope/rope/tree/master/rope/base/oi
- Project API: https://github.com/python-rope/rope/blob/master/rope/base/project.py

---

### import-deps
- **GitHub**: https://github.com/mgedmin/import-deps
- **PyPI**: https://pypi.org/project/import-deps/
- **Latest Release**: v0.5.1 (January 9, 2026)
- **License**: MIT
- **Status**: ✅ Maintained

**Key Repo Files**:
- AST imports: https://github.com/mgedmin/import-deps/blob/master/src/import_deps/__init__.py

---

### pyright (LSP-based)
- **GitHub**: https://github.com/microsoft/pyright
- **NPM**: https://www.npmjs.com/package/pyright
- **Latest Release**: 2026
- **License**: MIT
- **Status**: ✅ Actively maintained

**Key Repo Files**:
- Import resolution: https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md
- Type stubs: https://github.com/microsoft/pyright/blob/main/docs/type-stubs.md

---

### tree-sitter-python (AST Parsing)
- **GitHub**: https://github.com/tree-sitter/tree-sitter-python
- **NPM**: https://www.npmjs.com/package/tree-sitter-python
- **PyPI**: https://pypi.org/project/tree-sitter/
- **License**: MIT
- **Status**: ✅ Maintained

**Key Repo Files**:
- Grammar: https://github.com/tree-sitter/tree-sitter-python/blob/master/grammar.js
- Python bindings: https://github.com/tree-sitter/py-tree-sitter

---

## 🔗 RELATED TOOLS & RESOURCES

### Dependency Analysis Tools
- **dependency-cruiser** (JavaScript): https://github.com/sverweij/dependency-cruiser
- **CodeMap**: https://github.com/POLPROG-TECH/CodeMap
- **impulse**: https://github.com/seddonym/impulse

### Type Checking & Analysis
- **mypy**: https://github.com/python/mypy
- **pylint**: https://github.com/pylint-dev/pylint
- **flake8**: https://github.com/PyCQA/flake8

### LSP Servers
- **Pylance**: https://github.com/microsoft/pylance-release
- **basedpyright**: https://github.com/detachhead/basedpyright

---

## 📊 COMPARISON MATRIX

| Tool | GitHub Stars | Last Commit | Python Support | JSON Output |
|------|--------------|-------------|-----------------|-------------|
| **import-cruiser** | ~50 | March 2026 | 3.8+ | ✅ |
| **findimports** | ~100 | Dec 2025 | 3.6+ | ✅ |
| **grimp** | 119 | 2026 | 3.8+ | ❌ |
| **modulegraph2** | ~50 | Nov 2025 | 3.10+ | ❌ |
| **pydeps** | ~500 | 2025 | 3.6+ | ❌ |
| **rope** | 2.2k | 2025 | 3.8+ | ❌ |
| **pyright** | 12k | 2026 | 3.7+ | ❌ |
| **importlab** | 179 | May 2025 | 2.7, 3.5+ | ❌ |
| **snakefood** | ~100 | 2013 | 2.7 only | ❌ |

---

## 🚀 QUICK START COMMANDS

### Install Top 3
```bash
pip install import-cruiser findimports grimp
```

### Test import-cruiser
```bash
import-cruiser analyze . --format json --output deps.json
```

### Test findimports
```bash
findimports -j src > imports.json
```

### Test grimp
```python
import grimp
graph = grimp.build_graph('mypackage')
print(graph.find_modules_directly_imported_by('mypackage.foo'))
```

---

## 📝 DOCUMENTATION LINKS

### import-cruiser
- README: https://github.com/kevin91nl/import-cruiser/blob/main/README.md
- PyPI: https://pypi.org/project/import-cruiser/

### findimports
- README: https://github.com/mgedmin/findimports/blob/master/README.md
- PyPI: https://pypi.org/project/findimports/

### grimp
- Docs: https://grimp.readthedocs.io/
- GitHub: https://github.com/python-grimp/grimp
- PyPI: https://pypi.org/project/grimp/

### pyright
- Docs: https://github.com/microsoft/pyright/blob/main/docs/
- Import Resolution: https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md

---

## 🎯 DECISION GUIDE

**Choose import-cruiser if:**
- You want CLI-first design
- You need JSON output
- You want active maintenance
- You're using Node.js

**Choose findimports if:**
- You want simplicity
- You need lightweight tool
- You want JSON output
- You prefer minimal dependencies

**Choose grimp if:**
- You need complex queries
- You want queryable graph API
- You can use Python subprocess
- You need cycle detection

**Avoid:**
- importlab (archived)
- snakefood (unmaintained)
- pyright (too complex for CLI)
- tree-sitter alone (AST only)

---

## 📞 SUPPORT & ISSUES

### Report Issues
- **import-cruiser**: https://github.com/kevin91nl/import-cruiser/issues
- **findimports**: https://github.com/mgedmin/findimports/issues
- **grimp**: https://github.com/python-grimp/grimp/issues

### Discussions
- **grimp**: https://github.com/python-grimp/grimp/discussions
- **pyright**: https://github.com/microsoft/pyright/discussions

---

## 📄 LICENSE INFORMATION

| Tool | License | Commercial Use |
|------|---------|-----------------|
| **import-cruiser** | MIT | ✅ Yes |
| **findimports** | MIT | ✅ Yes |
| **grimp** | BSD-2-Clause | ✅ Yes |
| **modulegraph2** | MIT | ✅ Yes |
| **pydeps** | MIT | ✅ Yes |
| **rope** | LGPL-3.0 | ✅ Yes (with conditions) |
| **pyright** | MIT | ✅ Yes |
| **importlab** | Apache 2.0 | ✅ Yes |

---

**Last Updated**: May 9, 2026
**Analysis Date**: May 9, 2026
**Python Version**: 3.11.9
