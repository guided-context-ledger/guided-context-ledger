GCL — Guided Context Ledger
GCL aims to preserve workspace continuity across complex systems involving people, places, and technology.
This is achieved by ensuring the what, when, and why is recorded, deciding factors are known, and the state of work is preserved — so any person or agent, in any session, using any vendor, can pick up exactly where things left off.
GCL is not a security product, not a competitor to A2A or OKF, and not tied to any vendor or transport. It complements both standards and is designed to outlive any single integration.
Start here
No install — 60 seconds
A GCL workspace is plain files. No account, no integration required.
Open any AI assistant that can read files — Claude, ChatGPT, Gemini, or similar.
Point it at this workspace and say: "Read workspace.manifest.md first, then follow the cold-start read order inside it."
Done. The manifest bootstraps itself. Any agent that can read markdown can orient.
Connected — live multi-session setup
When you want an agent to retrieve context and write back to the ledger safely, connect a GCL runtime via MCP.
Prerequisite: Start on the GCL GitHub repo page.
1. Clone
No terminal:
1a. Click the green Code button near the top right of the repo page
1b. Click Download ZIP
1c. Once downloaded, unzip the folder to wherever you want it to live on your machine
Terminal:
1a. Click the green Code button, copy the URL shown
1b. In your terminal, run:
Bash
1c. Then run:
Bash
2. Set up
2a. Open your MCP client config file:
Claude Desktop: Settings → Developer → Edit Config (claude_desktop_config.json)
Claude Code: use the terminal shortcut in 2c below
Other MCP clients: check your client's documentation for config location
2b. Add the following block, replacing the paths with the actual locations on your machine:
Json
2c. Claude Code shortcut — skip 2a and 2b and run this instead:
Bash
2d. Fully close and restart your MCP client. Configs don't take effect on an already-open connection.
3. Use
3a. In your MCP client, call orient
3b. You should see the server version, your workspace path confirmed, and — if this is a new workspace — first-run guidance walking you through setup
3c. If orient echoes back the GCL_WORKSPACE path you set, you're connected and ready
First run
If your workspace is new, orient will tell you. From there your agent walks you through the rest — creating your profile, registering in the manifest, and making your first commit. You don't need to do anything manually unless you want to.
What GCL is
GCL has two layers:
1. The knowledge layer — OKF-aligned.
Notes, decisions, identity, and project context live as plain markdown files with YAML frontmatter, aligned with the Open Knowledge Format. Any editor can read them. Any agent can consume them. No lock-in.
2. The ledger layer — what makes GCL, GCL.
An append-only, content-addressed coordination ledger: event and handoff trail, work ownership via claims and leases, declared-vs-derived provenance, and tamper-evident integrity. This is the part OKF doesn't have. When something happened, who did it, and why — it's in the ledger, and absence is as visible as presence.
Workspace layout
Code
Specs
Doc
What it covers
spec/GCL-Protocol.md
The model, decision lens, invariants
spec/Schema.md
Universal frontmatter + file-type contract
spec/Ledger-and-CAS.md
HEAD, revision ledger, deterministic hashing
spec/OKF-Compatibility.md
Knowledge layer alignment with OKF
spec/A2A-Mapping.md
How A2A interactions record as GCL provenance
License
Apache 2.0 — permissive, with explicit patent grant. Safe to adopt and build on.
GCL — Guided Context Ledger. Open. Transport-independent. Community-owned.
Knowledge layer aligned with OKF (© Google Cloud). Ledger layer is GCL's own.