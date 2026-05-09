# Python Import Resolution Tools - GitHub & PyPI Links

## ⭐ TOP 3 RECOMMENDED

### 1. import-cruiser
- **GitHub**: https://github.com/kevin91nl/import-cruiser
- **PyPI**: https://pypi.org/project/import-cruiser/
- **Latest Release**: v0.2.38 (March 30, 2026)
- **License**: MIT
- **Status**: ✅ Actively maintained

### 2. findimports
- **GitHub**: https://github.com/mgedmin/findimports
- **PyPI**: https://pypi.org/project/findimports/
- **Latest Release**: v3.0.0 (December 8, 2025)
- **License**: MIT
- **Status**: ✅ Actively maintained

### 3. grimp
- **GitHub**: https://github.com/python-grimp/grimp
- **PyPI**: https://pypi.org/project/grimp/
- **Latest Release**: Multiple releases in 2026
- **License**: BSD-2-Clause
- **Status**: ✅ Actively maintained

---

## ⚠️ TOOLS TO AVOID

### importlab (ARCHIVED)
- **GitHub**: https://github.com/google/importlab
- **Status**: ❌ **ARCHIVED** (May 6, 2025)
- **Why**: Pytype moved to different strategy

### snakefood (UNMAINTAINED)
- **GitHub**: https://github.com/blais/snakefood
- **Status**: ❌ **UNMAINTAINED** (last release 2013)
- **Why**: No Python 3 support

---

## 📚 ALTERNATIVE TOOLS

### modulegraph2
- **GitHub**: https://github.com/ronaldoussoren/modulegraph
- **PyPI**: https://pypi.org/project/modulegraph2/
- **Latest**: v2.4 (November 2025)

### pydeps
- **GitHub**: https://github.com/thebjorn/pydeps
- **PyPI**: https://pypi.org/project/pydeps/
- **Latest**: v3.0.6

### rope
- **GitHub**: https://github.com/python-rope/rope
- **PyPI**: https://pypi.org/project/rope/
- **Latest**: v1.14.0 (July 2025)

### import-deps
- **GitHub**: https://github.com/mgedmin/import-deps
- **PyPI**: https://pypi.org/project/import-deps/
- **Latest**: v0.5.1 (January 9, 2026)

### pyright
- **GitHub**: https://github.com/microsoft/pyright
- **NPM**: https://www.npmjs.com/package/pyright
- **Docs**: https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md

### tree-sitter-python
- **GitHub**: https://github.com/tree-sitter/tree-sitter-python
- **NPM**: https://www.npmjs.com/package/tree-sitter-python
- **PyPI**: https://pypi.org/project/tree-sitter/

---

## 🚀 QUICK START

```bash
# Install top 3
pip install import-cruiser findimports grimp

# Test import-cruiser
import-cruiser analyze . --format json

# Test findimports
findimports -j src

# Test grimp
python3 -c "import grimp; g = grimp.build_graph('pkg'); print(g.modules)"
```

---

**Last Updated**: May 9, 2026
