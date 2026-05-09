# Python Import Resolution Tools - Complete Research Index

**Research Date**: May 9, 2026  
**Scope**: Tools for resolving Python imports with complex features (wildcards, re-exports, relative imports, `__all__`, package resolution)  
**Target**: Node.js integration (CLI, bindings, WASM)

---

## 📋 DOCUMENTS IN THIS ANALYSIS

### 1. **PYTHON_IMPORT_TOOLS_SUMMARY.md** ⭐ START HERE
Quick reference guide with:
- Top 3 recommendations
- Feature comparison table
- Implementation examples
- Decision tree
- Performance comparison

**Best for**: Quick decision-making, implementation examples

---

### 2. **PYTHON_IMPORT_TOOLS_ANALYSIS.txt**
Comprehensive deep-dive with:
- Detailed analysis of 12 tools
- Capability matrix
- Wildcard import handling
- Re-export handling
- Relative import handling
- Namespace package support
- Performance comparison
- Implementation strategies

**Best for**: Understanding all options, detailed evaluation

---

### 3. **PYTHON_IMPORT_TOOLS_LINKS.md**
Quick reference with:
- GitHub links
- PyPI links
- Latest releases
- License information
- Quick start commands

**Best for**: Finding official repositories, installation

---

## 🎯 QUICK DECISION GUIDE

### For Node.js Projects

**Choose import-cruiser if:**
- ✅ You want CLI-first design
- ✅ You need JSON output
- ✅ You want active maintenance
- ✅ You're using Node.js

**Choose findimports if:**
- ✅ You want simplicity
- ✅ You need lightweight tool
- ✅ You want JSON output
- ✅ You prefer minimal dependencies

**Choose grimp if:**
- ✅ You need complex queries
- ✅ You want queryable graph API
- ✅ You can use Python subprocess
- ✅ You need cycle detection

---

## ⭐ TOP 3 RECOMMENDATIONS

### 1. **import-cruiser** (BEST FOR CLI)
```bash
pip install import-cruiser
import-cruiser analyze . --format json
```
- ✅ CLI-first design
- ✅ JSON output
- ✅ Actively maintained (March 2026)
- ✅ No wrapper needed

### 2. **findimports** (SIMPLEST)
```bash
pip install findimports
findimports -j src
```
- ✅ Simple and lightweight
- ✅ JSON output
- ✅ Recently updated (Dec 2025)
- ✅ No dependencies

### 3. **grimp** (MOST POWERFUL)
```bash
pip install grimp
python3 -c "import grimp; g = grimp.build_graph('pkg'); print(...)"
```
- ✅ Most powerful API
- ✅ Queryable graph
- ✅ Rust-accelerated
- ✅ Actively maintained (2026)

---

## ❌ TOOLS TO AVOID

| Tool | Reason | Status |
|------|--------|--------|
| **importlab** | Archived May 2025 | ❌ Dead |
| **snakefood** | Unmaintained since 2013 | ❌ Dead |
| **pyright** | Too complex for CLI | ⚠️ Overkill |
| **rope** | Refactoring library | ⚠️ Overkill |
| **tree-sitter** | AST parsing only | ⚠️ Incomplete |

---

## 📊 FEATURE COMPARISON

| Feature | import-cruiser | findimports | grimp | pyright | importlab |
|---------|---|---|---|---|---|
| **Maintained** | ✅ 2026 | ✅ 2025 | ✅ 2026 | ✅ 2026 | ❌ Archived |
| **JSON Output** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **CLI** | ✅ | ✅ | ❌ | ⚠️ | ✅ |
| **Wildcard Imports** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Re-exports** | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| **Relative Imports** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **__all__ Support** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Namespace Packages** | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| **Node.js Ready** | ✅ | ✅ | ⚠️ | ❌ | ⚠️ |

---

## 🔗 GITHUB REPOSITORIES

### Recommended Tools
- **import-cruiser**: https://github.com/kevin91nl/import-cruiser
- **findimports**: https://github.com/mgedmin/findimports
- **grimp**: https://github.com/python-grimp/grimp

### Alternative Tools
- **modulegraph2**: https://github.com/ronaldoussoren/modulegraph
- **pydeps**: https://github.com/thebjorn/pydeps
- **rope**: https://github.com/python-rope/rope
- **import-deps**: https://github.com/mgedmin/import-deps
- **pyright**: https://github.com/microsoft/pyright
- **tree-sitter-python**: https://github.com/tree-sitter/tree-sitter-python

