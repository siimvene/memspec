#!/usr/bin/env node
// Memspec Consolidation Hook — PostToolUse on Bash (git commit/push)
//
// When the agent commits code, this hook checks if the project has a
// .memspec/ store and injects a consolidation prompt. The agent still
// has full conversation context at this point, so it can write meaningful
// memories about what it just committed and why.
//
// Triggers once per session to avoid nagging on every commit.
// Configurable via .memspec/config.yaml consolidation.trigger and .frequency.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.tmpdir(), 'memspec-hooks');
const CONSOLIDATION_PROMPT = `## Memspec Consolidation

You just committed code. Before continuing, review what you learned this session and update project memory:

1. **New knowledge**: Did you discover facts about the codebase, make decisions, or establish procedures? Write them with \`memspec add\`.
2. **Stale memories**: Did your work invalidate any existing memories? Correct them with \`memspec correct\`.
3. **Quick check**: Run \`memspec status\` to see current store health.

Be selective — only write memories that would help a future agent starting cold. Don't dump session transcripts.`;

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const sessionId = data.session_id;

    // Only trigger on git commit or git push
    const toolInput = data.tool_input || {};
    const command = toolInput.command || '';
    if (!command.match(/git\s+(commit|push)/)) {
      process.exit(0);
    }

    // Only trigger if project has .memspec/
    const memspecDir = path.join(cwd, '.memspec');
    if (!fs.existsSync(memspecDir)) {
      process.exit(0);
    }

    // Check config for consolidation settings
    let trigger = 'commit';
    let frequency = 'once';
    const configPath = path.join(memspecDir, 'config.yaml');
    if (fs.existsSync(configPath)) {
      const configText = fs.readFileSync(configPath, 'utf8');
      const triggerMatch = configText.match(/^\s*trigger:\s*(\w+)/m);
      const freqMatch = configText.match(/^\s*frequency:\s*(\w+)/m);
      if (triggerMatch) trigger = triggerMatch[1];
      if (freqMatch) frequency = freqMatch[1];
    }

    // Respect config
    if (trigger === 'none' || trigger === 'manual') {
      process.exit(0);
    }

    // Frequency check: "once" means once per session
    if (frequency === 'once' && sessionId) {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
      if (fs.existsSync(stateFile)) {
        // Already triggered this session
        process.exit(0);
      }
      // Mark as triggered
      fs.writeFileSync(stateFile, JSON.stringify({ triggered: new Date().toISOString() }));
    }

    // Inject consolidation prompt
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: CONSOLIDATION_PROMPT
      }
    };
    process.stdout.write(JSON.stringify(result));
    process.exit(0);

  } catch (e) {
    // Fail silently — never block the agent
    process.exit(0);
  }
});
