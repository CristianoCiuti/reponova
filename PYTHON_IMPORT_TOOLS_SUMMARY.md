# Python Import Resolution Tools - Quick Reference

## 🎯 Top 3 Recommendations for Node.js

### 1. **import-cruiser** ⭐ BEST FOR CLI
- **Status**: ✅ Actively maintained (March 2026)
- **JSON Output**: ✅ Yes
- **CLI**: ✅ Yes
- **Node.js Integration**: Direct CLI call
```bash
import-cruiser analyze . --format json
```

### 2. **findimports** ⭐ SIMPLEST
- **Status**: ✅ Actively maintained (Dec 2025)
- **JSON Output**: ✅ Yes
- **CLI**: ✅ Yes
- **Node.js Integration**: Direct CLI call
```bash
findimports -j src
```

### 3. **grimp** ⭐ MOST POWERFUL
- **Status**: ✅ Actively maintained (2026)
- **JSON Output**: ❌ No (requires wrapper)
- **CLI**: ❌ No (Python API only)
- **Node.js Integration**: Python subprocess
```python
import grimp
graph = grimp.build_graph('package')
```

---

## Feature Comparison

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

## ❌ Tools to AVOID

| Tool | Reason |
|------|--------|
| **importlab** | Archived May 2025 (Google stopped maintaining) |
| **snakefood** | Unmaintained since 2013, no Python 3 support |
| **pyright** | Designed for IDE integration, not CLI analysis |
| **rope** | Refactoring library, overkill for import analysis |
| **tree-sitter** | AST parsing only, doesn't resolve imports |

---

## Implementation Examples

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

```python
# import_resolver.py
import grimp
import json
import sys

graph = grimp.build_graph(sys.argv[1])
result = {
    'modules': list(graph.modules),
    'imports': [
        {
            'from': imp[0],
            'to': imp[1]
        }
        for imp in graph.direct_import_pairs
    ]
}
print(json.dumps(result))
```

---

## Installation

```bash
# import-cruiser
pip install import-cruiser

# findimports
pip install findimports

# grimp
pip install grimp
```

---

## Key Capabilities Explained

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

## Decision Tree

```
Do you need JSON output?
├─ YES
│  ├─ Do you want CLI-first design?
│  │  ├─ YES → import-cruiser ⭐
│  │  └─ NO → findimports ⭐
│  └─ NO
│     └─ Do you need complex queries?
│        ├─ YES → grimp (with wrapper)
│        └─ NO → findimports
└─ NO
   └─ Do you need complex queries?
      ├─ YES → grimp
      └─ NO → pydeps (visualization)
```

---

## Performance

| Tool | Speed | Memory | Notes |
|------|-------|--------|-------|
| **grimp** | ⚡⚡⚡ | 💾💾 | Rust-accelerated |
| **import-cruiser** | ⚡⚡ | 💾💾 | Good performance |
| **findimports** | ⚡⚡ | 💾 | Lightweight |
| **tree-sitter** | ⚡⚡⚡ | 💾 | WASM-compatible |

---

## Maintenance Status (May 2026)

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

## Conclusion

**For Node.js projects:**
1. **First choice**: `import-cruiser` (best CLI + JSON)
2. **Second choice**: `findimports` (simpler, lightweight)
3. **Third choice**: `grimp` (most powerful, requires wrapper)

**Avoid:**
- importlab (archived)
- snakefood (unmaintained)
- pyright (too complex)
- tree-sitter alone (AST only)

---

## References

- **import-cruiser**: https://github.com/kevin91nl/import-cruiser
- **findimports**: https://pypi.org/project/findimports/
- **grimp**: https://github.com/python-grimp/grimp
- **Full Analysis**: See `PYTHON_IMPORT_TOOLS_ANALYSIS.txt`