### Archived/Unmaintained
- **importlab**: https://github.com/google/importlab (ARCHIVED May 2025)
- **snakefood**: https://github.com/blais/snakefood (UNMAINTAINED since 2013)

---

## 💻 IMPLEMENTATION EXAMPLES

### Option A: import-cruiser (Recommended)
```javascript
const { execSync } = require('child_process');

function getImportGraph(projectPath) {
  const output = execSync(
    `import-cruiser analyze ${projectPath} --format json`,
    { encoding: 'utf-8' }
  );
  return JSON.parse(output);
}
```

### Option B: findimports (Simple)
```javascript
const { execSync } = require('child_process');

function getImportGraph(projectPath) {
  const output = execSync(
    `findimports -j ${projectPath}`,
    { encoding: 'utf-8' }
  );
  return JSON.parse(output);
}
```

### Option C: grimp (Most Powerful)
```javascript
const { spawn } = require('child_process');

function getImportGraph(projectPath) {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['./import_resolver.py', projectPath]);
    let output = '';
    
    python.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    python.on('close', (code) => {
      if (code === 0) {
        resolve(JSON.parse(output));
      } else {
        reject(new Error('Import resolution failed'));
      }
    });
  });
}
```

---

## 🚀 INSTALLATION

```bash
# Install all three recommended tools
pip install import-cruiser findimports grimp

# Or install individually
pip install import-cruiser  # Best CLI
pip install findimports     # Simplest
pip install grimp           # Most powerful
```

---

## 📈 MAINTENANCE STATUS (May 2026)

| Tool | Last Release | Status |
|------|--------------|--------|
| **import-cruiser** | March 2026 | ✅ Active |
| **findimports** | Dec 2025 | ✅ Active |
| **grimp** | 2026 | ✅ Active |
| **modulegraph2** | Nov 2025 | ✅ Active |
| **pydeps** | 2025 | ✅ Active |
| **rope** | July 2025 | ✅ Active |
| **pyright** | 2026 | ✅ Active |
| **importlab** | May 2025 | ❌ Archived |
| **snakefood** | 2013 | ❌ Dead |

---

## 🎓 KEY CONCEPTS

### Wildcard Imports
Handles `from module import *` correctly, including `__all__` expansion.

### Re-exports
Follows imports through `__init__.py` files:
```python
# package/__init__.py
from .submodule import SomeClass  # Re-exported

# Can resolve: from package import SomeClass
```

### Relative Imports
Handles `from . import x` and `from .. import y` correctly.

### __all__ Support
Respects `__all__` definitions for wildcard imports.

### Namespace Packages
Supports PEP 420 namespace packages (no `__init__.py` required).

---

## 📚 RESEARCH METHODOLOGY

This analysis was conducted by:

1. **Web Search**: Searched for Python import resolution tools (2026)
2. **GitHub Analysis**: Examined repositories for maintenance status
3. **PyPI Analysis**: Checked latest releases and version history
4. **Feature Evaluation**: Tested each tool's capabilities
5. **Comparison**: Created feature matrices and decision trees
6. **Documentation**: Reviewed official docs and README files

**Tools Evaluated**: 12 major tools
**Time Period**: May 9, 2026
**Python Version**: 3.11.9

---

## 🔍 RESEARCH FINDINGS

### Key Discoveries

1. **importlab is archived** (May 2025)
   - Google stopped maintaining it
   - Pytype moved to different strategy
   - Better alternatives available

2. **snakefood is unmaintained** (since 2013)
   - No Python 3 support
   - Better alternatives available

3. **import-cruiser is newest** (actively maintained 2026)
   - CLI-first design
   - JSON output
   - Perfect for Node.js

4. **grimp is most powerful** (Rust-accelerated)
   - Queryable graph API
   - Cycle detection
   - Requires Python wrapper for JSON

5. **findimports is simplest** (lightweight, no dependencies)
   - JSON output
   - Recently updated (Dec 2025)
   - Good for simple use cases

---

## ✅ NEXT STEPS

1. **Evaluate import-cruiser** for CLI-based approach
2. **Test with your codebase** to verify wildcard/re-export handling
3. **Consider grimp** if you need programmatic access
4. **Avoid importlab** (archived) and snakefood (unmaintained)
5. **Don't use tree-sitter alone** - it's AST parsing, not resolution

---

## 📞 SUPPORT

### Report Issues
- **import-cruiser**: https://github.com/kevin91nl/import-cruiser/issues
- **findimports**: https://githu
