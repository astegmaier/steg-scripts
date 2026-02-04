#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_ITERATIONS = parseInt(process.argv[2], 10) || 50;
const SCRIPT_DIR = __dirname;
const PROMPT_FILE = path.join(SCRIPT_DIR, 'fix-new-duplicates-prompt.md');

const ERROR_PATTERNS = [/Error: No messages returned/, /promise rejected with the reason/];

console.log('🚀 Starting Ralph');

function parseStreamJson(buffer, callback) {
  const lines = buffer.split('\n');
  const remaining = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const json = JSON.parse(line);
      callback(json);
    } catch {
      // Incomplete JSON, ignore
    }
  }

  return remaining;
}

function formatStreamMessage(json) {
  if (json.type === 'system' && json.subtype === 'init') {
    return `[Session: ${json.session_id}]\n`;
  }

  if (json.type === 'assistant' && json.message?.content) {
    let output = '';
    for (const block of json.message.content) {
      if (block.type === 'text') {
        output += block.text;
      } else if (block.type === 'tool_use') {
        output += `\n🔧 [${block.name}] ${JSON.stringify(block.input).slice(0, 150)}...\n`;
      }
    }
    return output;
  }

  if (json.type === 'user' && json.message?.content) {
    for (const block of json.message.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
        return `📋 [Result] ${truncated}\n`;
      }
    }
  }

  if (json.type === 'result') {
    return `\n✅ [${json.subtype}] Turns: ${json.num_turns}, Cost: $${json.total_cost_usd?.toFixed(4) || '0'}\n`;
  }

  return '';
}

async function runIteration(iteration) {
  console.log(`\n═══ Iteration ${iteration} ═══\n`);

  return new Promise((resolve) => {
    let rawOutput = '';
    let errorDetected = false;
    let buffer = '';
    let lastAssistantText = ''; // Track only the final assistant message text

    const promptContent = fs.readFileSync(PROMPT_FILE, 'utf-8');

    const claude = spawn(
      'claude',
      ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      }
    );

    claude.stdin.write(promptContent);
    claude.stdin.end();

    const handleData = (data) => {
      const text = data.toString();
      rawOutput += text;

      // Check for error patterns
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(rawOutput)) {
          errorDetected = true;
          console.log('');
          console.log('⚠️ Claude error detected, killing process tree...');
          try {
            process.kill(-claude.pid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
          return;
        }
      }

      // Parse and display streaming output
      buffer = parseStreamJson(buffer + text, (json) => {
        const formatted = formatStreamMessage(json);
        if (formatted) {
          process.stdout.write(formatted);
        }

        // Track the last assistant message text content
        if (json.type === 'assistant' && json.message?.content) {
          lastAssistantText = '';
          for (const block of json.message.content) {
            if (block.type === 'text') {
              lastAssistantText += block.text;
            }
          }
        }
      });
    };

    claude.stdout.on('data', handleData);
    claude.stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });

    claude.on('close', () => {
      if (errorDetected) {
        resolve({ success: false, complete: false });
        return;
      }

      // Only check the FINAL assistant message for the completion marker
      // This prevents false positives from intermediate messages mentioning the marker
      if (lastAssistantText.trim() === '<promise>COMPLETE</promise>') {
        resolve({ success: true, complete: true });
      } else {
        resolve({ success: true, complete: false });
      }
    });

    claude.on('error', (err) => {
      console.error('Failed to start claude:', err.message);
      resolve({ success: false, complete: false });
    });
  });
}

async function main() {
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const result = await runIteration(i);

    if (result.complete) {
      console.log('✅ Done!');
      process.exit(0);
    }

    // Wait 2 seconds before next iteration
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('⚠️ Max iterations reached');
  process.exit(1);
}

main();
