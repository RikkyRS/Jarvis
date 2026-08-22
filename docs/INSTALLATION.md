# Installation

Requirements: Node.js 22.5+ (for `node:sqlite`) and Git.

```bash
git clone https://github.com/RikkyRS/Jarvis.git
cd jarvis
npm install
npm run ci
npm run build
npm install -g .
```

Verify:

```bash
jarvis doctor
```

On a target project:

```bash
cd /path/to/your/project
jarvis plan "your objective"
# or: jarvis planeje "…" (Portuguese aliases)
```

Inside the JARVIS runtime repo itself, use `--project` for the target path.

No silent auto-updates. IDE adapters are optional; the CLI is the primary interface.
