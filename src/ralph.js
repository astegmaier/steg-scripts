#!/usr/bin/env node
// @ts-check

/**
 * @import { IterationResult, StreamMessage } from './types.js'
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { program } = require('commander');

const ERROR_PATTERNS = [/Error: No messages returned/, /promise rejected with the reason/];

/**
 * Parse newline-delimited JSON from a stream buffer
 * @param {string} buffer - The current buffer content
 * @param {(json: StreamMessage) => void} callback - Called for each parsed JSON object
 * @returns {string} The remaining unparsed buffer content
 */
function parseStreamJson(buffer, callback) {
  const lines = buffer.split('\n');
  const remaining = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const json = /** @type {StreamMessage} */ (JSON.parse(line));
      callback(json);
    } catch {
      // Incomplete JSON, ignore
    }
  }

  return remaining;
}

/**
 * Format a stream message for display
 * @param {StreamMessage} json - The parsed stream message
 * @returns {string} Formatted output string
 */
function formatStreamMessage(json) {
  if (json.type === 'system' && json.subtype === 'init' && json.session_id) {
    return `[Session: ${json.session_id}]\n`;
  }

  if (json.type === 'assistant' && json.message?.content) {
    let output = '';
    for (const block of json.message.content) {
      if (block.type === 'text') {
        output += block.text;
      } else if (block.type === 'tool_use') {
        output += `\n[${block.name}] ${JSON.stringify(block.input).slice(0, 150)}...\n`;
      }
    }
    return output;
  }

  if (json.type === 'user' && json.message?.content) {
    for (const block of json.message.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
        return `[Result] ${truncated}\n`;
      }
    }
  }

  if (json.type === 'result') {
    const cost = json.total_cost_usd?.toFixed(4) ?? '0';
    return `\n[${json.subtype ?? 'done'}] Turns: ${json.num_turns ?? 0}, Cost: $${cost}\n`;
  }

  return '';
}

/**
 * Run a single iteration of the Claude CLI
 * @param {number} iteration - The iteration number
 * @param {string} promptFile - Path to the prompt file
 * @returns {Promise<IterationResult>} The result of the iteration
 */
async function runIteration(iteration, promptFile) {
  console.log(`\n=== Iteration ${iteration} ===\n`);

  return new Promise((resolve) => {
    let rawOutput = '';
    let errorDetected = false;
    let buffer = '';
    let lastAssistantText = '';

    const promptContent = fs.readFileSync(promptFile, 'utf-8');

    const claude = spawn(
      'claude',
      ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      }
    );

    claude.stdin.write(promptContent);
    claude.stdin.end();

    /**
     * @param {Buffer} data
     */
    const handleData = (data) => {
      const text = data.toString();
      rawOutput += text;

      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(rawOutput)) {
          errorDetected = true;
          console.log('');
          console.log('Claude error detected, killing process tree...');
          try {
            if (claude.pid !== undefined) {
              process.kill(-claude.pid, 'SIGTERM');
            }
          } catch {
            // Process may already be dead
          }
          return;
        }
      }

      buffer = parseStreamJson(buffer + text, (json) => {
        const formatted = formatStreamMessage(json);
        if (formatted) {
          process.stdout.write(formatted);
        }

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
    claude.stderr.on('data', (/** @type {Buffer} */ data) => {
      process.stderr.write(data.toString());
    });

    claude.on('close', () => {
      if (errorDetected) {
        resolve({ success: false, complete: false });
        return;
      }

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

/**
 * Main entry point
 * @param {number} maxIterations - Maximum number of iterations
 * @param {string} promptFile - Path to the prompt file
 */
async function main(maxIterations, promptFile) {
  console.log('Starting Ralph');
  console.log(`  Max iterations: ${maxIterations}`);
  console.log(`  Prompt file: ${promptFile}`);

  for (let i = 1; i <= maxIterations; i++) {
    const result = await runIteration(i, promptFile);

    if (result.complete) {
      console.log('Done!');
      process.exit(0);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('Max iterations reached');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const DEFAULT_PROMPT_FILE = path.join(SCRIPT_DIR, 'fix-new-duplicates-prompt.md');

program
  .name('ralph')
  .description('Run Claude CLI in a loop until a task is complete')
  .version('1.0.0')
  .option('-i, --iterations <number>', 'maximum number of iterations', '50')
  .option('-p, --prompt <file>', 'path to the prompt file', DEFAULT_PROMPT_FILE)
  .action((options) => {
    const maxIterations = parseInt(/** @type {string} */ (options.iterations), 10);
    const promptFile = /** @type {string} */ (options.prompt);

    if (isNaN(maxIterations) || maxIterations < 1) {
      console.error('Error: iterations must be a positive number');
      process.exit(1);
    }

    if (!fs.existsSync(promptFile)) {
      console.error(`Error: prompt file not found: ${promptFile}`);
      process.exit(1);
    }

    main(maxIterations, promptFile);
  });

program.parse();
